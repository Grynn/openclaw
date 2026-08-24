// Transcript rewrite tests cover in-memory and persisted branch rewrites for
// tool-result externalization, labels, and compaction markers.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  loadTranscriptEventsSync,
  replayTranscriptBranch,
  replaceSessionEntry,
  withTranscriptWriteLock,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../../config/sessions/types.js";

let rewriteTranscriptEntriesInSessionManager: typeof import("./transcript-rewrite.js").rewriteTranscriptEntriesInSessionManager;
let installSessionToolResultGuard: typeof import("../session-tool-result-guard.js").installSessionToolResultGuard;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

function asAppendMessage(message: unknown): AppendMessage {
  return message as AppendMessage;
}

function getBranchMessages(sessionManager: SessionManager): AgentMessage[] {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

function appendSessionMessages(
  sessionManager: SessionManager,
  messages: AppendMessage[],
): string[] {
  return messages.map((message) => sessionManager.appendMessage(message));
}

function createTextContent(text: string) {
  return [{ type: "text", text }];
}

function createReadRewriteSession(options?: { tailAssistantText?: string }) {
  // Read rewrite fixtures include a suffix assistant turn so branch rewrites
  // must re-append downstream entries after replacing the tool result.
  const sessionManager = SessionManager.inMemory();
  const entryIds = appendSessionMessages(sessionManager, [
    asAppendMessage({
      role: "user",
      content: "read file",
      timestamp: 1,
    }),
    asAppendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      timestamp: 2,
    }),
    asAppendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: createTextContent("x".repeat(8_000)),
      isError: false,
      timestamp: 3,
    }),
    asAppendMessage({
      role: "assistant",
      content: createTextContent(options?.tailAssistantText ?? "summarized"),
      timestamp: 4,
    }),
  ]);
  return {
    sessionManager,
    toolResultEntryId: entryIds[2],
    tailAssistantEntryId: entryIds[3],
  };
}

function createExecRewriteSession() {
  const sessionManager = SessionManager.inMemory();
  const entryIds = appendSessionMessages(sessionManager, [
    asAppendMessage({
      role: "user",
      content: "run tool",
      timestamp: 1,
    }),
    asAppendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "exec",
      content: createTextContent("before rewrite"),
      isError: false,
      timestamp: 2,
    }),
    asAppendMessage({
      role: "assistant",
      content: createTextContent("summarized"),
      timestamp: 3,
    }),
  ]);
  return {
    sessionManager,
    toolResultEntryId: entryIds[1],
  };
}

function createToolResultReplacement(toolName: string, text: string, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName,
    content: createTextContent(text),
    isError: false,
    timestamp,
  } as AgentMessage;
}

function findAssistantEntryByText(sessionManager: SessionManager, text: string) {
  return sessionManager
    .getBranch()
    .find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some((part) => part.type === "text" && part.text === text),
    );
}

function requireValue<T>(value: T | undefined, label: string): T {
  // Fail with a labeled invariant instead of letting optional entries produce
  // weak assertions later in transcript-branch tests.
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

async function createPersistedKeyedRewriteSession() {
  const dir = tempDirs.make("openclaw-transcript-rewrite-runtime-");
  const storePath = path.join(dir, "sessions.json");
  const sessionId = "runtime-sqlite-branch-rewrite";
  const sessionKey = "agent:main:test";
  const sessionFile = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId,
    storePath,
  });
  const target = { agentId: "main", sessionId, sessionKey, storePath };
  await replaceSessionEntry({ sessionKey, storePath }, {
    sessionFile,
    sessionId,
    updatedAt: 10,
  } as SessionEntry);
  const sessionManager = SessionManager.open(target, dir);
  const originalToolResult = {
    ...createToolResultReplacement("exec", "before rewrite", 2),
    idempotencyKey: "codex-app-server:test-turn:tool:exec:result",
  } as AgentMessage;
  const rewrittenToolResult = {
    ...createToolResultReplacement("exec", "[runtime rewrite]", 2),
    idempotencyKey: originalToolResult.idempotencyKey,
  } as AgentMessage;
  const [, toolResultEntryId] = appendSessionMessages(sessionManager, [
    asAppendMessage({ role: "user", content: "run tool", timestamp: 1 }),
    asAppendMessage(originalToolResult),
    asAppendMessage({
      role: "assistant",
      content: createTextContent("summarized"),
      timestamp: 3,
    }),
  ]);
  return {
    dir,
    originalToolResult,
    rewrittenToolResult,
    sessionManager,
    target,
    toolResultEntryId: expectDefined(toolResultEntryId, "persisted tool result entry id"),
  };
}

