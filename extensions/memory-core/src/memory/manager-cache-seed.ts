// Memory Core plugin module seeds embedding caches without holding long transactions.
import type { DatabaseSync } from "node:sqlite";
import { MEMORY_EMBEDDING_CACHE_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  prepareMemoryEmbeddingCacheInsertIgnore,
  prepareMemoryEmbeddingCacheUpsert,
  type MemoryEmbeddingCacheRow,
} from "./manager-embedding-cache.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

// Production embeddings are large enough that thousand-row commits can stall
// the Gateway for seconds; return to the event loop after each small page.
const BATCH_SIZE = 100;
const META_KEY = "memory_index_meta_v1";

function readSourceMeta(sourceDb: DatabaseSync): MemoryIndexMeta | null {
  const row = sourceDb
    .prepare("SELECT value FROM memory_index_meta WHERE key = ?")
    .get(META_KEY) as { value: string } | undefined;
  try {
    return row?.value ? (JSON.parse(row.value) as MemoryIndexMeta) : null;
  } catch {
    return null;
  }
}

export async function seedMemoryEmbeddingCache(params: {
  sourceDb: DatabaseSync;
  targetDb: DatabaseSync;
  enabled: boolean;
}): Promise<void> {
  if (!params.enabled) {
    return;
  }
  type CacheRow = MemoryEmbeddingCacheRow & { rowid: number };
  const selectBatch = params.sourceDb.prepare(
    `SELECT rowid, provider, model, provider_key, hash, embedding, dims, updated_at
     FROM ${MEMORY_EMBEDDING_CACHE_TABLE}
     WHERE rowid > ?
     ORDER BY rowid
     LIMIT ?`,
  );
  const upsert = prepareMemoryEmbeddingCacheUpsert(params.targetDb);
  let lastRowid = 0;
  while (true) {
    const batch = selectBatch.all(lastRowid, BATCH_SIZE) as CacheRow[];
    if (batch.length === 0) {
      break;
    }
    runSqliteImmediateTransactionSync(
      params.targetDb,
      () => {
        for (const row of batch) {
          upsert(row);
        }
      },
      { operationLabel: "memory.embedding-cache.seed" },
    );
    lastRowid = batch[batch.length - 1]?.rowid ?? lastRowid;
    if (batch.length < BATCH_SIZE) {
      break;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  await seedMemoryEmbeddingCacheFromChunks({
    ...params,
    sourceMeta: readSourceMeta(params.sourceDb),
  });
}

export async function seedMemoryEmbeddingCacheFromChunks(params: {
  sourceDb: DatabaseSync;
  targetDb: DatabaseSync;
  enabled: boolean;
  sourceMeta?: MemoryIndexMeta | null;
}): Promise<void> {
  if (!params.enabled) {
    return;
  }
  const meta =
    params.sourceMeta === undefined ? readSourceMeta(params.sourceDb) : params.sourceMeta;
  if (
    !meta?.providerKey ||
    !meta.provider ||
    meta.provider === "none" ||
    !meta.model ||
    !meta.vectorDims ||
    meta.vectorDims < 1
  ) {
    return;
  }
  const identity = {
    provider: meta.provider,
    model: meta.model,
    providerKey: meta.providerKey,
    vectorDims: meta.vectorDims,
  };

  if (
    params.sourceDb === params.targetDb &&
    !params.sourceDb
      .prepare(
        `SELECT 1
         FROM memory_index_chunks AS chunk
         WHERE chunk.model = ? AND chunk.embedding <> '[]'
           AND NOT EXISTS (
             SELECT 1 FROM ${MEMORY_EMBEDDING_CACHE_TABLE} AS cache
             WHERE cache.provider = ?
               AND cache.model = chunk.model
               AND cache.provider_key = ?
               AND cache.hash = chunk.hash
           )
         LIMIT 1`,
      )
      .get(identity.model, identity.provider, identity.providerKey)
  ) {
    return;
  }

  type ChunkEmbeddingRow = {
    rowid: number;
    hash: string;
    embedding: string;
    updated_at: number;
  };
  const selectBatch = params.sourceDb.prepare(
    `SELECT rowid, hash, embedding, updated_at
     FROM memory_index_chunks
     WHERE rowid > ? AND model = ? AND embedding <> '[]'
     ORDER BY rowid
     LIMIT ?`,
  );
  const insert = prepareMemoryEmbeddingCacheInsertIgnore(params.targetDb);
  let lastRowid = 0;
  while (true) {
    const batch = selectBatch.all(lastRowid, identity.model, BATCH_SIZE) as ChunkEmbeddingRow[];
    if (batch.length === 0) {
      return;
    }
    runSqliteImmediateTransactionSync(
      params.targetDb,
      () => {
        for (const row of batch) {
          insert({
            provider: identity.provider,
            model: identity.model,
            provider_key: identity.providerKey,
            hash: row.hash,
            embedding: row.embedding,
            dims: identity.vectorDims,
            updated_at: row.updated_at,
          });
        }
      },
      { operationLabel: "memory.embedding-cache.seed-chunks" },
    );
    lastRowid = batch[batch.length - 1]?.rowid ?? lastRowid;
    if (batch.length < BATCH_SIZE) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
