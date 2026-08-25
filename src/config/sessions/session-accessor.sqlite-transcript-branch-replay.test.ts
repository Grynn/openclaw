import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  appendTranscriptEvent,
  loadTranscriptEventsSync,
  persistSessionTranscriptTurn,
  readSessionTranscriptResetEpochSnapshot,
  replayTranscriptResetEpochBranch,
  replaceSessionEntry,
  updateSessionEntry,
} from "./session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { SessionTranscriptWriterClaimReboundError } from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const NEW_TOOL_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ASSISTANT_ID = "22222222-2222-4222-8222-222222222222";

type ResetEpochReplayFixture = Awaited<ReturnType<typeof createResetEpochReplayFixture>>;

function replayEvents(forkParentId: string) {
  return [
    {
      type: "message",
      id: NEW_TOOL_ID,
      parentId: forkParentId,
      timestamp: "2026-08-25T00:00:06.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-current",
        toolName: "read",
        content: [{ type: "text", text: "replacement tool output" }],
        isError: false,
        idempotencyKey: "codex-app-server:current:tool:call-current:result",
        timestamp: 6,
      },
    },
    {
      type: "message",
      id: NEW_ASSISTANT_ID,
      parentId: NEW_TOOL_ID,
      timestamp: "2026-08-25T00:00:07.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "replacement assistant answer" }],
        timestamp: 7,
      },
    },
  ];
}

async function createResetEpochReplayFixture() {
  const stateDir = tempDirs.make("openclaw-reset-epoch-replay-");
  const scope = {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionId: "reset-epoch-replay",
    sessionKey: "agent:main:reset-epoch-replay",
  };
  await replaceSessionEntry(scope, {
    activeWriterRunId: "writer-current",
    lifecycleRevision: "lifecycle-current",
    sessionId: scope.sessionId,
    updatedAt: 1,
  } as InternalSessionEntry);
  await persistSessionTranscriptTurn(scope, {
    messages: [
      {
        eventId: "pre-reset-user",
        parentId: null,
        message: { role: "user", content: "searchable pre-reset question", timestamp: 1 },
      },
      {
        eventId: "pre-reset-assistant",
        parentId: "pre-reset-user",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "searchable pre-reset answer" }],
          timestamp: 2,
        },
      },
    ],
    touchSessionEntry: false,
  });
  await appendTranscriptEvent(scope, {
    type: "reset",
    id: "reset-boundary",
    parentId: "pre-reset-assistant",
    reason: "new",
    timestamp: "2026-08-25T00:00:03.000Z",
  });
  await persistSessionTranscriptTurn(scope, {
    messages: [
      {
        eventId: "post-reset-user",
        parentId: "reset-boundary",
        message: { role: "user", content: "searchable current question", timestamp: 4 },
      },
      {
        eventId: "old-tool",
        parentId: "post-reset-user",
        message: {
          role: "toolResult",
          toolCallId: "call-current",
          toolName: "read",
          content: [{ type: "text", text: "old tool output" }],
          isError: false,
          idempotencyKey: "codex-app-server:current:tool:call-current:result",
          timestamp: 5,
        },
      },
      {
        eventId: "old-assistant",
        parentId: "old-tool",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "searchable abandoned assistant" }],
          timestamp: 6,
        },
      },
    ],
    touchSessionEntry: false,
  });
  const snapshot = readSessionTranscriptResetEpochSnapshot(scope);
  const database = openOpenClawAgentDatabase(
    toDatabaseOptions(resolveSqliteTranscriptScope(scope)),
  );
  return { database, scope, snapshot };
}

function resetReplayParams(fixture: ResetEpochReplayFixture) {
  const resetBoundary = fixture.snapshot.resetBoundary;
  if (!resetBoundary) {
    throw new Error("expected reset boundary fixture");
  }
  return {
    expectedWatermark: fixture.snapshot.watermark,
    firstAbandonedChildId: "old-tool",
    forkParentId: "post-reset-user",
    replayEvents: replayEvents("post-reset-user"),
    resetBoundary,
  };
}

function readReplayDatabaseState(fixture: ResetEpochReplayFixture) {
  const { db } = fixture.database;
  const { sessionId } = fixture.scope;
  return {
    active: db
      .prepare(
        `SELECT active_position, event_seq, message_position
         FROM session_transcript_active_events
         WHERE session_id = ? ORDER BY active_position`,
      )
      .all(sessionId),
    events: db
      .prepare(
        `SELECT seq, event_json, created_at FROM transcript_events
         WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId),
    fts: db
      .prepare(
        `SELECT rowid, message_id, role, text, timestamp FROM session_transcript_fts
         WHERE session_id = ? ORDER BY rowid`,
      )
      .all(sessionId),
    generation: db
      .prepare(
        `SELECT generation, updated_at FROM transcript_rewrite_watermarks
         WHERE session_id = ?`,
      )
      .get(sessionId),
    identities: db
      .prepare(
        `SELECT event_id, seq, event_type, parent_id, message_idempotency_key, created_at
         FROM transcript_event_identities WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId),
    index: db
      .prepare(
        `SELECT indexed_seq, leaf_event_id, active_event_count, active_message_count,
                needs_rebuild
         FROM session_transcript_index_state WHERE session_id = ?`,
      )
      .get(sessionId),
    mutation: db
      .prepare(
        `SELECT transcript_updated_at, transcript_observed_at
         FROM session_windows WHERE session_id = ?`,
      )
      .get(sessionId),
  };
}

