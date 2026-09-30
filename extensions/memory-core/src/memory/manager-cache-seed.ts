// Memory Core plugin module seeds embedding caches without holding long transactions.
import type { DatabaseSync } from "node:sqlite";
import { MEMORY_EMBEDDING_CACHE_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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

type SourceEmbeddingMeta = Pick<
  MemoryIndexMeta,
  "provider" | "model" | "providerKey" | "vectorDims"
>;
type CacheRow = MemoryEmbeddingCacheRow & { rowid: number };
type ChunkEmbeddingRow = {
  rowid: number;
  hash: string;
  embedding: Uint8Array;
  updated_at: number;
};

function isCacheRow(value: unknown): value is CacheRow {
  return (
    isRecord(value) &&
    typeof value.rowid === "number" &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.provider_key === "string" &&
    typeof value.hash === "string" &&
    value.embedding instanceof Uint8Array &&
    (value.dims === null || typeof value.dims === "number") &&
    typeof value.updated_at === "number"
  );
}

function isChunkEmbeddingRow(value: unknown): value is ChunkEmbeddingRow {
  return (
    isRecord(value) &&
    typeof value.rowid === "number" &&
    typeof value.hash === "string" &&
    value.embedding instanceof Uint8Array &&
    typeof value.updated_at === "number"
  );
}

function readSourceMeta(sourceDb: DatabaseSync): SourceEmbeddingMeta | null {
  const row = sourceDb.prepare("SELECT value FROM memory_index_meta WHERE key = ?").get(META_KEY);
  if (typeof row?.value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (
      !isRecord(parsed) ||
      typeof parsed.provider !== "string" ||
      typeof parsed.model !== "string" ||
      (parsed.providerKey !== undefined && typeof parsed.providerKey !== "string") ||
      (parsed.vectorDims !== undefined && typeof parsed.vectorDims !== "number")
    ) {
      return null;
    }
    return {
      provider: parsed.provider,
      model: parsed.model,
      ...(parsed.providerKey === undefined ? {} : { providerKey: parsed.providerKey }),
      ...(parsed.vectorDims === undefined ? {} : { vectorDims: parsed.vectorDims }),
    };
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
    const batch: unknown[] = selectBatch.all(lastRowid, BATCH_SIZE);
    if (!batch.every(isCacheRow)) {
      throw new Error("Invalid embedding cache row in source database");
    }
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
  sourceMeta?: SourceEmbeddingMeta | null;
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
         WHERE chunk.model = ? AND length(chunk.embedding) > 0
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

  const selectBatch = params.sourceDb.prepare(
    `SELECT rowid AS rowid, hash, embedding, updated_at
     FROM memory_index_chunks
     WHERE rowid > ? AND model = ? AND length(embedding) > 0
     ORDER BY rowid
     LIMIT ?`,
  );
  const insert = prepareMemoryEmbeddingCacheInsertIgnore(params.targetDb);
  let lastRowid = 0;
  while (true) {
    const batch: unknown[] = selectBatch.all(lastRowid, identity.model, BATCH_SIZE);
    if (!batch.every(isChunkEmbeddingRow)) {
      throw new Error("Invalid embedding chunk row in source database");
    }
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
