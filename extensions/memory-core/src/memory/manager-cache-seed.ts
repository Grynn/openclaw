// Memory Core plugin module seeds embedding caches without holding long transactions.
import type { DatabaseSync } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  type Generated,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import {
  prepareMemoryEmbeddingCacheInsertIgnore,
  prepareMemoryEmbeddingCacheUpsert,
  type MemoryEmbeddingCacheRow,
} from "./manager-embedding-cache.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { readMemoryIndexMetadata } from "./manager-retrieval-read.js";

// Production embeddings are large enough that thousand-row commits can stall
// the Gateway for seconds; return to the event loop after each small page.
const BATCH_SIZE = 100;
type CacheSeedDatabase = {
  memory_embedding_cache: MemoryEmbeddingCacheRow & { rowid: Generated<number> };
  memory_index_chunks: {
    rowid: Generated<number>;
    model: string;
    hash: string;
    embedding: Uint8Array;
    updated_at: number;
  };
};

export async function seedMemoryEmbeddingCache(params: {
  sourceDb: DatabaseSync;
  targetDb: DatabaseSync;
  enabled: boolean;
}): Promise<void> {
  if (!params.enabled) {
    return;
  }
  const source = getNodeSqliteKysely<CacheSeedDatabase>(params.sourceDb);
  const upsert = prepareMemoryEmbeddingCacheUpsert(params.targetDb);
  let lastRowid = 0;
  while (true) {
    const batch = executeSqliteQuerySync(
      params.sourceDb,
      source
        .selectFrom("memory_embedding_cache")
        .select([
          "rowid as rowid",
          "provider",
          "model",
          "provider_key",
          "hash",
          "embedding",
          "dims",
          "updated_at",
        ])
        .where("rowid", ">", lastRowid)
        .orderBy("rowid")
        .limit(BATCH_SIZE),
    ).rows;
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
    sourceMeta: readMemoryIndexMetadata(params.sourceDb).meta,
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
    params.sourceMeta === undefined
      ? readMemoryIndexMetadata(params.sourceDb).meta
      : params.sourceMeta;
  const source = getNodeSqliteKysely<CacheSeedDatabase>(params.sourceDb);
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
    !executeSqliteQuerySync(
      params.sourceDb,
      source
        .selectFrom("memory_index_chunks as chunk")
        .select("chunk.rowid")
        .where("chunk.model", "=", identity.model)
        .where((eb) => eb(eb.fn<number>("length", ["chunk.embedding"]), ">", 0))
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("memory_embedding_cache as cache")
                .select("cache.rowid")
                .where("cache.provider", "=", identity.provider)
                .whereRef("cache.model", "=", "chunk.model")
                .where("cache.provider_key", "=", identity.providerKey)
                .whereRef("cache.hash", "=", "chunk.hash"),
            ),
          ),
        )
        .limit(1),
    ).rows[0]
  ) {
    return;
  }

  const insert = prepareMemoryEmbeddingCacheInsertIgnore(params.targetDb);
  let lastRowid = 0;
  while (true) {
    const batch = executeSqliteQuerySync(
      params.sourceDb,
      source
        .selectFrom("memory_index_chunks")
        // SQLite names an unaliased rowid after the INTEGER PRIMARY KEY column.
        // Keep the paging cursor stable across both cache and chunk table schemas.
        .select(["rowid as rowid", "hash", "embedding", "updated_at"])
        .where("rowid", ">", lastRowid)
        .where("model", "=", identity.model)
        .where((eb) => eb(eb.fn<number>("length", ["embedding"]), ">", 0))
        .orderBy("rowid")
        .limit(BATCH_SIZE),
    ).rows;
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
