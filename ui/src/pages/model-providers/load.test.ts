import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelProvidersData } from "./load.ts";
import { loadModelProvidersData, loadRouteData } from "./load.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("loadModelProvidersData", () => {
  it("keeps full catalog discovery out of the initial page load", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    await loadModelProvidersData(client, { agentId: "writer" });

    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "writer",
      preparedOnly: true,
    });
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "models.list" && (params as { view?: string } | undefined)?.view === "all",
      ),
    ).toHaveLength(0);
    const sessionUsageCalls = request.mock.calls.filter(([method]) => method === "sessions.usage");
    expect(sessionUsageCalls).toHaveLength(1);
    expect(sessionUsageCalls[0]?.[1]).toMatchObject({
      limit: 1,
      includeContextWeight: false,
    });
  });

  it("scopes only credential status to the selected agent", async () => {
    const request = vi.fn(async (method: string, _params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(request).toHaveBeenCalledWith(
      "models.authStatus",
      {
        refresh: true,
        agentId: "writer",
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(request).toHaveBeenCalledWith("models.list", {
      view: "all",
      agentId: "writer",
      refresh: true,
    });
    expect(request).toHaveBeenCalledWith("models.list", {
      view: "configured",
      agentId: "writer",
      refresh: true,
    });
    expect(request).toHaveBeenCalledWith("usage.status");
    const sessionUsageCall = request.mock.calls.find(([method]) => method === "sessions.usage");
    expect(sessionUsageCall?.[1]).not.toHaveProperty("agentId");
    expect(sessionUsageCall?.[1]).toHaveProperty("agentScope", "all");
  });

  it.each([
    { label: "the initial prepared catalog", refresh: false },
    { label: "the configured catalog after discovery", refresh: true },
  ])("surfaces a failure loading $label without discarding provider data", async ({ refresh }) => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      switch (method) {
        case "models.authStatus":
          return {
            ts: 1,
            providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles: [] }],
          };
        case "models.list":
          if ((params as { view?: string } | undefined)?.view === "all") {
            return { providerOutcomes: [] };
          }
          throw new Error("configured catalog unavailable: OPENAI_API_KEY=sk-1234567890abcdef");
        case "config.get":
          return {
            config: { agents: { defaults: { model: "openai/gpt-5.5" } } },
            hash: "hash",
          };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main", refresh });

    expect(result.models).toBeNull();
    expect(result.catalogError).toBe(
      "configured catalog unavailable: OPENAI_API_KEY=sk-123...cdef",
    );
    expect(result.authStatus?.providers).toHaveLength(1);
    expect(result.config).toEqual({ agents: { defaults: { model: "openai/gpt-5.5" } } });
    expect(result.error).toBeNull();
  });

  it("degrades an invalid auth-status response without discarding other provider data", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return {};
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main" });

    expect(result.authStatus).toBeNull();
    expect(result.models).toEqual([]);
    expect(result.providerOutcomes).toEqual([]);
    expect(result.catalogError).toBeNull();
    expect(result.config).toEqual({});
    expect(result.providerUsage).toEqual({ ok: true, value: { updatedAt: 1, providers: [] } });
    expect(result.costByProvider).toEqual([]);
    expect(result.error).toBeNull();
  });

  it("records a usage.status failure instead of reducing it to no data", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          throw new Error("usage.status failed");
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main" });

    expect(result.providerUsage).toEqual({
      ok: false,
      error: { kind: "request-failed" },
    });
    expect(result.error).toBeNull();
  });

  it("keeps provider-scoped usage errors as data instead of a global request failure", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [] };
        case "models.list":
          return { models: [] };
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return {
            updatedAt: 1,
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                windows: [],
                error: "provider API unavailable",
              },
            ],
          };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;

    const result = await loadModelProvidersData(client, { agentId: "main" });

    expect(result.providerUsage).toMatchObject({
      ok: true,
      value: { providers: [{ error: "provider API unavailable" }] },
    });
  });

  it("surfaces an explicit catalog refresh failure while retaining cached configured models", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "models.list" && (params as { view?: string } | undefined)?.view === "all") {
        throw new Error("catalog refresh failed: OPENAI_API_KEY=sk-1234567890abcdef");
      }
      switch (method) {
        case "models.authStatus":
          return { ts: 1, providers: [], providerCapabilities: [] };
        case "models.list":
          if ((params as { preparedOnly?: boolean } | undefined)?.preparedOnly === true) {
            return {
              models: [{ id: "cached", name: "Cached", provider: "openai" }],
            };
          }
          throw new Error("configured discovery repeated after refresh failure");
        case "config.get":
          return { config: {}, hash: "hash" };
        case "usage.status":
          return { updatedAt: 1, providers: [] };
        case "sessions.usage":
          return { aggregates: { byProvider: [] } };
        default:
          return {};
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;
    await loadModelProvidersData(client, { agentId: "writer" });
    request.mockClear();

    const result = await loadModelProvidersData(client, { refresh: true, agentId: "writer" });

    expect(result.catalogError).toBe("catalog refresh failed: OPENAI_API_KEY=sk-123...cdef");
    expect(result.models).toEqual([{ id: "cached", name: "Cached", provider: "openai" }]);
    expect(
      request.mock.calls.filter(
        ([method, params]) =>
          method === "models.list" &&
          (params as { view?: string } | undefined)?.view === "configured",
      ),
    ).toHaveLength(0);
  });
});

describe("loadRouteData", () => {
  const data = { updatedAt: 1 } as ModelProvidersData;

  it("shares an in-flight load and its immediate default-agent revalidation", async () => {
    const client = {} as GatewayBrowserClient;
    const pending = deferred<ModelProvidersData>();
    const load = vi.fn(() => pending.promise);
    let now = 1_000;

    const first = loadRouteData(client, "main", () => now, load);
    const joined = loadRouteData(client, "main", () => now, load);
    expect(joined).toBe(first);
    expect(load).toHaveBeenCalledOnce();

    pending.resolve(data);
    await first;
    now += 999;
    await expect(loadRouteData(client, "main", () => now, load)).resolves.toBe(data);
    expect(load).toHaveBeenCalledOnce();

    now += 2;
    await loadRouteData(client, "main", () => now, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not share across clients or agents and retries a rejected load", async () => {
    const firstClient = {} as GatewayBrowserClient;
    const secondClient = {} as GatewayBrowserClient;
    const failure = deferred<ModelProvidersData>();
    const failingLoad = vi.fn(() => failure.promise);
    const failed = loadRouteData(firstClient, "main", Date.now, failingLoad);
    failure.reject(new Error("failed"));
    await expect(failed).rejects.toThrow("failed");

    const retry = vi.fn(async () => data);
    await loadRouteData(firstClient, "main", Date.now, retry);
    await loadRouteData(firstClient, "writer", Date.now, retry);
    await loadRouteData(secondClient, "main", Date.now, retry);
    expect(retry).toHaveBeenCalledTimes(3);
  });
});
