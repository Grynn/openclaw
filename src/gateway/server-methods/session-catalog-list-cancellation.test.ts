import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{ provider: SessionCatalogProvider }>;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  listSessionEntriesReadOnly: vi.fn(() => []),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));
vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionStateEvent: vi.fn(),
}));
vi.mock("../../sessions/session-upstream-links.js", () => ({
  upsertSessionUpstreamLink: vi.fn(),
}));
vi.mock("../../plugins/session-conversation-binding.js", () => ({
  bindPluginSessionConversation: vi.fn(),
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return { ...actual, listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly };
});
vi.mock("../../state/user-profiles.js", () => ({
  getUserProfileRole: vi.fn(() => null),
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
}));

const { sessionCatalogHandlers } = await import("./session-catalog.js");
const { resolveSharedCatalogList } = await import("./session-catalog-list-cache.js");

function provider(
  id: string,
  overrides: Partial<SessionCatalogProvider> = {},
): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("catalog aborted", { cause: signal.reason });
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    if (!signal) {
      reject(new Error("provider did not receive an abort signal"));
      return;
    }
    signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
  });
}

function startCall(
  params: unknown,
  config: Record<string, unknown> = {},
  client?: { connId?: string },
  contextOverrides: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  const respond = vi.fn();
  const completion = Promise.resolve(
    sessionCatalogHandlers["sessions.catalog.list"]?.({
      params,
      respond,
      client,
      context: { getRuntimeConfig: () => config, ...contextOverrides },
      ...(signal ? { signal } : {}),
    } as never),
  );
  return { completion, respond };
}

async function call(params: unknown, config: Record<string, unknown> = {}) {
  const pending = startCall(params, config);
  await pending.completion;
  return pending.respond;
}

describe("session catalog list cancellation", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    hoisted.listSessionEntriesReadOnly.mockReset().mockReturnValue([]);
  });

  it("stops progress frames to a disconnected leader while retaining its follower", async () => {
    const leaderController = new AbortController();
    const followerController = new AbortController();
    const gate = deferred<void>();
    const host = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const list = vi.fn(async ({ onHost }: { onHost?: (value: typeof host) => void }) => {
      await gate.promise;
      onHost?.(host);
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = {};
    const leaderBroadcast = vi.fn();
    const followerBroadcast = vi.fn();
    const leader = startCall(
      { progressId: "leader-progress" },
      config,
      { connId: "leader" },
      { broadcastToConnIds: leaderBroadcast },
      leaderController.signal,
    );
    const follower = startCall(
      { progressId: "follower-progress" },
      config,
      { connId: "follower" },
      { broadcastToConnIds: followerBroadcast },
      followerController.signal,
    );
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());

    leaderController.abort(new Error("leader socket closed"));
    await leader.completion;
    gate.resolve();
    await follower.completion;

    expect(leaderBroadcast).not.toHaveBeenCalled();
    expect(followerBroadcast).toHaveBeenCalledWith(
      "sessions.catalog.host",
      {
        progressId: "follower-progress",
        agentId: "main",
        catalog: expect.objectContaining({ id: "codex", hosts: [host] }),
      },
      new Set(["follower"]),
      { dropIfSlow: true },
    );
    expect(leader.respond).not.toHaveBeenCalled();
    expect(follower.respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
    });
  });

  it("aborts sole-requester provider work when the requester disconnects", async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const list = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      providerSignal = signal;
      await waitForAbort(signal);
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const pending = startCall({}, {}, { connId: "gone" }, {}, controller.signal);
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());

    controller.abort(new Error("socket closed"));

    await pending.completion;
    expect(providerSignal?.aborted).toBe(true);
    expect(pending.respond).not.toHaveBeenCalled();
  });

  it("does not start provider work for a request already disconnected during dispatch", async () => {
    const controller = new AbortController();
    controller.abort(new Error("socket already closed"));
    const list = vi.fn(async () => []);
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];

    const pending = startCall({}, {}, { connId: "gone" }, {}, controller.signal);
    await pending.completion;

    expect(list).not.toHaveBeenCalled();
    expect(pending.respond).not.toHaveBeenCalled();
  });

  it("keeps shared provider work alive while another requester remains", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const gate = deferred<void>();
    let providerSignal: AbortSignal | undefined;
    const list = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      providerSignal = signal;
      await gate.promise;
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = {};
    const first = startCall({}, config, { connId: "first" }, {}, firstController.signal);
    const second = startCall({}, config, { connId: "second" }, {}, secondController.signal);
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());

    firstController.abort(new Error("first socket closed"));
    await first.completion;
    expect(providerSignal?.aborted).toBe(false);
    expect(first.respond).not.toHaveBeenCalled();

    gate.resolve();
    await second.completion;
    expect(second.respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "codex", hosts: [] })],
    });
    const cached = await call({}, config);
    expect(cached).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "codex", hosts: [] })],
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it("aborts shared provider work only after every requester disconnects", async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const list = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      providerSignal = signal;
      await waitForAbort(signal);
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = {};
    const first = startCall({}, config, { connId: "first" }, {}, firstController.signal);
    const second = startCall({}, config, { connId: "second" }, {}, secondController.signal);
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());

    firstController.abort(new Error("first socket closed"));
    await first.completion;
    expect(providerSignal?.aborted).toBe(false);
    secondController.abort(new Error("second socket closed"));
    await second.completion;

    expect(providerSignal?.aborted).toBe(true);
    expect(first.respond).not.toHaveBeenCalled();
    expect(second.respond).not.toHaveBeenCalled();
  });

  it("does not let an abandoned entry's late settlement replace newer cached work", async () => {
    const controller = new AbortController();
    const abandonedGate = deferred<void>();
    const abandonedFinished = deferred<void>();
    const oldHost = {
      hostId: "old",
      label: "Old",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const freshHost = { ...oldHost, hostId: "fresh", label: "Fresh" };
    let calls = 0;
    const list = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await abandonedGate.promise;
        abandonedFinished.resolve();
        return [oldHost];
      }
      return [freshHost];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = {};
    const abandoned = startCall({}, config, { connId: "gone" }, {}, controller.signal);
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    controller.abort(new Error("socket closed"));
    await abandoned.completion;

    const replacement = await call({}, config);
    expect(replacement).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ hosts: [freshHost] })],
    });
    abandonedGate.resolve();
    await abandonedFinished.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const cached = await call({}, config);
    expect(cached).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ hosts: [freshHost] })],
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("never evicts an active owner during more-than-capacity settled-key churn", async () => {
    const gate = deferred<void>();
    const config = {} as OpenClawConfig;
    const registrationIdentity = {};
    const ownerLoad = vi.fn(async () => {
      await gate.promise;
      return { catalogs: [] };
    });
    const owner = resolveSharedCatalogList({
      config,
      listKey: "active-owner",
      load: ownerLoad,
      registrationIdentity,
    });
    await vi.waitFor(() => expect(ownerLoad).toHaveBeenCalledOnce());

    for (let index = 0; index < 160; index += 1) {
      await resolveSharedCatalogList({
        config,
        listKey: `settled-${String(index)}`,
        load: async () => ({ catalogs: [] }),
        registrationIdentity,
      });
    }
    const follower = resolveSharedCatalogList({
      config,
      listKey: "active-owner",
      load: ownerLoad,
      registrationIdentity,
    });

    expect(ownerLoad).toHaveBeenCalledOnce();
    gate.resolve();
    await expect(Promise.all([owner, follower])).resolves.toEqual([
      { catalogs: [] },
      { catalogs: [] },
    ]);
  });
});
