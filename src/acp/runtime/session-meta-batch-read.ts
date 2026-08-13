/** Narrow ACP metadata reader for session-listing hot paths. */
import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import type { Selectable } from "kysely";
import type {
  AcpSessionRuntimeOptions,
  SessionAcpIdentity,
  SessionAcpMeta,
  SessionEntry,
} from "../../config/sessions/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";

type AcpSessionsTable = OpenClawStateKyselyDatabase["acp_sessions"];
type AcpSessionMetaDatabase = Pick<OpenClawStateKyselyDatabase, "acp_sessions">;
type AcpSessionRow = Selectable<AcpSessionsTable>;
type AcpSessionEntryBinding = Pick<SessionEntry, "lifecycleRevision"> &
  Partial<Pick<SessionEntry, "sessionId" | "sessionStartedAt">>;

function getAcpSessionKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<AcpSessionMetaDatabase>(db);
}

function rowToAcpSessionMeta(row: AcpSessionRow): SessionAcpMeta {
  const identity = safeParseJsonRecord(row.identity_json ?? "") as SessionAcpIdentity | undefined;
  const runtimeOptions = safeParseJsonRecord(row.runtime_options_json ?? "") as
    | AcpSessionRuntimeOptions
    | undefined;
  return {
    backend: row.backend,
    agent: row.agent,
    runtimeSessionName: row.runtime_session_name,
    ...(identity ? { identity } : {}),
    mode: row.mode === "oneshot" ? "oneshot" : "persistent",
    ...(runtimeOptions ? { runtimeOptions } : {}),
    ...(row.cwd != null ? { cwd: row.cwd } : {}),
    state: row.state === "running" || row.state === "error" ? row.state : "idle",
    lastActivityAt: row.last_activity_at,
    ...(row.last_error != null ? { lastError: row.last_error } : {}),
  };
}

function selectAcpSessionRow(db: DatabaseSync, sessionKey: string): AcpSessionRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getAcpSessionKysely(db)
      .selectFrom("acp_sessions")
      .selectAll()
      .where("session_key", "=", sessionKey),
  );
}

function acpSessionRowMatchesEntry(
  row: AcpSessionRow,
  entry: AcpSessionEntryBinding | undefined,
): boolean {
  return (
    row.session_id == null ||
    row.session_id === entry?.lifecycleRevision ||
    // Pre-boundary rows stored sessionId here; the next read rebinds them to the revision.
    (row.session_id === entry?.sessionId &&
      (entry?.sessionStartedAt === undefined || row.updated_at >= entry.sessionStartedAt))
  );
}

function resolveReadableAcpSessionRow(params: {
  row: AcpSessionRow | undefined;
  entry: AcpSessionEntryBinding | undefined;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): AcpSessionRow | undefined {
  const { row, entry } = params;
  if (!row || !acpSessionRowMatchesEntry(row, entry)) {
    return undefined;
  }
  const legacySessionId = entry?.sessionId;
  const lifecycleRevision = entry?.lifecycleRevision;
  if (
    !legacySessionId ||
    !lifecycleRevision ||
    row.session_id !== legacySessionId ||
    row.session_id === lifecycleRevision
  ) {
    return row;
  }
  return runOpenClawStateWriteTransaction(
    (database) => {
      const current = selectAcpSessionRow(database.db, row.session_key);
      if (!current || current.session_id === lifecycleRevision || current.session_id == null) {
        return current;
      }
      if (current.session_id !== legacySessionId) {
        return undefined;
      }
      executeSqliteQuerySync(
        database.db,
        getAcpSessionKysely(database.db)
          .updateTable("acp_sessions")
          .set({ session_id: lifecycleRevision })
          .where("session_key", "=", row.session_key)
          .where("session_id", "=", legacySessionId),
      );
      return { ...current, session_id: lifecycleRevision };
    },
    { env: params.env, path: params.databasePath },
  );
}

export function readAcpSessionMetaBatch(params: {
  entries: ReadonlyArray<{ sessionKey: string; entry: SessionEntry }>;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
}): Map<SessionEntry, SessionAcpMeta | undefined> {
  const result = new Map<SessionEntry, SessionAcpMeta | undefined>();
  const entriesByKey = new Map<string, SessionEntry[]>();
  for (const item of params.entries) {
    const sessionKey = item.sessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    if (item.entry.acp) {
      result.set(item.entry, item.entry.acp);
      continue;
    }
    const entries = entriesByKey.get(sessionKey) ?? [];
    entries.push(item.entry);
    entriesByKey.set(sessionKey, entries);
  }
  if (entriesByKey.size === 0) {
    return result;
  }

  const database = openOpenClawStateDatabase({ env: params.env, path: params.databasePath });
  const db = getAcpSessionKysely(database.db);
  const requestedKeys = [...entriesByKey.keys()];
  // Chunked IN keeps each statement under SQLite's bind-variable cap, matching the
  // sharing-store membership precedent; one statement per 500 keys instead of per row.
  const keyChunks: string[][] = [];
  for (let index = 0; index < requestedKeys.length; index += 500) {
    keyChunks.push(requestedKeys.slice(index, index + 500));
  }
  const rows = keyChunks.flatMap(
    (chunk) =>
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("acp_sessions").selectAll().where("session_key", "in", chunk),
      ).rows,
  );
  const rowsByKey = new Map(rows.map((row) => [row.session_key, row]));
  for (const [sessionKey, entries] of entriesByKey) {
    for (const entry of entries) {
      const row = resolveReadableAcpSessionRow({
        row: rowsByKey.get(sessionKey),
        entry,
        env: params.env,
        databasePath: params.databasePath,
      });
      result.set(entry, row ? rowToAcpSessionMeta(row) : undefined);
    }
  }
  return result;
}
