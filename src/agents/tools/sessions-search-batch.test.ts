import { Value } from "typebox/value";
import { expect, it } from "vitest";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";

const main = "agent:main:main";
const queries = Array.from({ length: 8 }, (_, index) => `query-${index}`);
type Request = Parameters<AgentToolGatewayRequestCaller>[0];

function tool(callGateway: AgentToolGatewayRequestCaller, discovery = false) {
  return createSessionsSearchTool({
    agentId: "main",
    agentSessionKey: main,
    ...(discovery ? {} : { sessionReadScopeKey: main }),
    sessionLinkBase: "https://gateway.example.test/control",
    config: {
      agents: { entries: { main: {}, work: {} } },
      tools: { sessions: { visibility: discovery ? "all" : "self" } },
    },
    callGateway,
  });
}

function hit(messageId: string) {
  return {
    sessionKey: main,
    sessionId: "current-session",
    messageId,
    role: "user",
    timestamp: 1,
    snippet: "matching text",
    score: 1,
  };
}

it("bounds the actual pretty-printed batch envelope and preserves per-query status and fairness", async () => {
  const search = tool(
    async <T>() =>
      ({
        states: queries.map((_, queryIndex) => ({
          results: Array.from({ length: 25 }, (_item, index) =>
            hit(
              queryIndex === 0 && index === 0
                ? "x".repeat(40_000)
                : `${queryIndex}-${index}-${"界".repeat(500)}`,
            ),
          ),
          indexing: queryIndex === 1,
          archivedTranscriptsExcluded: 3,
          truncated: queryIndex === 2,
        })),
      }) as T,
  );
  const result = await search.execute("batch-envelope", { queries, limit: 25 });
  expect(result.details).toMatchObject({
    batch: true,
    queryCount: 8,
    indexingQueries: [1],
    archivedTranscriptsExcluded: 3,
    truncated: true,
    truncatedQueries: queries.map((_, index) => index),
  });
  expect(Value.Check(search.outputSchema!, result.details)).toBe(true);
  const text = result.content.find((block) => block.type === "text");
  expect(text?.type).toBe("text");
  if (text?.type !== "text") {
    throw new Error("Expected JSON tool result");
  }
  expect(Buffer.byteLength(text.text, "utf8")).toBeLessThanOrEqual(32 * 1024);
  const parsed = JSON.parse(text.text) as {
    results: Array<{ queryIndex: number; messageId: string }>;
  };
  expect(new Set(parsed.results.map((item) => item.queryIndex))).toEqual(
    new Set(queries.map((_, index) => index)),
  );
  expect(parsed.results.some((item) => item.messageId.length === 40_000)).toBe(false);
});

it("rotates active/archive discovery and agent reads within batch work budgets", async () => {
  const requests: Request[] = [];
  const search = tool(async <T>(request: Request): Promise<T> => {
    requests.push(request);
    if (request.method === "sessions.list") {
      const params = request.params as { archived: boolean; offset: number; agentId?: string };
      if (params.archived) {
        return {
          sessions: [{ key: params.agentId ? "global" : "agent:work:archived" }],
          hasMore: false,
        } as T;
      }
      return {
        sessions: Array.from({ length: 200 }, (_, index) => ({
          key: `agent:main:row-${params.offset + index}`,
        })),
        hasMore: true,
        nextOffset: params.offset + 200,
      } as T;
    }
    return { states: queries.map(() => ({ results: [] })) } as T;
  }, true);
  const result = await search.execute("batch-budget", { queries });
  const lists = requests.filter((request) => request.method === "sessions.list");
  expect(lists).toHaveLength(16);
  expect(lists.slice(0, 4).map((request) => request.params)).toMatchObject([
    { archived: false },
    { archived: true },
    { agentId: "main", archived: false },
    { agentId: "main", archived: true },
  ]);
  const reads = requests.filter((request) => request.method === "sessions.search");
  expect(reads).toHaveLength(6);
  expect(reads[0]?.params).toMatchObject({ agentId: "main", queries });
  expect(reads[1]?.params).toMatchObject({ agentId: "work", sessionKeys: ["agent:work:archived"] });
  expect(result.details).toMatchObject({
    results: [],
    truncatedQueries: queries.map((_, index) => index),
  });
});

it.each(["before", "after"] as const)(
  "cancels %s the only batch read without returning buffered results",
  async (when) => {
    const controller = new AbortController();
    let calls = 0;
    const search = tool(async <T>(request: Request): Promise<T> => {
      calls++;
      expect(request.signal).toBe(controller.signal);
      controller.abort(new Error("search cancelled"));
      return { states: [{ results: [hit("hidden-after-cancel")] }] } as T;
    });
    if (when === "before") {
      controller.abort(new Error("search cancelled"));
    }
    await expect(
      search.execute("cancelled", { queries: ["needle"] }, controller.signal),
    ).rejects.toThrow("search cancelled");
    expect(calls).toBe(when === "before" ? 0 : 1);
  },
);

it.each([
  { queries: [] },
  { queries: Array.from({ length: 9 }, () => "needle") },
  { queries: [" "] },
  { queries: ["x".repeat(4097)] },
  { query: "needle", queries: ["other"] },
])("rejects invalid batch input before discovery: %j", async (params) => {
  const search = tool(async () => {
    throw new Error("Unexpected Gateway call");
  });
  await expect(search.execute("invalid", params)).rejects.toThrow(/query|queries/);
});

it.each([{ states: [] }, { results: [] }, { states: [{ results: [{ sessionKey: main }] }] }])(
  "does not silently turn malformed batch replies into no matches: %j",
  async (reply) => {
    const search = tool(async <T>() => reply as T);
    await expect(search.execute("malformed", { queries: ["needle"] })).rejects.toThrow(
      "Invalid sessions.search batch response",
    );
  },
);
