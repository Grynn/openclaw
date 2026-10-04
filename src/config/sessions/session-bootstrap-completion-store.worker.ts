import { randomUUID } from "node:crypto";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteTranscriptScope,
  transcriptWriteScopeIsCurrent,
} from "./session-accessor.sqlite-scope.js";
import { resolveTranscriptEventAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";

export type SessionBootstrapCompletionInput = {
  sessionId: string;
  sessionKey: string;
  runId: string;
  customType: string;
  expectedLifecycleRevision?: string;
  expectedWriterRunId?: string;
};

/** Commits the marker only while the native database still owns this session and run. */
export function appendSessionBootstrapCompletionInTransaction(
  database: OpenClawAgentDatabase,
  input: SessionBootstrapCompletionInput,
): boolean {
  const resolved = resolveSqliteTranscriptScope({
    agentId: database.agentId,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    storePath: database.path,
  });
  assertSessionTranscriptHot(database.db, input.sessionId);
  const entry = readSessionEntryRow(database, input.sessionKey)?.entry;
  if (!transcriptWriteScopeIsCurrent(entry, input.sessionId, input)) {
    return false;
  }
  const event = {
    type: "custom" as const,
    customType: input.customType,
    data: { timestamp: Date.now(), runId: input.runId, sessionId: input.sessionId },
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
  };
  return Boolean(
    appendTranscriptEventInTransaction(
      database,
      resolved,
      resolveTranscriptEventAppendParent(database, input.sessionId, event, {
        appendIntent: "active-branch",
      }),
    ),
  );
}
