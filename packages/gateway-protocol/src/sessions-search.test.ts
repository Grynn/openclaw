import { describe, expect, it } from "vitest";
import {
  validateSessionsSearchBatchResult,
  validateSessionsSearchParams,
  type ProtocolValidator,
} from "./index.js";

function expectValidationCases(
  validate: ProtocolValidator,
  expected: boolean,
  values: readonly unknown[],
) {
  for (const value of values) {
    expect(validate(value)).toBe(expected);
  }
}

const expectAccepted = (validate: ProtocolValidator, values: readonly unknown[]) =>
  expectValidationCases(validate, true, values);
const expectRejected = (validate: ProtocolValidator, values: readonly unknown[]) =>
  expectValidationCases(validate, false, values);

describe("session transcript search protocol", () => {
  it("validates mutually exclusive bounded query params", () => {
    const search = (overrides: Record<string, unknown> = {}) => ({
      query: "deployment failure",
      ...overrides,
    });
    expectAccepted(validateSessionsSearchParams, [
      search(),
      search({
        agentId: "work",
        sessionKeys: ["agent:work:main", "agent:work:other"],
        limit: 25,
      }),
      {
        agentId: "work",
        sessionKeys: ["agent:work:main"],
        queries: ["deployment failure", "rollback plan"],
        limit: 25,
      },
    ]);
    expectRejected(validateSessionsSearchParams, [
      search({ agentId: "" }),
      search({ sessionKey: "agent:work:main" }),
      search({ sessionKeys: [] }),
      search({
        sessionKeys: Array.from({ length: 201 }, (_, index) => `session-${index}`),
      }),
      search({ limit: 26 }),
      search({ queries: ["rollback plan"] }),
      { queries: [] },
      { queries: Array.from({ length: 9 }, (_, index) => `query-${index}`) },
      { queries: [""] },
      { queries: ["x".repeat(4097)] },
      {},
      { query: "" },
      { query: "x".repeat(4097) },
    ]);
  });

  it("validates ordered batch result states", () => {
    const hit = {
      sessionKey: "agent:work:main",
      sessionId: "session-work",
      messageId: "message-1",
      role: "assistant",
      timestamp: 123,
      snippet: "deployment failed",
      score: 1,
    };
    expectAccepted(validateSessionsSearchBatchResult, [
      { states: [{ results: [hit] }, { results: [], indexing: true, truncated: true }] },
    ]);
    expectRejected(validateSessionsSearchBatchResult, [
      { results: [hit] },
      { states: [] },
      { states: Array.from({ length: 9 }, () => ({ results: [] })) },
      { states: [{ results: [], queryIndex: 0 }] },
    ]);
  });
});
