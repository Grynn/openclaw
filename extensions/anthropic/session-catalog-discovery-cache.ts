import {
  resolveSessionCatalogOwnerTask,
  type SessionCatalogOwnerTask,
} from "openclaw/plugin-sdk/session-catalog-runtime";
import { scanClaudeSessions, type CatalogRecord } from "./session-catalog-discovery.js";
import {
  currentHomeDir,
  desktopSessionStoreAvailable,
  projectsDir,
  readProjectsTreeSnapshot,
  setBoundedCache,
} from "./session-catalog-scan.js";

const MAX_SCAN_CACHE_ENTRIES = 8;
const SCAN_HARD_TTL_MS = 5 * 60_000;
const PARTIAL_SCAN_TTL_MS = 15_000;
const DESKTOP_SCAN_TTL_MS = 60_000;

type ClaudeSessionScanCacheEntry = {
  generation: number;
  treeStamp: string;
  hardExpiresAt: number;
  desktopStoreAvailable: boolean;
  desktopExpiresAt: number;
  records: CatalogRecord[];
};

// Settled scans are root-scoped and LRU-bounded. Active request owners live in a separate index so
// eviction never duplicates filesystem work and only the final departing consumer cancels it.
const scanCache = new Map<string, ClaudeSessionScanCacheEntry>();
const activeScans = new Map<string, SessionCatalogOwnerTask<CatalogRecord[]>>();
let nextScanGeneration = 1;

async function loadClaudeSessions(params: {
  cacheKey: string;
  forceRefresh: boolean;
  homeDir: string;
  includeDesktop: boolean;
  generation: number;
  root: string;
  signal: AbortSignal;
}): Promise<CatalogRecord[]> {
  const [treeSnapshot, desktopStoreAvailable] = await Promise.all([
    readProjectsTreeSnapshot(params.root, params.signal),
    params.includeDesktop
      ? desktopSessionStoreAvailable(params.homeDir, params.signal)
      : Promise.resolve(false),
  ]);
  params.signal.throwIfAborted();
  const now = Date.now();
  const cached = scanCache.get(params.cacheKey);
  // Tree signatures invalidate CLI rows on the next poll; hard and Desktop expiries backstop
  // metadata anomalies. A specific-thread refresh bypasses both.
  if (
    !params.forceRefresh &&
    cached &&
    cached.treeStamp === treeSnapshot.treeStamp &&
    cached.hardExpiresAt > now &&
    cached.desktopStoreAvailable === desktopStoreAvailable &&
    (!desktopStoreAvailable || cached.desktopExpiresAt > now)
  ) {
    setBoundedCache(scanCache, params.cacheKey, cached, MAX_SCAN_CACHE_ENTRIES);
    return cached.records;
  }
  const scan = await scanClaudeSessions(
    params.homeDir,
    treeSnapshot,
    params.includeDesktop,
    params.signal,
  );
  params.signal.throwIfAborted();
  if ((scanCache.get(params.cacheKey)?.generation ?? 0) > params.generation) {
    return scan.records;
  }
  setBoundedCache(
    scanCache,
    params.cacheKey,
    {
      generation: params.generation,
      treeStamp: treeSnapshot.treeStamp,
      hardExpiresAt: Date.now() + (scan.complete ? SCAN_HARD_TTL_MS : PARTIAL_SCAN_TTL_MS),
      desktopStoreAvailable,
      desktopExpiresAt: Date.now() + DESKTOP_SCAN_TTL_MS,
      records: scan.records,
    },
    MAX_SCAN_CACHE_ENTRIES,
  );
  return scan.records;
}

export async function listClaudeSessions(
  homeDir = currentHomeDir(),
  options: {
    forceRefresh?: boolean;
    configDir?: string;
    includeDesktop?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<CatalogRecord[]> {
  options.signal?.throwIfAborted();
  const root = projectsDir(homeDir, options.configDir);
  const includeDesktop = options.includeDesktop !== false;
  const cacheKey = `${root}\0${includeDesktop ? "desktop" : "cli"}`;
  const refreshKey = `${cacheKey}\0refresh`;
  const activeKey =
    options.forceRefresh === true
      ? refreshKey
      : activeScans.has(refreshKey)
        ? refreshKey
        : cacheKey;
  return await resolveSessionCatalogOwnerTask({
    activeTasks: activeScans,
    key: activeKey,
    load: async (signal) =>
      await loadClaudeSessions({
        cacheKey,
        forceRefresh: options.forceRefresh === true,
        generation: nextScanGeneration++,
        homeDir,
        includeDesktop,
        root,
        signal,
      }),
    ...(options.signal ? { signal: options.signal } : {}),
    orphanedMessage: "Claude session scan has no active requesters",
  });
}
