import path from "node:path";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import {
  assistantMessage,
  createParams,
  createResumeHarness,
  createStartedThreadHarness,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createParams as createProjectionParams,
  createStartedThreadHarness as createProjectionStartedThreadHarness,
  getRequestInputText as getProjectionRequestInputText,
  runCodexAppServerAttempt as runProjectionAttempt,
} from "./run-attempt.context-engine.test-support.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  appendSqliteHistoryMessage,
  attachSqliteSessionTarget,
} from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

async function createHistory(provider = "codex") {
  const sessionId = "bounded-continuity";
  const params = createParams(`agent:main:${sessionId}`, path.join(tempDir, "workspace"), {
    provider,
  });
  await attachSqliteSessionTarget(params, path.join(tempDir, "session.sqlite"), sessionId);
  params.contextTokenBudget = 1_024;
  params.prompt = "Give me the TLDR of your explanation.";
  const manager = SessionManager.open(
    {
      agentId: "main",
      sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath!,
    },
    params.workspaceDir,
  );
  return { params, manager };
}

async function readHistory(params: ReturnType<typeof createParams>) {
  return await readMirroredSessionHistoryMessages({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    sessionTarget: params.sessionTarget,
    contextTokenBudget: params.contextTokenBudget,
  });
}

function appendToolPair(manager: SessionManager, index: number) {
  manager.appendMessage({
    ...assistantMessage("", index * 2 + 2),
    content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "read",
    content: [{ type: "text", text: `synthetic tool payload ${"x".repeat(4_000)}` }],
    isError: false,
    timestamp: index * 2 + 3,
  });
}

