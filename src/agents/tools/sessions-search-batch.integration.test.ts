import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applySessionStoreProjection } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import { interleaveSearchChunks } from "./sessions-search-batch.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];

function searchHit(sessionKey: string) {
  return {
    sessionKey,
    sessionId: "session-main",
    messageId: "message-1",
    role: "assistant",
    timestamp: 123,
    snippet: "matching text",
    score: 1,
  };
}

describe("sessions_search bounded batch integration", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("revalidates a scoped provider after the only batch query before accepting hits", async () => {
    const requesterSessionKey = "agent:main:clickclack:discussion-revoked";
    const targetSessionKey = "agent:main:main";
    const expectedSessionId = "scoped-incarnation";
    const storePath = path.join(tempDirs.make("openclaw-search-revoke-"), "sessions.sqlite");
    await applySessionStoreProjection({
      storePath,
      skipMaintenance: true,
      update: (store) => {
        store[targetSessionKey] = { sessionId: expectedSessionId, updatedAt: 1 };
        return { persist: true, result: undefined };
      },
    });
    let revoked = false;
    let accessChecks = 0;
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) => {
      if (
        request.requesterSessionKey !== requesterSessionKey ||
        request.targetSessionKey !== targetSessionKey
      ) {
        return undefined;
      }
      accessChecks += 1;
      return revoked ? undefined : { expectedSessionId };
    });
    const requests: CallGatewayRequest[] = [];
    try {
      const tool = createSessionsSearchTool({
        agentSessionKey: requesterSessionKey,
        sandboxed: true,
        config: {
          session: { store: storePath },
          tools: { sessions: { visibility: "self" } },
          agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
        } as OpenClawConfig,
        callGateway: async <T = Record<string, unknown>>(
          request: CallGatewayRequest,
        ): Promise<T> => {
          requests.push(request);
          if (request.method === "sessions.search") {
            revoked = true;
            return { states: [{ results: [searchHit(targetSessionKey)] }] } as T;
          }
          return { results: [searchHit(targetSessionKey)] } as T;
        },
      });

      await expect(
        tool.execute("revoked-batch", {
          queries: ["only scoped angle"],
          sessionKey: targetSessionKey,
        }),
      ).rejects.toThrow(/restricted|not visible|denied/u);

      expect(accessChecks).toBe(3);
      expect(requests.filter((request) => request.method === "sessions.search")).toHaveLength(1);
    } finally {
      unregister();
    }
  });

  it("observes cancellation after the only batch Gateway request", async () => {
    const controller = new AbortController();
    const requests: CallGatewayRequest[] = [];
    const targetSessionKey = "agent:main:main";
    const tool = createSessionsSearchTool({
      agentId: "main",
      agentSessionKey: targetSessionKey,
      config: { tools: { sessions: { visibility: "self" } } },
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        if (request.method === "sessions.search") {
          controller.abort();
          return { states: [{ results: [searchHit(targetSessionKey)] }] } as T;
        }
        return { results: [searchHit(targetSessionKey)] } as T;
      },
    });

    await expect(
      tool.execute(
        "cancelled-batch",
        { queries: ["only angle"], sessionKey: targetSessionKey },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    const searchRequests = requests.filter((request) => request.method === "sessions.search");
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.signal).toBe(controller.signal);
  });

  it("checks cancellation again before returning the only-query payload", async () => {
    const controller = new AbortController();
    const targetSessionKey = "agent:main:main";
    const lazyHit = searchHit(targetSessionKey);
    Object.defineProperty(lazyHit, "sessionKey", {
      configurable: true,
      enumerable: true,
      get: () => {
        controller.abort();
        return targetSessionKey;
      },
    });
    const tool = createSessionsSearchTool({
      agentId: "main",
      agentSessionKey: targetSessionKey,
      config: { tools: { sessions: { visibility: "self" } } },
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> =>
        (request.method === "sessions.search"
          ? { states: [{ results: [lazyHit] }] }
          : { results: [] }) as T,
    });

    await expect(
      tool.execute(
        "cancelled-before-final",
        { queries: ["only angle"], sessionKey: targetSessionKey },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects malformed native and legacy states instead of returning an empty success", async () => {
    const targetSessionKey = "agent:main:main";
    const tool = createSessionsSearchTool({
      agentId: "main",
      agentSessionKey: targetSessionKey,
      config: { tools: { sessions: { visibility: "self" } } },
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        if (request.method !== "sessions.search") {
          return { results: [] } as T;
        }
        const params = request.params as { queries?: unknown } | undefined;
        return (Array.isArray(params?.queries) ? { states: [{}] } : {}) as T;
      },
    });

    await expect(
      tool.execute("malformed-batch", {
        queries: ["only angle"],
        sessionKey: targetSessionKey,
      }),
    ).rejects.toThrow("sessions.search returned an invalid response");
    await expect(
      tool.execute("malformed-legacy", {
        query: "only angle",
        sessionKey: targetSessionKey,
      }),
    ).rejects.toThrow("sessions.search returned an invalid response");
  });

  it("round-robins discovery views and caps batch search work", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsSearchTool({
      agentId: "main",
      agentSessionKey: "agent:main:requester",
      config: { tools: { sessions: { visibility: "all" } } },
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        if (request.method === "sessions.list") {
          const listParams = request.params as
            | { agentId?: unknown; archived?: unknown; offset?: unknown }
            | undefined;
          const offset = Number(listParams?.offset ?? 0);
          const archived = listParams?.archived === true;
          const agentId = typeof listParams?.agentId === "string" ? listParams.agentId : undefined;
          const view = `${agentId ? "unscoped" : "combined"}-${archived ? "archived" : "active"}`;
          return {
            sessions: Array.from({ length: 200 }, (_, index) => ({
              key: agentId ? `${view}-${offset + index}` : `agent:main:${view}-${offset + index}`,
              agentId: "main",
            })),
            hasMore: true,
            nextOffset: offset + 200,
          } as T;
        }
        return {
          states: Array.from({ length: 8 }, () => ({ results: [] })),
        } as T;
      },
    });

    const result = await tool.execute("bounded-batch", {
      queries: Array.from({ length: 8 }, (_, index) => `angle ${index}`),
    });

    const listRequests = requests.filter((request) => request.method === "sessions.list");
    expect(listRequests).toHaveLength(16);
    expect(
      listRequests.slice(0, 4).map((request) => {
        const params = request.params as
          | { agentId?: unknown; archived?: unknown; offset?: unknown }
          | undefined;
        return {
          agentId: params?.agentId,
          archived: params?.archived,
          offset: params?.offset,
        };
      }),
    ).toEqual([
      { agentId: undefined, archived: false, offset: 0 },
      { agentId: undefined, archived: true, offset: 0 },
      { agentId: "main", archived: false, offset: 0 },
      { agentId: "main", archived: true, offset: 0 },
    ]);
    const searchRequests = requests.filter((request) => request.method === "sessions.search");
    expect(searchRequests).toHaveLength(6);
    const searchedKeys = searchRequests.flatMap((request) => {
      const sessionKeys = (request.params as { sessionKeys?: unknown } | undefined)?.sessionKeys;
      return Array.isArray(sessionKeys) ? sessionKeys : [];
    });
    expect(searchedKeys).toEqual(
      expect.arrayContaining([
        expect.stringContaining("combined-active"),
        expect.stringContaining("combined-archived"),
        expect.stringContaining("unscoped-active"),
        expect.stringContaining("unscoped-archived"),
      ]),
    );
    expect(result.details).toMatchObject({
      batch: true,
      queryCount: 8,
      truncated: true,
      truncatedQueries: [0, 1, 2, 3, 4, 5, 6, 7],
    });
  });

  it("interleaves agent chunks before returning to a large store", () => {
    const chunks = interleaveSearchChunks(
      [
        ["main", Array.from({ length: 401 }, (_, index) => index)],
        ["research", [900]],
      ],
      200,
    );

    expect(chunks.map(({ groupKey, items }) => [groupKey, items[0], items.length])).toEqual([
      ["main", 0, 200],
      ["research", 900, 1],
      ["main", 200, 200],
      ["main", 400, 1],
    ]);
  });
});
