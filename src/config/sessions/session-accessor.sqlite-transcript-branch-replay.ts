import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import {
  readNextTranscriptSeq,
  readTranscriptGenerationInTransaction,
  touchTranscriptMutationInTransaction,
} from "./session-accessor.sqlite-transcript-state.js";
import {
  appendTranscriptEventInTransaction,
  readTranscriptEventIdentity,
  readTranscriptIdentityByEventId,
  redactTranscriptMessageForStorage,
} from "./session-accessor.sqlite-transcript-store.js";
import {
  reconcileSessionTranscriptIndexInTransaction,
  rewindSessionTranscriptIndexForBranchSpliceInTransaction,
  sessionTranscriptIndexNeedsReconcile,
  type SessionTranscriptResetBoundaryAnchor,
} from "./session-transcript-index.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

export type TranscriptBranchReplayResult =
  | { replayed: true }
  | { reason: "session-rebound" | "transcript-changed"; replayed: false };

export type TranscriptResetEpochBranchReplayResult =
  | { replayed: true }
  | {
      reason: "invalid-branch" | "session-rebound" | "transcript-changed";
      replayed: false;
    };

function transcriptMatchesExpectedEvents(
  rows: ReturnType<typeof readTranscriptEventRows>,
  expectedEvents: readonly TranscriptEvent[],
): boolean {
  return (
    rows.length === expectedEvents.length &&
    rows.every((row, index) => row.eventJson === JSON.stringify(expectedEvents[index]))
  );
}

function transcriptMatchesExpectedWatermark(
  database: Parameters<typeof readNextTranscriptSeq>[0],
  sessionId: string,
  expected: { generation: string | null; maxSeq: number },
): boolean {
  return (
    (readTranscriptGenerationInTransaction(database, sessionId) ?? null) === expected.generation &&
    readNextTranscriptSeq(database, sessionId) - 1 === expected.maxSeq
  );
}

const REPLAY_ID_REFERENCE_FIELDS = [
  "appendParentId",
  "firstKeptEntryId",
  "fromId",
  "parentId",
  "targetId",
] as const;
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type IdentifiedReplayEvent = Record<string, unknown> & { id: string };

function readIdentifiedReplayEvent(event: unknown): IdentifiedReplayEvent {
  if (!isRecord(event) || typeof event.id !== "string" || !event.id.trim()) {
    throw new Error("Transcript reset-epoch replay contains an event without an identity");
  }
  return { ...event, id: event.id };
}

function allocateResetEpochReplayEventIds(
  database: Parameters<typeof readNextTranscriptSeq>[0],
  sessionId: string,
  events: readonly TranscriptEvent[],
): TranscriptEvent[] {
  const records = events.map(readIdentifiedReplayEvent);
  const sourceIds = new Set<string>();
  for (const event of records) {
    if (sourceIds.has(event.id)) {
      throw new Error(`Transcript reset-epoch replay contains a duplicate identity: ${event.id}`);
    }
    sourceIds.add(event.id);
  }
  const ids = new Map<string, string>();
  const allocated = new Set<string>();
  for (const event of records) {
    let id = event.id;
    if (
      !FULL_UUID_RE.test(id) ||
      allocated.has(id) ||
      readTranscriptIdentityByEventId(database, sessionId, id)
    ) {
      id = "";
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = randomUUID();
        if (
          !sourceIds.has(candidate) &&
          !allocated.has(candidate) &&
          !readTranscriptIdentityByEventId(database, sessionId, candidate)
        ) {
          id = candidate;
          break;
        }
      }
    }
    if (!id) {
      throw new Error("Unable to allocate a unique transcript reset-epoch replay identity");
    }
    ids.set(event.id, id);
    allocated.add(id);
  }
  return records.map((event) => {
    const remapped: Record<string, unknown> = Object.assign({}, event, {
      id: ids.get(event.id),
    });
    for (const field of REPLAY_ID_REFERENCE_FIELDS) {
      const reference = event[field];
      if (typeof reference === "string" && ids.has(reference)) {
        remapped[field] = ids.get(reference);
      }
    }
    return remapped;
  });
}

