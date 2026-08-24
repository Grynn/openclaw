import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { appendTranscriptBranchReplayInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

export type TranscriptBranchReplayResult =
  | { replayed: true }
  | { reason: "session-rebound" | "transcript-changed"; replayed: false };

function transcriptMatchesExpectedEvents(
  rows: ReturnType<typeof readTranscriptEventRows>,
  expectedEvents: readonly TranscriptEvent[],
): boolean {
  return (
    rows.length === expectedEvents.length &&
    rows.every((row, index) => row.eventJson === JSON.stringify(expectedEvents[index]))
  );
}

/** Commits one preplanned branch suffix under the session queue and one SQLite transaction. */
export async function replayTranscriptBranch(
  scope: SessionTranscriptWriteScope,
  params: {
    expectedEvents: readonly TranscriptEvent[];
    replayEvents: readonly TranscriptEvent[];
  },
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
