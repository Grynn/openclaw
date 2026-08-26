// Memory Core tests cover live read-only status against writer-owned session stores.
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  statSessionEntrySync,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  ensureMemoryIndexSchema,
  MEMORY_CHUNKING_VERSION,
  type MemorySource,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeMemoryDatabase, openMemoryDatabaseReadOnlyAtPath } from "./manager-db.js";
import {
  MEMORY_INDEX_PROVENANCE_VERSION,
  resolveConfiguredScopeHash,
  type MemoryIndexMeta,
} from "./manager-reindex-state.js";
import { MemoryManagerSyncOps } from "./manager-sync-ops.js";

type MemoryIndexEntry = {
  absPath: string;
  hash: string;
  mtimeMs: number;
  path: string;
  size: number;
};

class ReadOnlySessionStatusHarness extends MemoryManagerSyncOps {
  protected readonly cfg = {} as OpenClawConfig;
  protected readonly agentId = "main";
  protected readonly workspaceDir = "/tmp/openclaw-read-only-status-workspace";
  protected readonly settings = {
    batch: { enabled: false },
    chunking: { overlap: 0, tokens: 256 },
    extraPaths: [],
    multimodal: { enabled: false, modalities: [], maxFileBytes: 0 },
    provider: "none",
    store: { fts: { tokenizer: "unicode61" }, vector: { enabled: false } },
    sync: { sessions: { deltaBytes: 100_000, deltaMessages: 50, postCompactionForce: true } },
  } as unknown as ResolvedMemorySearchConfig;
  protected readonly batch = {
    concurrency: 1,
    enabled: false,
    pollIntervalMs: 0,
    timeoutMs: 0,
    wait: false,
  };
  protected readonly vector = { available: false, enabled: false };
  protected readonly cache = { enabled: false };
  protected providerUnavailableReason?: string;
  protected providerLifecycle = { mode: "active" as const, providerId: "test" };

  constructor(
    protected readonly db: DatabaseSync,
    private readonly corpusEntry: SessionTranscriptCorpusEntry,
  ) {
    super();
    this.sources.add("sessions");
  }

  async markStartupDirtyFiles(): Promise<string[]> {
    return await this.markSessionStartupCatchupDirtyFiles();
  }

  protected override listSessionCorpusEntries(): Promise<SessionTranscriptCorpusEntry[]> {
    return Promise.resolve([this.corpusEntry]);
  }

  protected computeProviderKey(): string {
    return "test";
  }

  protected resolveProviderIndexIdentities() {
    return [];
  }

  protected override readMeta(): MemoryIndexMeta {
    return {
      chunkOverlap: this.settings.chunking.overlap,
      chunkTokens: this.settings.chunking.tokens,
      chunkingVersion: MEMORY_CHUNKING_VERSION,
      ftsTokenizer: this.settings.store.fts.tokenizer,
      model: "fts-only",
      provenanceVersion: MEMORY_INDEX_PROVENANCE_VERSION,
      provider: "none",
      scopeHash: resolveConfiguredScopeHash({
        extraPaths: this.settings.extraPaths,
        multimodal: this.settings.multimodal,
        workspaceDir: this.workspaceDir,
      }),
      sources: ["sessions"],
    };
  }

  protected async sync(_params?: MemorySyncParams): Promise<void> {}
  protected async withTimeout<T>(promise: Promise<T>): Promise<T> {
    return await promise;
  }
  protected getIndexConcurrency(): number {
    return 1;
  }
  protected pruneEmbeddingCacheIfNeeded(): void {}
  protected resetProviderInitializationForRetry(): void {}
  protected assertRequiredProviderAvailable(): void {}
  protected async indexFile(
    _entry: MemoryIndexEntry,
    _options: { source: MemorySource; content?: string },
  ): Promise<void> {}
}

describe("read-only session status", () => {
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const readOnlyDatabases = new Set<DatabaseSync>();
  let stateDir = "";

  afterEach(() => {
    for (const database of readOnlyDatabases) {
      closeMemoryDatabase(database);
    }
    readOnlyDatabases.clear();
    closeOpenClawAgentDatabasesForTest();
    resetPluginStateStoreForTests();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-read-only-session-status-");
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  async function createSessionFixture(label: string): Promise<{
    corpusEntry: SessionTranscriptCorpusEntry;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }> {
    const sessionId = `${label}-thread`;
    const sessionKey = `agent:main:chat:${label}`;
    const storePath = path.join(stateDir, "custom-sessions", `${label}.json`);
    await upsertSessionEntry({
      agentId: "main",
      entry: { sessionId, updatedAt: 10 },
      sessionKey,
      storePath,
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      cwd: stateDir,
      message: { content: "initial transcript", role: "user" },
      sessionId,
      sessionKey,
      storePath,
    });
    const state = statSessionEntrySync(sessionKey, {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      updatedAtMs: 10,
    });
    if (!state) {
      throw new Error("expected SQLite transcript state");
    }
    return {
      corpusEntry: {
        agentId: "main",
        artifactKind: "active-session",
        sessionFile: sessionKey,
        sessionId,
        sessionKey,
        storePath,
        transcriptSource: "sqlite",
        updatedAtMs: 10,
      },
      sessionId,
      sessionKey,
      storePath,
    };
  }

  function createStatusHarness(
    corpusEntry: SessionTranscriptCorpusEntry,
  ): ReadOnlySessionStatusHarness {
    const state = statSessionEntrySync(corpusEntry.sessionKey ?? "", {
      agentId: corpusEntry.agentId,
      sessionId: corpusEntry.sessionId,
      sessionKey: corpusEntry.sessionKey,
      storePath: corpusEntry.storePath,
      updatedAtMs: corpusEntry.updatedAtMs,
    });
    if (!state) {
      throw new Error("expected indexed SQLite transcript state");
    }
    const agentDatabase = openOpenClawAgentDatabase({ agentId: "main" });
    ensureMemoryIndexSchema({ cacheEnabled: false, db: agentDatabase.db, ftsEnabled: false });
    agentDatabase.db
      .prepare(
        `INSERT INTO memory_index_sources (path, source, hash, mtime, size)
         VALUES (?, 'sessions', ?, ?, ?)`,
      )
      .run(state.path, "current-hash", state.mtimeMs, state.size);
    const databasePath = agentDatabase.path;
    closeOpenClawAgentDatabasesForTest();
    const readOnlyDatabase = openMemoryDatabaseReadOnlyAtPath(databasePath, false, "main");
    readOnlyDatabases.add(readOnlyDatabase);
    return new ReadOnlySessionStatusHarness(readOnlyDatabase, corpusEntry);
  }

  async function appendAfterStatusOpened(fixture: {
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }): Promise<void> {
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      cwd: stateDir,
      message: { content: "committed after status opened", role: "assistant" },
      sessionId: fixture.sessionId,
      sessionKey: fixture.sessionKey,
      storePath: fixture.storePath,
    });
  }

  it("stats a custom corpus from its actual store", async () => {
    const fixture = await createSessionFixture("custom-store");
    const harness = createStatusHarness(fixture.corpusEntry);

    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([]);
    await appendAfterStatusOpened(fixture);
    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([fixture.sessionKey]);
  });

  it("does not pin one WAL snapshot across repeated status scans", async () => {
    const fixture = await createSessionFixture("wal-snapshot");
    const harness = createStatusHarness(fixture.corpusEntry);

    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([]);
    await appendAfterStatusOpened(fixture);
    await expect(harness.markStartupDirtyFiles()).resolves.toEqual([fixture.sessionKey]);
  });
});
