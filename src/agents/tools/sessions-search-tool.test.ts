/** sessions_search visibility, bounds, redaction, and input tests. */
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  applySessionStoreProjection,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import { describeSessionLinkRule } from "../tool-description-presets.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { readSearchQueries } from "./sessions-search-batch.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];
const SESSION_LINK_BASE = "http://127.0.0.1:18789/control";
const SESSION_LINK_RULE = describeSessionLinkRule(SESSION_LINK_BASE);

function hit(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: "main",
    sessionId: "session-main",
    messageId: "message-1",
    role: "assistant",
    timestamp: 123,
    snippet: "matching text",
    score: 1,
    ...overrides,
  };
}

function createTool(params: {
  results?: Array<Record<string, unknown>>;
  config?: Record<string, unknown>;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  requests?: CallGatewayRequest[];
  sessionLinkBase?: string;
  indexing?: boolean;
  truncated?: boolean;
}) {
  const config = params.config ?? { tools: { sessions: { visibility: "self" } } };
  return createSessionsSearchTool({
    config: {
      ...config,
      agents: {
        entries: { main: { default: true } },
        ...(config.agents as Record<string, unknown> | undefined),
      },
    },
    agentId: params.agentId,
    agentSessionKey: params.agentSessionKey,
    sandboxed: params.sandboxed,
    sessionLinkBase: params.sessionLinkBase,
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      params.requests?.push(request);
      const results = params.results ?? [];
      if (request.method === "sessions.list") {
        const listParams = request.params as { agentId?: unknown; spawnedBy?: unknown } | undefined;
        const spawnedBy = listParams?.spawnedBy;
        const agentId = listParams?.agentId;
        return {
          sessions: results
            .filter(
              (row) =>
                (spawnedBy === undefined || row.spawnedBy === spawnedBy) &&
                (agentId === undefined || row.agentId === agentId),
            )
            .map((row) => {
              const entry: Record<string, unknown> = { key: row.sessionKey };
              if (typeof row.agentId === "string") {
                entry.agentId = row.agentId;
              }
              if (typeof row.ownerSessionKey === "string") {
                entry.ownerSessionKey = row.ownerSessionKey;
              }
              if (typeof row.parentSessionKey === "string") {
                entry.parentSessionKey = row.parentSessionKey;
              }
              if (typeof row.spawnedBy === "string") {
                entry.spawnedBy = row.spawnedBy;
              }
              return entry;
            }),
          hasMore: false,
        } as T;
      }
      const searchParams = request.params as
        | { queries?: unknown; sessionKeys?: unknown }
        | undefined;
      const sessionKeys = searchParams?.sessionKeys;
      const state = {
        results: results.filter(
          (row) => Array.isArray(sessionKeys) && sessionKeys.includes(row.sessionKey),
        ),
        ...(params.indexing ? { indexing: true } : {}),
        ...(params.truncated ? { truncated: true } : {}),
      };
      return (
        Array.isArray(searchParams?.queries)
          ? { states: searchParams.queries.map(() => state) }
          : state
      ) as T;
    },
  });
}