function redactTranscriptBranchReplayMessage(event: TranscriptEvent): TranscriptEvent {
  if (!isRecord(event) || event.type !== "message" || !Object.hasOwn(event, "message")) {
    return event;
  }
  return {
    ...event,
    message: redactTranscriptMessageForStorage(event.message, {}),
  };
}

/** Appends one planned active-branch suffix and moves keyed identity ownership to it. */
function appendTranscriptBranchReplayInTransaction(
  database: Parameters<typeof readNextTranscriptSeq>[0],
  scope: ResolvedTranscriptScope,
  events: readonly TranscriptEvent[],
  options: { projectionMode?: "forward-only" } = {},
): void {
  if (events.length === 0) {
    return;
  }
  const replayKeyOwners = new Map<string, string>();
  for (const rawEvent of events) {
    const event = redactTranscriptBranchReplayMessage(rawEvent);
    const identity = readTranscriptEventIdentity(event);
    let projectionNeedsRebuild = false;
    if (
      !appendTranscriptEventInTransaction(database, scope, event, {
        dedupeByMessageIdempotency: false,
        onProjectionReconcileNeeded: () => {
          projectionNeedsRebuild = true;
        },
        scheduleProjectionReconcile: false,
        touchMutation: false,
      })
    ) {
      throw new Error(
        `Transcript branch replay event was not appended: ${identity?.eventId ?? "unknown"}`,
      );
    }
    if (options.projectionMode === "forward-only" && projectionNeedsRebuild) {
      throw new Error("Transcript reset-epoch replay could not update its projection forward");
    }
    if (identity?.messageIdempotencyKey) {
      replayKeyOwners.set(identity.messageIdempotencyKey, identity.eventId);
    }
  }

  const db = getSessionKysely(database.db);
  for (const [idempotencyKey, eventId] of replayKeyOwners) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("transcript_event_identities")
        .set({ message_idempotency_key: null })
        .where("session_id", "=", scope.sessionId)
        .where("message_idempotency_key", "=", idempotencyKey)
        .where("event_id", "!=", eventId),
    );
    const assigned = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("transcript_event_identities")
        .set({ message_idempotency_key: idempotencyKey })
        .where("session_id", "=", scope.sessionId)
        .where("event_id", "=", eventId),
    );
    if (assigned.numAffectedRows !== 1n) {
      throw new Error(`Transcript branch replay identity was not assigned: ${eventId}`);
    }
  }

  if (options.projectionMode !== "forward-only") {
    touchTranscriptMutationInTransaction(database, scope.sessionId);
    reconcileSessionTranscriptIndexInTransaction(database.db, scope.sessionId);
  }
}

/** Commits one preplanned branch suffix under the session queue and one SQLite transaction. */
export async function replayTranscriptBranch(
  scope: SessionTranscriptWriteScope,
  params: { expectedEvents: readonly TranscriptEvent[]; replayEvents: readonly TranscriptEvent[] },
): Promise<TranscriptBranchReplayResult> {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: TranscriptBranchReplayResult = { replayed: false, reason: "session-rebound" };
    runOpenClawAgentWriteTransaction(
      (database) => {
        const fresh = readSessionEntryRow(database, resolved.sessionKey);
        if (
          !fresh ||
          fresh.entry.sessionId !== resolved.sessionId ||
          (fencedScope.expectedLifecycleRevision !== undefined &&
            fresh.entry.lifecycleRevision !== fencedScope.expectedLifecycleRevision) ||
          (fencedScope.expectedWriterRunId !== undefined &&
            // SAFETY: the SQLite entry decoder retains private durable writer ownership fields.
            (fresh.entry as InternalSessionEntry).activeWriterRunId !==
              fencedScope.expectedWriterRunId)
        ) {
          return;
        }
        if (
          !transcriptMatchesExpectedEvents(
            readTranscriptEventRows(database, resolved.sessionId),
            params.expectedEvents,
          )
        ) {
          result = { replayed: false, reason: "transcript-changed" };
          return;
        }
        appendTranscriptBranchReplayInTransaction(database, resolved, params.replayEvents);
        result = { replayed: true };
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.transcript.branch-replay" },
    );
    if (fencedScope.expectedWriterRunId !== undefined && result.reason === "session-rebound") {
      throw new SessionTranscriptWriterClaimReboundError(scope.sessionKey);
    }
    return result;
  });
}

