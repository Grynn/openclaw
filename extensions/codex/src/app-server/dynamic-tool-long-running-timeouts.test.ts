import { describe, expect, it } from "vitest";
import { resolveDynamicToolCallTimeoutMs } from "./dynamic-tool-execution.js";

const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;

describe("long-running dynamic tool timeout resolution", () => {
  it("gives agents_wait the long-running cap while preserving its inner timeout budget", () => {
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-agents-wait",
      namespace: null,
      tool: "agents_wait",
    };

    expect(
      resolveDynamicToolCallTimeoutMs({
        call: { ...call, arguments: { ids: ["run-1"] } },
        config: undefined,
      }),
    ).toBe(630_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: { ...call, arguments: { ids: ["run-1"], timeoutSeconds: 120 } },
        config: undefined,
      }),
    ).toBe(150_000);
    const fullWaitTimeoutMs = resolveDynamicToolCallTimeoutMs({
      call: { ...call, arguments: { ids: ["run-1"], timeoutSeconds: 600 } },
      config: undefined,
    });
    expect(fullWaitTimeoutMs).toBe(630_000);
    expect(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS).toBeGreaterThan(fullWaitTimeoutMs);
  });

  it("gives completion-aware automations enough outer watchdog headroom", () => {
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-automations-wait",
      namespace: null,
      tool: "automations",
    };

    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          ...call,
          arguments: { action: "run", jobId: "job-1", waitForCompletion: true },
        },
        config: undefined,
      }),
    ).toBe(630_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          ...call,
          arguments: {
            action: "run",
            jobId: "job-1",
            waitForCompletion: true,
            completionTimeoutMs: 120_000,
            timeoutMs: 1_000,
          },
        },
        config: undefined,
      }),
    ).toBe(150_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          ...call,
          arguments: {
            action: "run",
            jobId: "job-1",
            waitForCompletion: true,
            completionTimeoutMs: 120_000,
            timeoutMs: 600_000,
          },
        },
        config: undefined,
      }),
    ).toBe(150_000);
    expect(
      resolveDynamicToolCallTimeoutMs({
        call: {
          ...call,
          arguments: {
            action: "run",
            jobId: "job-1",
            waitForCompletion: false,
            timeoutMs: 1_000,
          },
        },
        config: undefined,
      }),
    ).toBe(1_000);
    expect(CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS).toBeGreaterThan(630_000);
  });
});
