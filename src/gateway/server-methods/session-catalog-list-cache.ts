import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const SESSION_CATALOG_SHARE_WINDOW_MS = 3_000;
const SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES = 128;

type CatalogListResult = { catalogs: SessionCatalog[] };
type CatalogListProgressSubscriber = (catalog: SessionCatalog) => void;

type CatalogListCacheEntry = {
  abortController: AbortController;
  consumers: Set<symbol>;
  expiresAt?: number;
  progressSubscribers: Map<symbol, CatalogListProgressSubscriber>;
  result: Promise<CatalogListResult>;
  settled: boolean;
};

type CatalogListCacheState = {
  registrationIdentity: object;
  entries: Map<string, CatalogListCacheEntry>;
};

export const SESSION_CATALOG_LIST_WAITER_ABORTED = Symbol("catalog-list-waiter-aborted");

const catalogListsByConfig = new WeakMap<OpenClawConfig, CatalogListCacheState>();

function pruneSettledCatalogLists(cache: Map<string, CatalogListCacheEntry>): void {
  while (cache.size > SESSION_CATALOG_LIST_CACHE_MAX_ENTRIES) {
    const settled = [...cache].find(([, entry]) => entry.settled);
    if (!settled) {
      return;
    }
    cache.delete(settled[0]);
  }
}

function catalogListCache(
  config: OpenClawConfig,
  registrationIdentity: object,
): Map<string, CatalogListCacheEntry> {
  let state = catalogListsByConfig.get(config);
  if (!state || state.registrationIdentity !== registrationIdentity) {
    state = { registrationIdentity, entries: new Map() };
    catalogListsByConfig.set(config, state);
  }
  return state.entries;
}

function abortCatalogListWithoutConsumers(params: {
  cache: Map<string, CatalogListCacheEntry>;
  entry: CatalogListCacheEntry;
  listKey: string;
  reason?: unknown;
}): void {
  if (params.entry.settled || params.entry.consumers.size > 0) {
    return;
  }
  if (params.cache.get(params.listKey) === params.entry) {
    params.cache.delete(params.listKey);
  }
  if (!params.entry.abortController.signal.aborted) {
    params.entry.abortController.abort(
      params.reason ?? new Error("session catalog list has no active requesters"),
    );
  }
}

async function waitForCatalogListEntry(params: {
  cache: Map<string, CatalogListCacheEntry>;
  entry: CatalogListCacheEntry;
  listKey: string;
  signal?: AbortSignal;
  progressSubscriber?: CatalogListProgressSubscriber;
  consumer?: symbol;
}): Promise<CatalogListResult | typeof SESSION_CATALOG_LIST_WAITER_ABORTED> {
  const consumer = params.consumer ?? Symbol("catalog-list-consumer");
  params.entry.consumers.add(consumer);
  if (params.progressSubscriber) {
    params.entry.progressSubscribers.set(consumer, params.progressSubscriber);
  }
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    params.entry.consumers.delete(consumer);
    if (params.entry.progressSubscribers.get(consumer) === params.progressSubscriber) {
      params.entry.progressSubscribers.delete(consumer);
    }
    abortCatalogListWithoutConsumers({
      cache: params.cache,
      entry: params.entry,
      listKey: params.listKey,
      reason: params.signal?.reason,
    });
  };
  let resolveAborted: (() => void) | undefined;
  const aborted = new Promise<typeof SESSION_CATALOG_LIST_WAITER_ABORTED>((resolve) => {
    resolveAborted = () => resolve(SESSION_CATALOG_LIST_WAITER_ABORTED);
  });
  const onAbort = () => {
    release();
    resolveAborted?.();
  };
  params.signal?.addEventListener("abort", onAbort, { once: true });
  if (params.signal?.aborted) {
    onAbort();
  }
  try {
    const result = await (params.signal
      ? Promise.race([params.entry.result, aborted])
      : params.entry.result);
    return params.signal?.aborted ? SESSION_CATALOG_LIST_WAITER_ABORTED : result;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    release();
  }
}

function createCatalogListEntry(params: {
  cache: Map<string, CatalogListCacheEntry>;
  listKey: string;
  load: (context: {
    publish: (catalog: SessionCatalog) => void;
    signal: AbortSignal;
  }) => Promise<CatalogListResult>;
  progressSubscriber?: CatalogListProgressSubscriber;
}): { consumer: symbol; entry: CatalogListCacheEntry } {
  const consumer = Symbol("catalog-list-consumer");
  const progressSubscribers = new Map<symbol, CatalogListProgressSubscriber>();
  if (params.progressSubscriber) {
    progressSubscribers.set(consumer, params.progressSubscriber);
  }
  const abortController = new AbortController();
  const result = params.load({
    publish: (catalog) => {
      for (const subscriber of progressSubscribers.values()) {
        subscriber(catalog);
      }
    },
    signal: abortController.signal,
  });
  const entry: CatalogListCacheEntry = {
    abortController,
    consumers: new Set([consumer]),
    progressSubscribers,
    result,
    settled: false,
  };
  params.cache.set(params.listKey, entry);
  // Active entries are request owners. Evicting one would let a later caller start duplicate
  // provider work while the first owner is still running, so only settled results participate in
  // the LRU bound. Admission limits active work; the map may temporarily exceed the settled cap.
  pruneSettledCatalogLists(params.cache);
  // Exact request/config/registration results remain shareable for 3s after settling. This catches
  // out-of-phase clients but expires before the UI's 5s fast follow, so changed rows surface there.
  // Expired and rejected work is removed; retaining it would mask provider recovery or new sessions.
  void result.then(
    () => {
      entry.settled = true;
      progressSubscribers.clear();
      if (params.cache.get(params.listKey) === entry) {
        entry.expiresAt = Date.now() + SESSION_CATALOG_SHARE_WINDOW_MS;
      }
      pruneSettledCatalogLists(params.cache);
    },
    () => {
      entry.settled = true;
      progressSubscribers.clear();
      if (params.cache.get(params.listKey) === entry) {
        params.cache.delete(params.listKey);
      }
    },
  );
  return { consumer, entry };
}

export async function resolveSharedCatalogList(params: {
  config: OpenClawConfig;
  listKey: string;
  load: (context: {
    publish: (catalog: SessionCatalog) => void;
    signal: AbortSignal;
  }) => Promise<CatalogListResult>;
  progressSubscriber?: CatalogListProgressSubscriber;
  registrationIdentity: object;
  signal?: AbortSignal;
}): Promise<CatalogListResult | typeof SESSION_CATALOG_LIST_WAITER_ABORTED> {
  if (params.signal?.aborted) {
    return SESSION_CATALOG_LIST_WAITER_ABORTED;
  }
  const cache = catalogListCache(params.config, params.registrationIdentity);
  const cached = cache.get(params.listKey);
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > Date.now())) {
    cache.delete(params.listKey);
    cache.set(params.listKey, cached);
    return await waitForCatalogListEntry({
      cache,
      entry: cached,
      listKey: params.listKey,
      signal: params.signal,
      progressSubscriber: params.progressSubscriber,
    });
  }
  if (cached) {
    cache.delete(params.listKey);
  }
  const { consumer, entry } = createCatalogListEntry({
    cache,
    listKey: params.listKey,
    load: params.load,
    progressSubscriber: params.progressSubscriber,
  });
  return await waitForCatalogListEntry({
    cache,
    entry,
    listKey: params.listKey,
    signal: params.signal,
    progressSubscriber: params.progressSubscriber,
    consumer,
  });
}