/** Atomically splices a bounded replacement suffix onto one active reset epoch. */
export async function replayTranscriptResetEpochBranch(
  scope: SessionTranscriptWriteScope,
  params: {
    expectedWatermark: { generation: string | null; maxSeq: number };
    firstAbandonedChildId: string;
    forkParentId: string;
    replayEvents: readonly TranscriptEvent[];
    resetBoundary?: SessionTranscriptResetBoundaryAnchor;
  },
): Promise<TranscriptResetEpochBranchReplayResult> {
  const forkParentId = params.forkParentId.trim();
  const firstAbandonedChildId = params.firstAbandonedChildId.trim();
  const firstReplayEvent = params.replayEvents[0];
  if (
    !forkParentId ||
    !firstAbandonedChildId ||
    !isRecord(firstReplayEvent) ||
    firstReplayEvent.parentId !== forkParentId
  ) {
    return { replayed: false, reason: "invalid-branch" };
  }
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  return await runExclusiveSqliteSessionWrite(resolved, async () => {
    let result: TranscriptResetEpochBranchReplayResult = {
      replayed: false,
      reason: "session-rebound",
    };
    runOpenClawAgentWriteTransaction(
      (database) => {
        const fresh = readSessionEntryRow(database, resolved.sessionKey);
        if (
          !fresh ||
          fresh.entry.sessionId !== resolved.sessionId ||
          (fencedScope.expectedLifecycleRevision !== undefined &&
            fresh.entry.lifecycleRevision !== fencedScope.expectedLifecycleRevision) ||
          (fencedScope.expectedWriterRunId !== undefined &&
            // SAFETY: the SQLite entry decoder retains private durable writer ownership fields.
            (fresh.entry as InternalSessionEntry).activeWriterRunId !==
              fencedScope.expectedWriterRunId)
        ) {
          return;
        }
        if (
          !transcriptMatchesExpectedWatermark(
            database,
            resolved.sessionId,
            params.expectedWatermark,
          )
        ) {
          result = { replayed: false, reason: "transcript-changed" };
          return;
        }
        const replayEvents = allocateResetEpochReplayEventIds(
          database,
          resolved.sessionId,
          params.replayEvents,
        );
        if (
          !rewindSessionTranscriptIndexForBranchSpliceInTransaction(database.db, {
            expectedIndexedSeq: params.expectedWatermark.maxSeq,
            firstAbandonedChildId,
            forkParentId,
            ...(params.resetBoundary ? { resetBoundary: params.resetBoundary } : {}),
            sessionId: resolved.sessionId,
          })
        ) {
          result = { replayed: false, reason: "invalid-branch" };
          return;
        }
        appendTranscriptBranchReplayInTransaction(database, resolved, replayEvents, {
          projectionMode: "forward-only",
        });
        touchTranscriptMutationInTransaction(database, resolved.sessionId);
        if (sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId)) {
          throw new Error("Transcript reset-epoch replay left its active projection dirty");
        }
        result = { replayed: true };
      },
      toDatabaseOptions(resolved),
      { operationLabel: "session.transcript.reset-epoch-branch-replay" },
    );
    if (fencedScope.expectedWriterRunId !== undefined && result.reason === "session-rebound") {
      throw new SessionTranscriptWriterClaimReboundError(scope.sessionKey);
    }
    return result;
  });
}
