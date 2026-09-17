import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolCallResponse } from "./protocol.js";

const CODEX_DYNAMIC_TOOL_SERVER_REQUEST_TIMEOUT_MS = 660_000;

describe("long-running dynamic tool timeout resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("lets an automation return its structured timeout before the outer watchdog", async () => {
    vi.useFakeTimers();
    const call = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-automations-structured-timeout",
      namespace: null,
      tool: "automations",
      arguments: { action: "run", jobId: "job-1", waitForCompletion: true },
    };
    const structuredTimeout: CodexDynamicToolCallResponse = {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ runId: "run-1", completed: false, timedOut: true }),
        },
      ],
    };
    const onTimeout = vi.fn();
    const response = handleDynamicToolCallWithTimeout({
      call,
      toolBridge: {
        handleToolCall: vi.fn(
          () =>
            new Promise<CodexDynamicToolCallResponse>((resolve) => {
              setTimeout(() => resolve(structuredTimeout), 600_000);
            }),
        ),
      },
      signal: new AbortController().signal,
      timeoutMs: resolveDynamicToolCallTimeoutMs({ call, config: undefined }),
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(600_000);

    await expect(response).resolves.toEqual(structuredTimeout);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
