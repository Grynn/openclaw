import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  runExclusiveSqliteSessionWrite,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  readCodexSessionTranscriptEventsBeforeAdmission,
  readCodexSessionTranscriptMessagesBetweenAdmissions,
  refreshCodexSessionTranscriptAdmission,
  withCodexSessionTranscriptMirrorWriteLock,
} from "./codex-session-transcript-runtime.js";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
  readSessionTranscriptVisibleMessageDelta,
} from "./session-transcript-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("private session transcript mirror runtime", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-sdk-transcript-mirror-");
    storePath = path.join(tempDir, "sessions.json");
  });

  it("rechecks idempotency and publishes only committed visible sequences", async () => {
    const scope = {
      agentId: "main",
      sessionId: "indexed-mirror-session",
      sessionKey: "agent:main:indexed-mirror",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });

    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toEqual({
        anchorsByIdempotencyKey: new Map(),
        existingIdempotencyKeys: new Set(),
        messagesByIdempotencyKey: new Map(),
      });
      const first = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: {
          role: "user",
          content: [{ type: "text", text: "persist once" }],
          idempotencyKey: "mirror-user",
          timestamp: 1,
        },
      });
      expect(first).toMatchObject({
        messageSeq: 1,
        result: { appended: true, message: { role: "user" } },
      });
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toMatchObject({
        existingIdempotencyKeys: new Set(["mirror-user"]),
        messagesByIdempotencyKey: new Map([
          ["mirror-user", expect.objectContaining({ role: "user" })],
        ]),
      });
      const replay = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: {
          role: "user",
          content: [{ type: "text", text: "persist once" }],
          idempotencyKey: "mirror-user",
          timestamp: 2,
        },
      });
      expect(replay).toMatchObject({
        result: {
          appended: false,
          message: { content: [{ text: "persist once", type: "text" }], role: "user" },
        },
      });
      expect(replay.messageSeq).toBeUndefined();

      if (!first.result) {
        throw new Error("expected initial mirror append");
      }
      await locked.appendMessage({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "abandoned branch" }],
          idempotencyKey: "mirror-abandoned",
          timestamp: 3,
        },
        parentId: first.result.messageId,
      });
      const activeBranch = await locked.appendMessageWithMessageSequence({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "final active branch" }],
          idempotencyKey: "mirror-active",
          timestamp: 4,
        },
        parentId: first.result.messageId,
      });
      expect(activeBranch).toMatchObject({
        result: { appended: true, message: { role: "assistant" } },
      });
      expect(activeBranch.messageSeq).toBeUndefined();
    });

    const resolvedScope = resolveSqliteTranscriptScope(scope);
    await expect(
      readSessionTranscriptVisibleMessageDelta({ ...scope, maxMessages: 10 }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "projection_rebuilding",
    });
    await waitForSessionTranscriptProjection(scope);
    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      const afterReconcile = await locked.appendMessageWithMessageSequence({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "after active branch" }],
          idempotencyKey: "mirror-after-reconcile",
          timestamp: 5,
        },
      });
      expect(afterReconcile).toMatchObject({
        messageSeq: 3,
        result: { appended: true, message: { role: "assistant" } },
      });
    });
    await waitForSessionTranscriptProjection(scope);

    await runExclusiveSqliteSessionWrite(resolvedScope, async () => {
      runOpenClawAgentWriteTransaction((database) => {
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
      }, toDatabaseOptions(resolvedScope));
    });

    await withCodexSessionTranscriptMirrorWriteLock(scope, async (locked) => {
      expect(await locked.readMessageFacts({ idempotencyKeys: ["mirror-user"] })).toMatchObject({
        existingIdempotencyKeys: new Set(["mirror-user"]),
        messagesByIdempotencyKey: new Map([
          ["mirror-user", expect.objectContaining({ role: "user" })],
        ]),
      });
      const dirtyProjection = await locked.appendMessageWithMessageSequence({
        idempotencyLookup: "scan",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "projection fallback" }],
          idempotencyKey: "mirror-dirty",
          timestamp: 6,
        },
      });
      expect(dirtyProjection).toMatchObject({
        result: { appended: true, message: { role: "assistant" } },
      });
      expect(dirtyProjection.messageSeq).toBeUndefined();
    });
  });

  it("rejects an admission receipt for a different transcript target", async () => {
    const admittedScope = {
      agentId: "main",
      sessionId: "admitted-session",
      sessionKey: "agent:main:admitted-session",
      storePath,
    };
    const requestedScope = {
      ...admittedScope,
      sessionId: "requested-session",
      sessionKey: "agent:main:requested-session",
    };
    await upsertSessionEntryCore(admittedScope, {
      sessionId: admittedScope.sessionId,
      updatedAt: 1,
    });
    await upsertSessionEntryCore(requestedScope, {
      sessionId: requestedScope.sessionId,
      updatedAt: 1,
    });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...admittedScope,
      message: { role: "user", content: "admitted elsewhere" },
    });
    if (!admitted?.anchor) {
      throw new Error("expected admitted transcript anchor");
    }

    await expect(
      readCodexSessionTranscriptEventsBeforeAdmission(requestedScope, {
        ...admitted.anchor,
        logicalTurnId: "admitted-turn",
        role: "user",
      }),
    ).rejects.toBeInstanceOf(SessionTranscriptReadFenceError);
  });

  it("refreshes exact admission coverage across a benign transcript rewrite", async () => {
    const scope = {
      agentId: "main",
      sessionId: "rewritten-admission-session",
      sessionKey: "agent:main:rewritten-admission-session",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const covered = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "covered request" },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "visible between admissions" },
    });
    const current = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "current request" },
    });
    if (!covered?.anchor || !current?.anchor) {
      throw new Error("expected transcript admission anchors");
    }
    const coveredAdmission = {
      ...covered.anchor,
      logicalTurnId: "covered-turn",
      role: "user" as const,
    };
    const currentAdmission = {
      ...current.anchor,
      logicalTurnId: "current-turn",
      role: "user" as const,
    };
    expect(
      readCodexSessionTranscriptMessagesBetweenAdmissions(coveredAdmission, currentAdmission),
    ).toMatchObject({
      kind: "ok",
      messages: [{ role: "assistant", content: "visible between admissions" }],
    });

    await replaceTranscriptEvents(scope, await readSessionTranscriptEvents(scope));
    const refreshedCovered = refreshCodexSessionTranscriptAdmission(coveredAdmission);
    const refreshedCurrent = refreshCodexSessionTranscriptAdmission(currentAdmission);
    expect(refreshedCovered?.generation).not.toBe(coveredAdmission.generation);
    expect(refreshedCurrent?.generation).toBe(refreshedCovered?.generation);
    if (!refreshedCovered || !refreshedCurrent) {
      throw new Error("expected refreshed transcript admissions");
    }
    expect(
      readCodexSessionTranscriptMessagesBetweenAdmissions(coveredAdmission, refreshedCurrent),
    ).toEqual({ kind: "stale" });
    expect(
      readCodexSessionTranscriptMessagesBetweenAdmissions(refreshedCovered, refreshedCurrent),
    ).toMatchObject({
      kind: "ok",
      messages: [{ role: "assistant", content: "visible between admissions" }],
    });
  });

  it("returns an empty exact delta when a fallback reuses the same admission", async () => {
    const scope = {
      agentId: "main",
      sessionId: "same-admission-fallback-session",
      sessionKey: "agent:main:same-admission-fallback-session",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const admitted = await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "user", content: "classify and retry this request" },
    });
    if (!admitted?.anchor) {
      throw new Error("expected transcript admission anchor");
    }
    const admission = {
      ...admitted.anchor,
      logicalTurnId: "shared-fallback-turn",
      role: "user" as const,
    };

    expect(readCodexSessionTranscriptMessagesBetweenAdmissions(admission, admission)).toEqual({
      kind: "ok",
      messages: [],
    });
    expect(
      readCodexSessionTranscriptMessagesBetweenAdmissions(admission, {
        ...admission,
        entryId: "different-entry-at-the-same-position",
      }),
    ).toEqual({ kind: "stale" });
  });
});
