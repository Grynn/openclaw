// SQLite implementation for the narrow read-only session-listing facade.
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import {
  readSessionEntryCache,
  type SessionEntryCacheSnapshot,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  cloneSessionEntry,
  resolveSqliteScope,
  toDatabaseOptions,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import type {
  SessionAccessScope,
  SessionEntryListScope,
  SessionEntrySummary,
} from "./session-accessor.types.js";
import {
  assertCanonicalSqliteSessionKeysCurrent,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "./store-entry.js";

function isInternalSessionEffectsKey(sessionKey: string): boolean {
  const parts = sessionKey.split(":");
  return parts.length >= 4 && parts[0] === "agent" && parts[2] === "internal-session-effects";
}

/**
 * Lists session entries without opening the agent database writable.
 * Transient lock errors propagate: only the caller knows whether "empty" is an
 * acceptable degradation (health snapshots) or hides real state (migration detection).
 */
export function listSessionEntriesReadOnly(
  scope: SessionEntryListScope = {},
): SessionEntrySummary[] {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => listSqliteSessionEntriesFromDatabase(database, resolved, scope),
    toDatabaseOptions(resolved),
  );
  return result.found ? result.value : [];
}

export function listSqliteSessionEntriesFromDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ResolvedSqliteScope,
  scope: SessionEntryListScope,
): SessionEntrySummary[] {
  assertCanonicalSqliteSessionKeysCurrent(database);
  const snapshot = readSessionEntrySnapshot(database, resolved, scope.readConsistency);
  const entries = scope.projection === "list" ? snapshot.listEntries : snapshot.entries;
  return snapshot.keys.flatMap((sessionKey) => {
    if (isInternalSessionEffectsKey(sessionKey)) {
      return [];
    }
    const entry = entries.get(sessionKey);
    if (!entry) {
      return [];
    }
    const deliveryCanonicalKey = resolveDeliveryProvenCanonicalSessionKey(sessionKey, entry);
    if (deliveryCanonicalKey !== sessionKey) {
      throw canonicalSessionKeyMigrationRequiredError(
        `non-canonical persisted row resolves to session key ${deliveryCanonicalKey}`,
      );
    }
    return [
      {
        sessionKey,
        entry: scope.clone === false ? entry : cloneSessionEntry(entry),
      },
    ];
  });
}

export function readSessionEntrySnapshot(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ResolvedSqliteScope,
  readConsistency: SessionAccessScope["readConsistency"],
): SessionEntryCacheSnapshot {
  const cache = !isIncognitoOpenClawAgentSqlitePath(database.path, {
    agentId: database.agentId,
    env: resolved.env,
  });
  return readSessionEntryCache(database, {
    cache,
    latest: readConsistency === "latest",
  });
}