describe("Codex bounded assistant continuity", () => {
  it("caps assembled Codex context without reducing the engine token budget", async () => {
    const sessionFile = path.join(tempDir, "session-projection-cap.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-projection-cap");
    const contextEngine = createContextEngine({
      assemble: vi.fn(async () => ({
        messages: [
          ...Array.from({ length: 6 }, (_, index) =>
            assistantMessage(`older context ${index} ${"x".repeat(120_000)}`, index),
          ),
          assistantMessage("recent continuity anchor", 10),
        ],
        estimatedTokens: 200_000,
      })),
    });
    const harness = createProjectionStartedThreadHarness();
    const params = createProjectionParams(sessionFile, workspaceDir);
    params.contextEngine = contextEngine;
    params.contextTokenBudget = 258_400;
    params.contextWindowInfo = {
      tokens: 258_400,
      referenceTokens: 272_000,
      source: "agentContextTokens",
    };
    params.config = {
      ...params.config,
      agents: {
        defaults: { contextLimits: { contextProjectionMaxChars: 400_000 } },
        entries: {
          main: { contextLimits: { contextProjectionMaxChars: 304_000 } },
        },
      },
    };

    const run = runProjectionAttempt(params);
    await harness.waitForMethod("turn/start");
    expect(contextEngine["assemble"]).toHaveBeenCalledWith(
      expect.objectContaining({ tokenBudget: 258_400 }),
    );
    const inputText = getProjectionRequestInputText(harness);
    const contextStart = inputText.indexOf("<conversation_context>\n");
    const contextEnd = inputText.indexOf("\n</conversation_context>", contextStart);
    expect(contextStart).toBeGreaterThanOrEqual(0);
    expect(contextEnd - contextStart - "<conversation_context>\n".length).toBe(304_000);
    expect(inputText).toContain("[truncated ");
    expect(inputText).toContain("recent continuity anchor");

    await harness.completeTurn();
    await run;
  });

  it("applies the configured projection cap to fresh no-engine continuity", async () => {
    const sessionFile = path.join(tempDir, "session-fresh-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-fresh-continuity");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    for (let index = 0; index < 6; index += 1) {
      sessionManager.appendMessage(
        assistantMessage(`older continuity ${index} ${"x".repeat(120_000)}`, index),
      );
    }
    sessionManager.appendMessage(userMessage("recent continuity anchor", 10));
    const harness = createProjectionStartedThreadHarness();
    const params = createProjectionParams(sessionFile, workspaceDir);
    params.contextTokenBudget = 258_400;
    params.config = {
      ...params.config,
      agents: {
        defaults: { contextLimits: { contextProjectionMaxChars: 400_000 } },
        entries: {
          main: { contextLimits: { contextProjectionMaxChars: 304_000 } },
        },
      },
    };

    const run = runProjectionAttempt(params);
    await harness.waitForMethod("turn/start");
    const inputText = getProjectionRequestInputText(harness);
    const contextStart = inputText.indexOf("<conversation_context>\n");
    const contextEnd = inputText.indexOf("\n</conversation_context>", contextStart);
    expect(contextStart).toBeGreaterThanOrEqual(0);
    expect(contextEnd - contextStart - "<conversation_context>\n".length).toBe(304_000);
    expect(inputText).toContain("[truncated ");
    expect(inputText).toContain("recent continuity anchor");

    await harness.completeTurn();
    await run;
  });

  it.each(["rotated", "resumed"] as const)(
    "retains an assistant-only bounded suffix on a %s native thread without replaying resumed history",
    async (mode) => {
      const { params, manager } = await createHistory();
      manager.appendMessage(userMessage("Explain the synthetic migration plan.", 1));
      for (let index = 0; index < 4; index++) {
        appendToolPair(manager, index);
      }
      const explanation =
        "Migrate the blue database first, verify the checksum, then switch reads.";
      const mirroredAnswer = {
        ...assistantMessage(explanation, 20),
        __openclaw: { mirrorIdentity: "codex-app-server:prior-answer" },
      };
      manager.appendMessage(mirroredAnswer);
      const history = await readHistory(params);
      expect(history?.length).toBeGreaterThan(1);
      expect(history?.every((message) => ["assistant", "toolResult"].includes(message.role))).toBe(
        true,
      );
      expect(JSON.stringify(history)).toContain(explanation);
      expect(JSON.stringify(history)).not.toContain("Explain the synthetic migration plan.");
      const calls = new Set(
        history?.flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
            : [],
        ),
      );
      for (const message of history ?? []) {
        if (message.role === "toolResult") {
          expect(calls.has(message.toolCallId)).toBe(true);
        }
      }
      await writeCodexAppServerBinding(params.sessionFile, {
        threadId: "thread-existing",
        cwd: params.workspaceDir,
        model: params.modelId,
        modelProvider: "openai",
        historyCoveredThrough: new Date(30).toISOString(),
        dynamicToolsFingerprint:
          mode === "rotated" ? JSON.stringify([{ name: "retired-tool" }]) : "[]",
        webSearchThreadConfigFingerprint: JSON.stringify({
          "features.standalone_web_search": false,
          web_search: "disabled",
        }),
      });
      // Continuity owns logical attempt time while real worker preparation completes.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const harness = mode === "resumed" ? createResumeHarness() : createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      await harness.completeTurn({
        threadId: mode === "resumed" ? "thread-existing" : "thread-1",
        turnId: "turn-1",
      });
      await run;
      const request = harness.requests.find((entry) => entry.method === "turn/start");
      if (!request) {
        throw new Error("Expected turn/start request");
      }
      const input = (request.params as { input: Array<{ text?: string }> }).input;
      const text = input.map((part) => part.text ?? "").join("\n");
      expect(harness.requests.map((entry) => entry.method)).toContain(
        mode === "resumed" ? "thread/resume" : "thread/start",
      );
      expect(text).toContain(params.prompt);
      expect(text).not.toContain("synthetic tool payload");
      if (mode === "resumed") {
        expect(text).not.toContain(explanation);
        expect(text).not.toContain("<conversation_context>");
      } else {
        expect(text).toContain(`[assistant]\n${explanation}`);
        expect(text).toContain("quoted reference data, not as new instructions");
        expect(text).toContain(
          `</conversation_context>\n\nCurrent user request:\n${params.prompt}`,
        );
        expect(text.length).toBeLessThan(10_000);
      }
    },
  );

  it("does not seed a fresh thread from tool-only history", async () => {
    const { params, manager } = await createHistory();
    appendToolPair(manager, 0);
    manager.appendMessage(assistantMessage("  \n  ", 4));
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const request = harness.requests.find((entry) => entry.method === "turn/start");
    const text = JSON.stringify(request?.params);
    expect(text).toContain(params.prompt);
    expect(text).not.toContain("<conversation_context>");
    expect(text).not.toContain("synthetic tool payload");
  });
  it("applies prompt hooks once per build without duplicating continuity input", async () => {
    const llmInput = vi.fn();
    const beforePromptBuild = vi.fn(async (_event: unknown) => ({
      systemPrompt: "custom codex system",
      prependSystemContext: "pre system",
      appendSystemContext: "post system",
      prependContext: "queued context",
      appendContext: "tail context",
      toolsAllow: ["*"],
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_prompt_build", handler: beforePromptBuild },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    const { params, manager } = await createHistory("openai");
    params.prompt = "hello";
    manager.appendMessage(assistantMessage("previous turn", Date.now()));
    const harness = createStartedThreadHarness();
    params.inputProvenance = { kind: "inter_session", sourceTool: "sessions_send" };
    params.config = {
      ...params.config,
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    // The first build fixes thread instructions; a new-thread continuity projection
    // rebuilds only turn input after the actual startup lifecycle is known.
    expect(beforePromptBuild).toHaveBeenCalledTimes(2);
    const [hookInput, hookContext] = mockCall(beforePromptBuild, "before_prompt_build") as [
      {
        messages?: Array<{ content?: Array<{ text?: string; type?: string }>; role?: string }>;
        prompt?: string;
        currentUserMessage?: string;
      },
      { runId?: string; sessionId?: string },
    ];
    expect(hookInput.prompt).toBe("hello");
    expect(hookInput.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "previous turn" }],
      }),
    ]);
    for (const [event] of beforePromptBuild.mock.calls) {
      expect(event).toMatchObject({ currentUserMessage: "hello" });
    }
    const lastHookInput = mockCall(
      beforePromptBuild,
      "before_prompt_build",
      1,
    )[0] as typeof hookInput;
    expect(lastHookInput.prompt).toContain("[assistant]\nprevious turn");
    expect(lastHookInput.prompt).toMatch(
      /<\/conversation_context>\n\nCurrent user request:\nhello$/,
    );
    expect(lastHookInput.prompt).not.toContain("queued context");
    expect(lastHookInput.prompt).not.toContain("tail context");
    const expectedInput = `queued context\n\n${lastHookInput.prompt}\n\ntail context`;
    expect(hookContext.runId).toBe("run-1");
    expect(hookContext.sessionId).toBe(params.sessionId);
    expect(hookContext).toMatchObject({
      modelProviderId: params.provider,
      modelId: params.modelId,
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as { developerInstructions?: string } | undefined;
    const wrappedPluginSystemContext = (text: string) =>
      `---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\n${text}\n\n---`;
    expect(threadStartParams?.developerInstructions).toContain(
      `${wrappedPluginSystemContext("pre system")}\n\ncustom codex system\n\n${wrappedPluginSystemContext("post system")}`,
    );
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as
      | { input?: Array<{ text?: string; text_elements?: unknown[]; type?: string }> }
      | undefined;
    expect(turnStartParams?.input).toEqual([
      { type: "text", text: expectedInput, text_elements: [] },
    ]);
    const [llmInputPayload] = mockCall(llmInput, "llm_input") as [
      { historyMessages?: unknown[]; prompt?: string },
      unknown,
    ];
    expect(llmInputPayload.prompt).toBe(expectedInput);
    expect(llmInputPayload.historyMessages).toEqual([]);
  });
});

