import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.hoisted(() => vi.fn());

vi.mock("../cli/gateway-rpc.js", () => ({ callGatewayFromCli }));

import { memorySearchGatewayCommand } from "./memory-search-gateway.js";

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  };
}

describe("memorySearchGatewayCommand", () => {
  beforeEach(() => {
    callGatewayFromCli.mockReset();
  });

  it("uses the shared Gateway manager and preserves JSON output", async () => {
    const runtime = createRuntime();
    const results = [
      {
        path: "memory/2026-08-12.md",
        startLine: 2,
        endLine: 3,
        score: 0.88,
        snippet: "Use the watched shared index.",
        source: "memory",
      },
    ];
    callGatewayFromCli.mockResolvedValue({
      agentId: "main",
      provider: "openai",
      searchMode: "hybrid",
      results,
    });

    await expect(
      memorySearchGatewayCommand(
        { query: "shared index", agent: "main", maxResults: 4, json: true },
        runtime,
      ),
    ).resolves.toBe(true);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "memory.search",
      { timeout: "30000" },
      { query: "shared index", recordRecall: true, agentId: "main", maxResults: 4 },
      { mode: "cli", scopes: ["operator.read"] },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith({ results }, 2);
  });

  it("returns false so Commander can fall back when the Gateway is unavailable", async () => {
    callGatewayFromCli.mockRejectedValue(new Error("gateway unavailable"));

    await expect(
      memorySearchGatewayCommand({ query: "offline", json: false }, createRuntime()),
    ).resolves.toBe(false);
  });
});
