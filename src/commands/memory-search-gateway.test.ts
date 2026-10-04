import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  canFallbackToImplicitLocalGateway: vi.fn(),
  readGatewayDispatchConfigWithShellEnvFallback: vi.fn(async () => ({})),
}));

vi.mock("../cli/gateway-rpc.js", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
  canFallbackToImplicitLocalGateway: mocks.canFallbackToImplicitLocalGateway,
}));
vi.mock("../config/gateway-dispatch-config.js", () => ({
  readGatewayDispatchConfigWithShellEnvFallback:
    mocks.readGatewayDispatchConfigWithShellEnvFallback,
}));

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
    mocks.callGatewayFromCli.mockReset();
    mocks.canFallbackToImplicitLocalGateway.mockReset().mockResolvedValue(false);
    mocks.readGatewayDispatchConfigWithShellEnvFallback.mockClear();
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
    mocks.callGatewayFromCli.mockResolvedValue({
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

    expect(mocks.callGatewayFromCli).toHaveBeenCalledWith(
      "memory.search",
      { timeout: "30000" },
      { query: "shared index", recordRecall: true, agentId: "main", maxResults: 4 },
      { mode: "cli", scopes: ["operator.read", "operator.write"] },
    );
    expect(runtime.writeJson).toHaveBeenCalledWith({ results }, 2);
  });

  it("returns false so Commander can fall back when the Gateway is unavailable", async () => {
    const error = new Error("gateway unavailable");
    mocks.callGatewayFromCli.mockRejectedValue(error);
    mocks.canFallbackToImplicitLocalGateway.mockResolvedValue(true);

    await expect(
      memorySearchGatewayCommand({ query: "offline", json: false }, createRuntime()),
    ).resolves.toBe(false);
    expect(mocks.canFallbackToImplicitLocalGateway).toHaveBeenCalledWith({
      config: {},
      error,
      legacyMethod: "memory.search",
    });
  });

  it("surfaces Gateway search and authorization failures", async () => {
    const error = new Error("missing scope: operator.write");
    mocks.callGatewayFromCli.mockRejectedValue(error);

    await expect(
      memorySearchGatewayCommand({ query: "restricted", json: false }, createRuntime()),
    ).rejects.toBe(error);
  });
});