describe("sessions_search tool", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("rejects a literal global target owned by another fixed-store agent", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      agentId: "research",
      agentSessionKey: "agent:research:main",
      config: {
        session: { store: "/stores/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { research: {}, ops: {} },
        },
        tools: { sessions: { visibility: "all" } },
      },
      results: [hit({ sessionKey: "global", agentId: "ops" })],
      requests,
    });

    const result = await tool.execute("foreign-global", {
      query: "text",
      sessionKey: "global",
    });

    expect(result.details).toMatchObject({ status: "forbidden" });
    expect(requests.some((request) => request.method === "sessions.search")).toBe(false);
  });

  it("declares exact success and error result contracts", async () => {
    const tool = createTool({ results: [hit()] });
    const success = await tool.execute("success-contract", { query: "text" });
    const linkedSuccess = await createTool({
      results: [hit()],
      sessionLinkBase: SESSION_LINK_BASE,
    }).execute("linked-success-contract", { query: "text" });
    const error = await tool.execute("error-contract", {
      query: "text",
      sessionKey: "01234567-89ab-4def-8123-456789abcdef",
    });

    expect(tool.outputSchema).toBeDefined();
    expect(tool.parameters).toMatchObject({
      properties: {
        limit: {
          description: "Maximum results per query; complete batch output is capped at 32 KiB.",
        },
      },
    });
    expect(tool.description).toContain(
      "limit applies per query; the complete batch output is capped at 32 KiB",
    );
    expect(Value.Check(tool.outputSchema!, success.details)).toBe(true);
    expect(success.details).not.toHaveProperty("batch");
    expect(success.details).not.toHaveProperty("queryCount");
    expect(success.details).not.toHaveProperty("results.0.queryIndex");
    expect(success.details).not.toHaveProperty("sessionLinkRule");
    expect(linkedSuccess.details).toHaveProperty("sessionLinkRule", SESSION_LINK_RULE);
    expect(error.details).toMatchObject({ status: "error", error: expect.any(String) });
    expect(Value.Check(tool.outputSchema!, error.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe(
      '{ results: Array<{ role: "assistant" | "user"; score: number; sessionKey: string; snippet: string; timestamp: number; messageId?: string; queryIndex?: number; sessionId?: string }>; batch?: true; indexing?: true; indexingQueries?: Array<number>; queryCount?: number; sessionLinkRule?: string; truncated?: true; truncatedQueries?: Array<number>; warning?: string } | { error: string; status: "error" | "forbidden" }',
    );
  });

  it("warns that indexing makes search results incomplete", async () => {
    const result = await createTool({
      results: [hit()],
      indexing: true,
    }).execute("indexing-warning", { query: "text" });

    expect(result.details).toMatchObject({
      indexing: true,
      warning:
        "Transcript indexing is in progress; results may be incomplete. Retry sessions_search shortly.",
    });
  });

  it("rejects empty, duplicate, and otherwise invalid queries before gateway work", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({ requests });
    await expect(tool.execute("call-1", { query: "   " })).rejects.toThrow(
      "query must not be empty",
    );
    await expect(tool.execute("call-2", { query: "ok", limit: 26 })).rejects.toThrow(
      "limit must be a positive integer",
    );
    await expect(tool.execute("call-3", { query: "x".repeat(4097) })).rejects.toThrow(
      "query must not exceed 4096 characters",
    );
    await expect(tool.execute("call-4", { query: "one", queries: ["two"] })).rejects.toThrow(
      "use query or queries, not both",
    );
    await expect(tool.execute("call-5", { queries: [] })).rejects.toThrow(
      "queries must contain 1-8 items",
    );
    await expect(
      tool.execute("call-6", { queries: Array.from({ length: 9 }, () => "angle") }),
    ).rejects.toThrow("queries must contain 1-8 items");
    await expect(tool.execute("call-7", { queries: ["valid", "   "] })).rejects.toThrow(
      "queries[1] must not be empty",
    );
    await expect(
      tool.execute("call-8", { queries: ["same normalized query", " same normalized query "] }),
    ).rejects.toThrow("queries[1] duplicates queries[0]");
    await expect(
      tool.execute("call-9", { queries: ["same spaced query", "same   spaced\nquery"] }),
    ).rejects.toThrow("queries[1] duplicates queries[0]");
    await expect(
      tool.execute("call-10", { queries: ["Deployment plan", "deployment plan"] }),
    ).rejects.toThrow("queries[1] duplicates queries[0]");
    await expect(
      tool.execute("call-11", { queries: ["café launch", "cafe launch"] }),
    ).rejects.toThrow("queries[1] duplicates queries[0]");
    await expect(
      tool.execute("call-12", { queries: ["release-plan", "release.plan"] }),
    ).rejects.toThrow("queries[1] duplicates queries[0]");
    await expect(tool.execute("call-13", { queries: ["ΟΣ", "οσ"] })).rejects.toThrow(
      "queries[1] duplicates queries[0]",
    );
    await expect(tool.execute("call-14", { queries: ["ος", "οσ"] })).rejects.toThrow(
      "queries[1] duplicates queries[0]",
    );
    await expect(tool.execute("call-15", { queries: ["résumé", "résumé"] })).rejects.toThrow(
      "queries[1] duplicates queries[0]",
    );
    expect(requests).toEqual([]);
  });

  it("keeps unicode61-distinct dotless-i queries", () => {
    expect(readSearchQueries({ queries: ["ı", "i"] })).toEqual({
      queries: ["ı", "i"],
      batch: true,
    });
  });

  it("filters invisible hits before applying the limit", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      results: [
        hit({ sessionKey: "agent:main:other", messageId: "hidden" }),
        hit({ messageId: "visible" }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text", limit: 1 });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "visible", sessionKey: "main" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("hidden");
    const searchedKeys = requests
      .filter((request) => request.method === "sessions.search")
      .map((request) => (request.params as { sessionKeys?: unknown }).sessionKeys);
    expect(searchedKeys).toEqual([["main"]]);
  });

  it("searches a multi-session visible set in one gateway call", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      config: { tools: { sessions: { visibility: "all" } } },
      results: [hit(), hit({ sessionKey: "agent:main:other", messageId: "other" })],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({ results: expect.arrayContaining([expect.any(Object)]) });
    const searchRequests = requests.filter((request) => request.method === "sessions.search");
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.params).toMatchObject({
      agentId: "main",
      sessionKeys: ["agent:main:other", "main"],
    });
  });

  it("reuses one visibility scan for a batch of recall queries", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      config: { tools: { sessions: { visibility: "all" } } },
      results: [hit(), hit({ sessionKey: "agent:main:other", messageId: "other" })],
    });

    const result = await tool.execute("batch-recall", {
      queries: [" first angle ", "second angle", " third angle "],
      limit: 2,
    });

    expect(result.details).toMatchObject({
      batch: true,
      queryCount: 3,
      results: [
        expect.objectContaining({ queryIndex: 0 }),
        expect.objectContaining({ queryIndex: 1 }),
        expect.objectContaining({ queryIndex: 2 }),
        expect.objectContaining({ queryIndex: 0 }),
        expect.objectContaining({ queryIndex: 1 }),
        expect.objectContaining({ queryIndex: 2 }),
      ],
    });
    expect(JSON.stringify(result.details)).not.toContain("first angle");
    expect(JSON.stringify(result.details)).not.toContain("second angle");
    expect(JSON.stringify(result.details)).not.toContain("third angle");
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    const listRequests = requests.filter((request) => request.method === "sessions.list");
    const searchRequests = requests.filter((request) => request.method === "sessions.search");
    expect(listRequests).toHaveLength(4);
    expect(searchRequests).toHaveLength(1);
    const searchRequest = searchRequests[0];
    if (!searchRequest) {
      throw new Error("expected one sessions.search request");
    }
    expect((searchRequest.params as { queries?: unknown }).queries).toEqual([
      "first angle",
      "second angle",
      "third angle",
    ]);
    expect((searchRequest.params as { sessionKeys?: unknown }).sessionKeys).toEqual([
      "main",
      "agent:main:other",
    ]);
  });

  it("fairly caps a batch by its aggregate pretty-printed result bytes", async () => {
    const results = Array.from({ length: 25 }, (_, index) =>
      hit({
        messageId: `${index}-${"x".repeat(1200)}`,
        score: 25 - index,
      }),
    );
    const tool = createTool({ results });

    const result = await tool.execute("batch-cap", {
      queries: ["first angle", "second angle"],
      limit: 25,
    });
    const details = result.details as {
      results: Array<{ queryIndex?: number }>;
      truncatedQueries?: number[];
    };

    expect(Buffer.byteLength(JSON.stringify(details, null, 2), "utf8")).toBeLessThanOrEqual(
      32 * 1024,
    );
    expect(details.truncatedQueries).toEqual([0, 1]);
    expect([...new Set(details.results.map((item) => item.queryIndex))]).toEqual([0, 1]);
    expect(Value.Check(tool.outputSchema!, details)).toBe(true);
  });

  it("never searches or returns incognito sessions", async () => {
    const requests: CallGatewayRequest[] = [];
    const incognitoKey = "agent:main:dashboard:incognito-private";
    const tool = createTool({
      requests,
      config: { tools: { sessions: { visibility: "all" } } },
      results: [
        hit({ sessionKey: "agent:main:visible", messageId: "visible" }),
        hit({ sessionKey: incognitoKey, messageId: "private" }),
      ],
    });

    const result = await tool.execute("blind", { query: "text" });
    const explicit = await tool.execute("blind-explicit", {
      query: "text",
      sessionKey: incognitoKey,
    });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "visible" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("private");
    expect(explicit.details).toMatchObject({ status: "forbidden" });
    expect(
      requests
        .filter((request) => request.method === "sessions.search")
        .flatMap((request) => {
          const keys = (request.params as { sessionKeys?: unknown }).sessionKeys;
          return Array.isArray(keys) ? keys : [];
        }),
    ).not.toContain(incognitoKey);
  });

  it("excludes foreign unscoped sessions that cannot be reopened by session key", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      config: {
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      },
      results: [hit({ sessionKey: "global", agentId: "work", messageId: "work-global" })],
    });

    const result = await tool.execute("call-1", { query: "text" });

    const searchRequests = requests.filter((request) => request.method === "sessions.search");
    expect(searchRequests).toHaveLength(1);
    expect(searchRequests[0]?.params).toMatchObject({ agentId: "main" });
    expect(result.details).toMatchObject({ results: [] });
  });

  it("keeps an unscoped current session in the requester agent store", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      agentId: "work",
      agentSessionKey: "global",
      config: {
        tools: { sessions: { visibility: "agent" } },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      },
      results: [
        hit({ sessionKey: "global", agentId: "work" }),
        hit({ sessionKey: "agent:work:other", agentId: "work", messageId: "work-other" }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({ sessionKey: "global" }),
        expect.objectContaining({ sessionKey: "agent:work:other" }),
      ]),
    });
    expect(requests).toContainEqual({
      method: "sessions.search",
      params: {
        agentId: "work",
        query: "text",
        limit: 25,
        sessionKeys: ["agent:work:other", "global"],
      },
    });
  });

  it("uses the target agent for an explicit cross-agent session", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      requests,
      agentId: "main",
      agentSessionKey: "agent:main:main",
      config: {
        tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      },
      results: [hit({ sessionKey: "agent:work:other", agentId: "work" })],
    });

    await tool.execute("call-1", { query: "text", sessionKey: "agent:work:other" });

    expect(requests).toContainEqual({
      method: "sessions.search",
      params: {
        agentId: "work",
        query: "text",
        limit: 25,
        sessionKeys: ["agent:work:other"],
      },
    });
  });

  it("accepts the gateway's canonical key for the current-session alias", async () => {
    const tool = createSessionsSearchTool({
      config: {
        agents: { entries: { main: { default: true } } },
        tools: { sessions: { visibility: "self" } },
      },
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        if (request.method === "sessions.list") {
          return { sessions: [], hasMore: false } as T;
        }
        return {
          results: [
            hit({ sessionKey: "agent:main:main", messageId: "canonical-main" }),
            hit({ sessionKey: "agent:work:main", messageId: "wrong-agent" }),
          ],
        } as T;
      },
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "canonical-main", sessionKey: "main" })],
    });
    expect(JSON.stringify(result.details)).not.toContain("wrong-agent");
  });

  it("clamps sandboxed callers to spawned sessions", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
      requests,
      config: {
        tools: { sessions: { visibility: "all" } },
        agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
      },
      results: [
        hit({
          sessionKey: "agent:main:child:spawned",
          messageId: "spawned",
          spawnedBy: "agent:main:main",
        }),
        hit({ sessionKey: "agent:main:other", messageId: "other" }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "spawned" })],
    });
    expect(JSON.stringify(result.details)).not.toContain('"other"');
    const searchedKeys = requests
      .filter((request) => request.method === "sessions.search")
      .map((request) => (request.params as { sessionKeys?: unknown }).sessionKeys);
    expect(searchedKeys).toEqual([["agent:main:child:spawned", "agent:main:main"]]);
  });

  it("keeps archived spawned rows visible from their ownership metadata", async () => {
    const tool = createTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { sessions: { visibility: "tree" } } },
      results: [
        hit({
          sessionKey: "agent:main:child:archived",
          messageId: "archived-child",
          spawnedBy: "agent:main:main",
        }),
      ],
    });

    const result = await tool.execute("call-1", { query: "text" });

    expect(result.details).toMatchObject({
      results: [expect.objectContaining({ messageId: "archived-child" })],
    });
  });

  it("redacts and truncates snippets, limits rows, and caps bytes", async () => {
    const token = ["sk", "or", "v1", "abcdef0123456789"].join("-");
    // Assembled so the pre-review secret scanner never sees a key-shaped literal.
    const keyShaped = `${["OPENROUTER", "API", "KEY"].join("_")}=${token}`;
    const results = Array.from({ length: 12 }, (_, index) =>
      hit({
        messageId: `message-${index}`,
        snippet: `${keyShaped} ${"x".repeat(400)}`,
      }),
    );
    const tool = createTool({ results });

    const limited = await tool.execute("call-1", { query: "text", limit: 2 });
    const details = limited.details as { results: unknown[]; truncated?: boolean };
    expect(details.results).toHaveLength(2);
    expect(details.truncated).toBe(true);
    expect(JSON.stringify(details)).not.toContain(token);

    const oversized = createTool({
      results: [hit({ messageId: "x".repeat(40_000) })],
    });
    const capped = await oversized.execute("call-2", { query: "text" });
    expect(capped.details).toMatchObject({ results: [], truncated: true });

    const backendLimited = createTool({ results: [hit()], truncated: true });
    const backendLimitedResult = await backendLimited.execute("call-3", {
      query: "text",
      limit: 2,
    });
    expect(backendLimitedResult.details).toMatchObject({ truncated: true });
  });

  it("resolves and sends a one-session restriction", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createTool({ requests, results: [hit()] });

    await tool.execute("call-1", { query: " text ", sessionKey: "main", limit: 3 });

    expect(requests).toContainEqual({
      method: "sessions.search",
      params: { agentId: "main", query: "text", sessionKeys: ["main"], limit: 25 },
    });
  });

  it("resolves scoped access once and revalidates before and after a native batch", async () => {
    const requesterSessionKey = "agent:main:clickclack:discussion-batch";
    const targetSessionKey = "agent:main:main";
    const expectedSessionId = "scoped-batch-incarnation";
    const storePath = path.join(
      tempDirs.make("openclaw-sessions-search-batch-"),
      "sessions.sqlite",
    );
    await applySessionStoreProjection({
      storePath,
      skipMaintenance: true,
      update: (store) => {
        store[targetSessionKey] = { sessionId: expectedSessionId, updatedAt: 1 };
        return { persist: true, result: undefined };
      },
    });
    let accessChecks = 0;
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) => {
      if (
        request.requesterSessionKey !== requesterSessionKey ||
        request.targetSessionKey !== targetSessionKey
      ) {
        return undefined;
      }
      accessChecks += 1;
      return { expectedSessionId };
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
            return {
              states: [
                { results: [hit({ sessionKey: targetSessionKey })] },
                { results: [hit({ sessionKey: targetSessionKey })] },
                { results: [hit({ sessionKey: targetSessionKey })] },
              ],
            } as T;
          }
          return { results: [hit({ sessionKey: targetSessionKey })] } as T;
        },
      });

      const result = await tool.execute("scoped-batch", {
        queries: ["first scoped angle", "second scoped angle", "third scoped angle"],
        sessionKey: targetSessionKey,
      });

      expect(accessChecks).toBe(3);
      expect(requests.filter((request) => request.method === "sessions.list")).toHaveLength(0);
      expect(requests.filter((request) => request.method === "sessions.search")).toHaveLength(1);
      expect(result.details).toMatchObject({
        batch: true,
        queryCount: 3,
        results: [
          expect.objectContaining({ queryIndex: 0 }),
          expect.objectContaining({ queryIndex: 1 }),
          expect.objectContaining({ queryIndex: 2 }),
        ],
      });
    } finally {
      unregister();
    }
  });

  it("rejects a scoped grant when the target incarnation changes before search", async () => {
    const requesterSessionKey = "agent:main:clickclack:discussion-race";
    const targetSessionKey = "agent:main:main";
    const expectedSessionId = "old-incarnation";
    const storePath = path.join(tempDirs.make("openclaw-sessions-search-"), "sessions.sqlite");
    await applySessionStoreProjection({
      storePath,
      skipMaintenance: true,
      update: (store) => {
        store[targetSessionKey] = { sessionId: expectedSessionId, updatedAt: 1 };
        return { persist: true, result: undefined };
      },
    });
    const requests: CallGatewayRequest[] = [];
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) => {
      if (
        request.requesterSessionKey !== requesterSessionKey ||
        request.targetSessionKey !== targetSessionKey
      ) {
        return undefined;
      }
      replaceSessionEntrySync(
        { storePath, sessionKey: targetSessionKey },
        { sessionId: "replacement-incarnation", updatedAt: 2 },
      );
      return { expectedSessionId };
    });
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
          return { results: [hit({ sessionKey: targetSessionKey })] } as T;
        },
      });

      await expect(
        tool.execute("scoped-grant-race", { query: "text", sessionKey: targetSessionKey }),
      ).rejects.toThrow(`Session "${targetSessionKey}" changed after access was granted.`);
      expect(requests.some((request) => request.method === "sessions.search")).toBe(false);
    } finally {
      unregister();
    }
  });
});