describe("SQLite reset-epoch transcript branch replay", () => {
  beforeEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("rejects empty, missing, pre-reset, and inactive fork parents", async () => {
    const fixture = await createResetEpochReplayFixture();
    const params = resetReplayParams(fixture);
    const physicalBefore = loadTranscriptEventsSync(fixture.scope).length;

    await expect(
      replayTranscriptResetEpochBranch(fixture.scope, {
        ...params,
        forkParentId: "",
        replayEvents: replayEvents(""),
      }),
    ).resolves.toEqual({ replayed: false, reason: "invalid-branch" });
    await expect(
      replayTranscriptResetEpochBranch(fixture.scope, {
        ...params,
        forkParentId: "missing-parent",
        replayEvents: replayEvents("missing-parent"),
      }),
    ).resolves.toEqual({ replayed: false, reason: "invalid-branch" });
    await expect(
      replayTranscriptResetEpochBranch(fixture.scope, {
        ...params,
        firstAbandonedChildId: "pre-reset-assistant",
        forkParentId: "pre-reset-user",
        replayEvents: replayEvents("pre-reset-user"),
      }),
    ).resolves.toEqual({ replayed: false, reason: "invalid-branch" });

    await expect(replayTranscriptResetEpochBranch(fixture.scope, params)).resolves.toEqual({
      replayed: true,
    });
    const currentSnapshot = readSessionTranscriptResetEpochSnapshot(fixture.scope);
    await expect(
      replayTranscriptResetEpochBranch(fixture.scope, {
        expectedWatermark: currentSnapshot.watermark,
        firstAbandonedChildId: "old-assistant",
        forkParentId: "old-tool",
        replayEvents: replayEvents("old-tool"),
        resetBoundary: params.resetBoundary,
      }),
    ).resolves.toEqual({ replayed: false, reason: "invalid-branch" });
    expect(loadTranscriptEventsSync(fixture.scope)).toHaveLength(physicalBefore + 2);
  });

  it("fences concurrent append, generation, session, lifecycle, and writer changes", async () => {
    const concurrent = await createResetEpochReplayFixture();
    const concurrentParams = resetReplayParams(concurrent);
    await persistSessionTranscriptTurn(concurrent.scope, {
      messages: [
        {
          eventId: "concurrent-append",
          parentId: "old-assistant",
          message: { role: "user", content: "concurrent ingress", timestamp: 8 },
        },
      ],
      touchSessionEntry: false,
    });
    await expect(
      replayTranscriptResetEpochBranch(concurrent.scope, concurrentParams),
    ).resolves.toEqual({ replayed: false, reason: "transcript-changed" });

    const generation = await createResetEpochReplayFixture();
    const generationParams = resetReplayParams(generation);
    generation.database.db
      .prepare("UPDATE transcript_rewrite_watermarks SET generation = ? WHERE session_id = ?")
      .run("generation-replaced", generation.scope.sessionId);
    await expect(
      replayTranscriptResetEpochBranch(generation.scope, generationParams),
    ).resolves.toEqual({ replayed: false, reason: "transcript-changed" });

    const owned = await createResetEpochReplayFixture();
    const ownedParams = resetReplayParams(owned);
    const ownedWatermark = owned.snapshot.watermark;
    const successor = await updateSessionEntry(
      owned.scope,
      (entry) => Object.assign({}, entry, { activeWriterRunId: "writer-successor" }),
      { skipMaintenance: true },
    );
    expect(successor as InternalSessionEntry).toMatchObject({
      activeWriterRunId: "writer-successor",
      lifecycleRevision: "lifecycle-current",
      sessionId: owned.scope.sessionId,
    });
    expect(readSessionTranscriptResetEpochSnapshot(owned.scope).watermark).toEqual(ownedWatermark);
    const ownedState = readReplayDatabaseState(owned);
    await expect(
      replayTranscriptResetEpochBranch(
        { ...owned.scope, sessionId: "session-rebound" },
        ownedParams,
      ),
    ).resolves.toEqual({ replayed: false, reason: "session-rebound" });
    await expect(
      replayTranscriptResetEpochBranch(
        { ...owned.scope, expectedLifecycleRevision: "lifecycle-stale" },
        ownedParams,
      ),
    ).resolves.toEqual({ replayed: false, reason: "session-rebound" });
    await expect(
      replayTranscriptResetEpochBranch(
        {
          ...owned.scope,
          expectedLifecycleRevision: "lifecycle-current",
          expectedWriterRunId: "writer-current",
        },
        ownedParams,
      ),
    ).rejects.toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
    expect(readReplayDatabaseState(owned)).toEqual(ownedState);
  });

  it("splices the active suffix, replaces its FTS anchors, and touches mutation once", async () => {
    const fixture = await createResetEpochReplayFixture();
    const params = resetReplayParams(fixture);
    fixture.database.db.exec(`
      CREATE TEMP TABLE mutation_touch_audit (touched INTEGER NOT NULL);
      CREATE TEMP TRIGGER audit_reset_epoch_mutation_touch
      AFTER UPDATE OF transcript_updated_at ON session_windows
      WHEN NEW.session_id = 'reset-epoch-replay'
        AND NEW.transcript_updated_at IS NOT OLD.transcript_updated_at
      BEGIN
        INSERT INTO mutation_touch_audit (touched) VALUES (1);
      END;
    `);

    await expect(
      replayTranscriptResetEpochBranch(
        {
          ...fixture.scope,
          expectedLifecycleRevision: "lifecycle-current",
          expectedWriterRunId: "writer-current",
        },
        params,
      ),
    ).resolves.toEqual({ replayed: true });

    const state = readReplayDatabaseState(fixture);
    expect(state.index).toMatchObject({
      active_event_count: 6,
      active_message_count: 5,
      indexed_seq: 8,
      leaf_event_id: NEW_ASSISTANT_ID,
      needs_rebuild: 0,
    });
    expect(
      fixture.database.db.prepare("SELECT COUNT(*) AS count FROM mutation_touch_audit").get(),
    ).toEqual({ count: 1 });
    const activeIds = fixture.database.db
      .prepare(
        `SELECT identity.event_id
         FROM session_transcript_active_events active
         JOIN transcript_event_identities identity
           ON identity.session_id = active.session_id AND identity.seq = active.event_seq
         WHERE active.session_id = ? ORDER BY active.active_position`,
      )
      .all(fixture.scope.sessionId)
      .map((row) => (row as { event_id: string }).event_id);
    expect(activeIds).toEqual([
      "pre-reset-user",
      "pre-reset-assistant",
      "reset-boundary",
      "post-reset-user",
      NEW_TOOL_ID,
      NEW_ASSISTANT_ID,
    ]);
    const ftsIds = (state.fts as Array<{ message_id: string }>).map((row) => row.message_id);
    expect(ftsIds).toContain("pre-reset-user");
    expect(ftsIds).toContain("pre-reset-assistant");
    expect(ftsIds).toContain("post-reset-user");
    expect(ftsIds).toContain(NEW_ASSISTANT_ID);
    expect(ftsIds).not.toContain("old-tool");
    expect(ftsIds).not.toContain("old-assistant");
    const keyOwner = fixture.database.db
      .prepare(
        `SELECT event_id FROM transcript_event_identities
         WHERE session_id = ? AND message_idempotency_key = ?`,
      )
      .get(fixture.scope.sessionId, "codex-app-server:current:tool:call-current:result");
    expect(keyOwner).toEqual({ event_id: NEW_TOOL_ID });
  });

  it("rolls back projection trim, FTS deletion, append, rekey, and mutation on a later fault", async () => {
    const fixture = await createResetEpochReplayFixture();
    const params = resetReplayParams(fixture);
    const before = readReplayDatabaseState(fixture);
    fixture.database.db.exec(`
      CREATE TEMP TRIGGER fail_second_reset_epoch_replay_append
      BEFORE INSERT ON transcript_events
      WHEN NEW.session_id = 'reset-epoch-replay' AND NEW.seq = 8
      BEGIN
        SELECT RAISE(ABORT, 'injected reset-epoch replay failure');
      END;
    `);

    await expect(replayTranscriptResetEpochBranch(fixture.scope, params)).rejects.toThrow(
      "injected reset-epoch replay failure",
    );
    expect(readReplayDatabaseState(fixture)).toEqual(before);
    expect(loadTranscriptEventsSync(fixture.scope)).toHaveLength(7);
  });

  it("rolls back replay and rekey when the final mutation touch fails", async () => {
    const fixture = await createResetEpochReplayFixture();
    const params = resetReplayParams(fixture);
    const before = readReplayDatabaseState(fixture);
    fixture.database.db.exec(`
      CREATE TEMP TRIGGER fail_reset_epoch_final_mutation_touch
      AFTER UPDATE OF transcript_updated_at ON session_windows
      WHEN NEW.session_id = 'reset-epoch-replay'
        AND NEW.transcript_updated_at IS NOT OLD.transcript_updated_at
      BEGIN
        SELECT RAISE(ABORT, 'injected final mutation touch failure');
      END;
    `);

    await expect(replayTranscriptResetEpochBranch(fixture.scope, params)).rejects.toThrow(
      "injected final mutation touch failure",
    );
    expect(readReplayDatabaseState(fixture)).toEqual(before);
    expect(loadTranscriptEventsSync(fixture.scope)).toHaveLength(7);
  });
});
