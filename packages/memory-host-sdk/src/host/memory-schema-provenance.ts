// Memory Host SDK module owns additive memory chunk provenance schema.
import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "./openclaw-runtime-sqlite.js";

export const MEMORY_INDEX_CHUNK_PROVENANCE_TABLE = "memory_index_chunk_provenance";

export const MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} (
    chunk_id TEXT PRIMARY KEY,
    origin_class TEXT NOT NULL CHECK (origin_class IN ('owner', 'agent', 'untrusted', 'system')),
    session_kind TEXT NOT NULL CHECK (session_kind IN ('interactive', 'cron', 'heartbeat', 'subagent', 'unknown')),
    observed_at INTEGER NOT NULL,
    supersedes_key TEXT,
    FOREIGN KEY (chunk_id) REFERENCES memory_index_chunks(id) ON DELETE CASCADE
  ) STRICT;
`;

function hasCurrentMemoryChunkProvenance(db: DatabaseSync): boolean {
  const tableExists = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ? LIMIT 1")
    .get(MEMORY_INDEX_CHUNK_PROVENANCE_TABLE);
  if (!tableExists) {
    return false;
  }
  const legacyTriggerExists = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ? LIMIT 1")
    .get("memory_index_chunk_provenance_after_insert");
  if (legacyTriggerExists) {
    return false;
  }
  const missingProvenance = db
    .prepare(
      `SELECT 1
       FROM memory_index_chunks AS chunk
       LEFT JOIN ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} AS provenance
         ON provenance.chunk_id = chunk.id
       WHERE provenance.chunk_id IS NULL
       LIMIT 1`,
    )
    .get();
  return !missingProvenance;
}

export function ensureMemoryChunkProvenance(db: DatabaseSync): void {
  // Schema checks happen on every memory-manager open. Avoid acquiring the
  // immediate write lock and replaying the full backfill once provenance is
  // already complete; the indexed join remains cheap and keeps this safe when
  // an older writer inserts a chunk without provenance.
  if (hasCurrentMemoryChunkProvenance(db)) {
    return;
  }
  const ensure = () => {
    // The former chunk trigger made the additive table visible to older schema
    // validators. Writers upsert provenance explicitly; this backfill covers
    // legacy/imported rows without changing the canonical chunk table.
    db.exec("DROP TRIGGER IF EXISTS memory_index_chunk_provenance_after_insert");
    db.exec(MEMORY_INDEX_CHUNK_PROVENANCE_SCHEMA_SQL);
    db.exec(`
      UPDATE memory_index_sources
      SET hash = ''
      WHERE EXISTS (
        SELECT 1
        FROM memory_index_chunks AS chunk
        LEFT JOIN ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} AS provenance
          ON provenance.chunk_id = chunk.id
        WHERE provenance.chunk_id IS NULL
          AND chunk.path = memory_index_sources.path
          AND chunk.source IS memory_index_sources.source
      );

      INSERT OR IGNORE INTO ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE} (
        chunk_id, origin_class, session_kind, observed_at
      )
      SELECT id, 'untrusted', 'unknown', updated_at FROM memory_index_chunks;
    `);
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
}