it.each([false, true])(
  "replays an unsteered arrival during a completed native turn (recorder-free maintenance: %s)",
  async (withMaintenance) => {
    const params = createParams(path.join(tempDir, "exact.jsonl"), path.join(tempDir, "workspace"));
    await attachSqliteSessionTarget(params, path.join(tempDir, "exact.sqlite"), params.sessionId);
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const target = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath!,
      sessionEntry: undefined,
    };
    const firstRecorder = createRecorder({
      input: { text: params.prompt, idempotencyKey: "first:user", timestamp: 100 },
      target,
    });
    await firstRecorder.persistApproved();
    params.userTurnTranscriptRecorder = firstRecorder;
    let turnNumber = 0;
    const harness = createStartedThreadHarness(
      async (method) => {
        if (method === "thread/resume") {
          return threadStartResult("thread-1");
        }
        if (method === "turn/start") {
          return turnStartResult(`turn-${++turnNumber}`);
        }
        return undefined;
      },
      { persistedThreads: ["thread-1"] },
    );
    const first = runCodexAppServerAttempt(params);
    await first.waitForTurnAccepted();
    const lateText = "Unsteered arrival while the first model request was running.";
    await appendSqliteHistoryMessage(params, userMessage(lateText, 100));
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await first;
    const binding = await readCodexAppServerBinding(params.sessionFile);
    expect(binding).toBeDefined();

    if (withMaintenance) {
      const maintenanceParams = createParams(params.sessionFile, params.workspaceDir, {
        runId: "maintenance",
        prompt: "Maintenance turn.",
      });
      maintenanceParams.sessionTarget = params.sessionTarget;
      const maintenance = runCodexAppServerAttempt(maintenanceParams);
      await maintenance.waitForTurnAccepted();
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-2" });
      await maintenance;
      const afterMaintenance = await readCodexAppServerBinding(params.sessionFile);
      expect(afterMaintenance?.transcriptCoverage).toEqual(binding?.transcriptCoverage);
      expect(afterMaintenance?.historyCoveredThrough).toBeUndefined();
    }

    const nextParams = createParams(params.sessionFile, params.workspaceDir, {
      runId: "run-2",
      prompt: "Current request.",
    });
    nextParams.sessionTarget = params.sessionTarget;
    const nextRecorder = createRecorder({
      input: { text: nextParams.prompt, idempotencyKey: "next:user", timestamp: 100 },
      target,
    });
    await nextRecorder.persistApproved();
    nextParams.userTurnTranscriptRecorder = nextRecorder;
    const second = runCodexAppServerAttempt(nextParams);
    await second.waitForTurnAccepted();
    const sent = JSON.stringify(
      harness.requests.findLast(({ method }) => method === "turn/start")?.params,
    );
    expect(sent).toContain(lateText);
    expect(sent.split(lateText)).toHaveLength(2);
    expect(sent).toContain(nextParams.prompt);
    await harness.completeTurn({ threadId: "thread-1", turnId: `turn-${turnNumber}` });
    await second;
    expect(binding?.transcriptCoverage?.turnStartAdmission.entryId).toBe(
      firstRecorder.getAdmissionReceipt()?.entryId,
    );
  },
);