beforeAll(async () => {
  ({ installSessionToolResultGuard } = await import("../session-tool-result-guard.js"));
  ({ rewriteTranscriptEntriesInSessionManager } = await import("./transcript-rewrite.js"));
});

describe("rewriteTranscriptEntriesInSessionManager", () => {
  it("branches from the first replaced message and re-appends the remaining suffix", async () => {
    const { sessionManager, toolResultEntryId } = createReadRewriteSession();

    const result = expectDefined(
      await rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: expectDefined(toolResultEntryId, "toolResultEntryId test invariant"),
            message: createToolResultReplacement("read", "[externalized file_123]", 3),
          },
        ],
      }),
      "rewriteTranscriptEntriesInSessionManager({ sessionManager, replacemen... test invariant",
    );

    expect(result.changed).toBe(true);
    expect(result.rewrittenEntries).toBe(1);
    expect(result.bytesFreed).toBeGreaterThan(0);

    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const rewrittenToolResult = branchMessages[2] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(rewrittenToolResult.content).toEqual([
      { type: "text", text: "[externalized file_123]" },
    ]);
  });

  it("preserves active-branch labels after rewritten entries are re-appended", async () => {
    const { sessionManager, toolResultEntryId } = createReadRewriteSession();
    const summaryEntry = requireValue(
      findAssistantEntryByText(sessionManager, "summarized"),
      "summary entry",
    );
    sessionManager.appendLabelChange(summaryEntry.id, "bookmark");

    const result = expectDefined(
      await rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: expectDefined(toolResultEntryId, "toolResultEntryId test invariant"),
            message: createToolResultReplacement("read", "[externalized file_123]", 3),
          },
        ],
      }),
      "rewriteTranscriptEntriesInSessionManager({ sessionManager, replacemen... test invariant",
    );

    expect(result.changed).toBe(true);
    const rewrittenSummaryEntry = requireValue(
      findAssistantEntryByText(sessionManager, "summarized"),
      "rewritten summary entry",
    );
    expect(sessionManager.getLabel(rewrittenSummaryEntry.id)).toBe("bookmark");
    expect(sessionManager.getBranch().map((entry) => entry.type)).toContain("label");
  });

  it("remaps compaction keep markers when rewritten entries change ids", async () => {
    // Re-appending entries changes ids; compaction records must follow the new
    // first-kept entry or future branch reconstruction points at stale ids.
    const {
      sessionManager,
      toolResultEntryId,
      tailAssistantEntryId: keptAssistantEntryId,
    } = createReadRewriteSession({ tailAssistantText: "keep me" });
    sessionManager.appendCompaction(
      "summary",
      expectDefined(keptAssistantEntryId, "keptAssistantEntryId test invariant"),
      123,
    );

    const result = expectDefined(
      await rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: expectDefined(toolResultEntryId, "toolResultEntryId test invariant"),
            message: createToolResultReplacement("read", "[externalized file_123]", 3),
          },
        ],
      }),
      "rewriteTranscriptEntriesInSessionManager({ sessionManager, replacemen... test invariant",
    );

    expect(result.changed).toBe(true);
    const branch = sessionManager.getBranch();
    const keptAssistantEntry = branch.find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some((part) => part.type === "text" && part.text === "keep me"),
    );
    const compactionEntry = branch.find((entry) => entry.type === "compaction");

    const keptAssistant = requireValue(keptAssistantEntry, "kept assistant entry");
    const compaction = requireValue(compactionEntry, "compaction entry");
    if (compaction.type !== "compaction") {
      throw new Error("expected compaction entry");
    }
    expect(compaction.firstKeptEntryId).toBe(keptAssistant.id);
    expect(compaction.firstKeptEntryId).not.toBe(keptAssistantEntryId);
  });

  it("bypasses persistence hooks when replaying rewritten messages", async () => {
    const { sessionManager, toolResultEntryId } = createExecRewriteSession();
    installSessionToolResultGuard(sessionManager, {
      transformToolResultForPersistence: (message) => ({
        ...(message as Extract<AgentMessage, { role: "toolResult" }>),
        content: [{ type: "text", text: "[hook transformed]" }],
      }),
      beforeMessageWriteHook: ({ message }) =>
        message.role === "assistant" ? { block: true } : undefined,
    });

    const result = expectDefined(
      await rewriteTranscriptEntriesInSessionManager({
        sessionManager,
        replacements: [
          {
            entryId: expectDefined(toolResultEntryId, "toolResultEntryId test invariant"),
            message: createToolResultReplacement("exec", "[exact replacement]", 2),
          },
        ],
      }),
      "rewriteTranscriptEntriesInSessionManager({ sessionManager, replacemen... test invariant",
    );

    expect(result.changed).toBe(true);
    const branchMessages = getBranchMessages(sessionManager);
    expect(branchMessages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "assistant",
    ]);
    expect((branchMessages[1] as Extract<AgentMessage, { role: "toolResult" }>).content).toEqual([
      { type: "text", text: "[exact replacement]" },
    ]);
    const replayedAssistant = branchMessages[2];
    if (!replayedAssistant || replayedAssistant.role !== "assistant") {
      throw new Error("expected rewritten suffix to replay the assistant summary");
    }
    expect(replayedAssistant.content).toEqual([{ type: "text", text: "summarized" }]);
  });

  it("preserves original SQLite rows on the abandoned branch", async () => {
    const {
      dir,
      originalToolResult,
      rewrittenToolResult,
      sessionManager,
      target,
      toolResultEntryId,
    } = await createPersistedKeyedRewriteSession();

    const result = await rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [
        {
          entryId: toolResultEntryId,
          message: rewrittenToolResult,
        },
      ],
    });

    expect(result.changed).toBe(true);
    const storedEvents = await loadTranscriptEvents(target);
    const original = storedEvents.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        entry.id === toolResultEntryId,
    ) as { message?: AgentMessage } | undefined;
    expect(original?.message).toEqual(originalToolResult);

    const activeMessages = getBranchMessages(SessionManager.open(target, dir));
    expect(activeMessages.map((message) => message.role)).toEqual([
      "user",
      "toolResult",
      "assistant",
    ]);
    expect((activeMessages[1] as Extract<AgentMessage, { role: "toolResult" }>).content).toEqual([
      { type: "text", text: "[runtime rewrite]" },
    ]);
  });

  it("keeps the active keyed replacement canonical after projection reconciliation", async () => {
    const { rewrittenToolResult, sessionManager, target, toolResultEntryId } =
      await createPersistedKeyedRewriteSession();
    await rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [{ entryId: toolResultEntryId, message: rewrittenToolResult }],
    });
    const replacementEntry = expectDefined(
      sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.idempotencyKey === rewrittenToolResult.idempotencyKey,
        ),
      "active keyed replacement",
    );

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    const facts = await withTranscriptWriteLock(
      target,
      async (transcript) =>
        await transcript.readMessageFacts({
          idempotencyKeys: [rewrittenToolResult.idempotencyKey!],
        }),
    );

    expect(facts.messagesByIdempotencyKey.get(rewrittenToolResult.idempotencyKey!)).toEqual(
      rewrittenToolResult,
    );
    expect(facts.anchorsByIdempotencyKey.get(rewrittenToolResult.idempotencyKey!)).toMatchObject({
      entryId: replacementEntry.id,
    });
  });

  it("resolves an exact keyed retry to the active replacement without appending", async () => {
    const { rewrittenToolResult, sessionManager, target, toolResultEntryId } =
      await createPersistedKeyedRewriteSession();
    await rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [{ entryId: toolResultEntryId, message: rewrittenToolResult }],
    });
    const replacementEntry = expectDefined(
      sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.idempotencyKey === rewrittenToolResult.idempotencyKey,
        ),
      "active keyed replacement",
    );
    const eventCountBeforeRetry = loadTranscriptEventsSync(target).length;

    const retry = expectDefined(
      await appendTranscriptMessage(target, { message: rewrittenToolResult }),
      "keyed retry result",
    );

    expect(retry).toMatchObject({
      appended: false,
      messageId: replacementEntry.id,
      anchor: { entryId: replacementEntry.id },
    });
    expect(loadTranscriptEventsSync(target)).toHaveLength(eventCountBeforeRetry);
  });

  it("rejects a stale replay plan without abandoning concurrent ingress", async () => {
    const { dir, rewrittenToolResult, sessionManager, target, toolResultEntryId } =
      await createPersistedKeyedRewriteSession();
    const resolved = resolveSqliteTranscriptScope(target);
    let enterQueue!: () => void;
    let releaseQueue!: () => void;
    const queueEntered = new Promise<void>((resolve) => {
      enterQueue = resolve;
    });
    const queueRelease = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const heldWriter = runExclusiveSqliteSessionWrite(resolved, async () => {
      enterQueue();
      await queueRelease;
    });
    await queueEntered;

    const rewrite = rewriteTranscriptEntriesInSessionManager({
      sessionManager,
      replacements: [{ entryId: toolResultEntryId, message: rewrittenToolResult }],
    });
    const futureManager = SessionManager.open(target, dir);
    const futureId = futureManager.appendMessage(
      asAppendMessage({
        role: "user",
        content: "future ingress",
        idempotencyKey: "future-ingress:user",
        timestamp: 4,
      }),
    );
    releaseQueue();
    await heldWriter;

    await expect(rewrite).resolves.toMatchObject({
      changed: false,
      reason: "transcript changed before rewrite",
    });
    expect(
      SessionManager.open(target, dir)
        .getBranch()
        .map((entry) => entry.id),
    ).toContain(futureId);
  });

  it("rolls back the entire suffix when a later replay append fails", async () => {
    const { dir, sessionManager, target } = await createPersistedKeyedRewriteSession();
    const expectedEvents = loadTranscriptEventsSync(target);
    const originalLeafId = sessionManager.getLeafId();
    const duplicateReplayEvent = {
      type: "message",
      id: "injected-replay-failure",
      parentId: originalLeafId,
      timestamp: new Date(5).toISOString(),
      message: {
        role: "assistant",
        content: createTextContent("first replay row"),
        timestamp: 5,
      },
    };

    await expect(
      replayTranscriptBranch(target, {
        expectedEvents,
        replayEvents: [
          duplicateReplayEvent,
          {
            ...duplicateReplayEvent,
            parentId: duplicateReplayEvent.id,
            message: {
              ...duplicateReplayEvent.message,
              content: createTextContent("injected failure"),
            },
          },
        ],
      }),
    ).rejects.toThrow("Transcript branch replay event was not appended");
    expect(loadTranscriptEventsSync(target)).toEqual(expectedEvents);
    expect(SessionManager.open(target, dir).getLeafId()).toBe(originalLeafId);
  });
});
