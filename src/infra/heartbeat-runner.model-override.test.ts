import { afterEach, expect, it, vi } from "vitest";
import { resolveAgentTimeoutMs } from "../agents/timeout.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import type { HeartbeatConfig } from "./heartbeat-config.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

vi.mock("./outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([]),
  deliverOutboundPayloadsInternal: vi.fn().mockResolvedValue([]),
}));

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

type RunOptions = Parameters<typeof runHeartbeatOnce>[0];
async function replyOptions(
  params: {
    heartbeat?: HeartbeatConfig;
    defaultTimeoutSeconds?: number;
    perAgent?: HeartbeatConfig;
    wake?: Pick<RunOptions, "source" | "intent" | "tasks" | "heartbeat">;
    event?: { text: string; contextKey?: string; isolated?: boolean };
    visibleReplies?: "automatic" | "message_tool";
  } = {},
) {
  return withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const agentId = params.perAgent ? "ops" : "main";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          timeoutSeconds: params.defaultTimeoutSeconds,
          heartbeat: { every: "5m", target: "whatsapp", ...params.heartbeat },
        },
        ...(params.perAgent
          ? {
              entries: {
                main: {},
                ops: { workspace: tmpDir, heartbeat: params.perAgent },
              },
            }
          : {}),
      },
      channels: { whatsapp: { allowFrom: ["*"] } },
      ...(params.visibleReplies ? { messages: { visibleReplies: params.visibleReplies } } : {}),
      session: { store: storePath },
    };
    const baseKey = resolveAgentMainSessionKey({ cfg, agentId });
    const sessionKey = `${baseKey}${params.event?.isolated ? ":heartbeat" : ""}`;
    await seedSessionStore(storePath, sessionKey, {
      lastChannel: "whatsapp",
      lastProvider: "whatsapp",
      lastTo: "+1555",
    });
    if (params.event) {
      enqueueSystemEvent(params.event.text, { sessionKey, contextKey: params.event.contextKey });
    }
    replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
    await runHeartbeatOnce({
      cfg,
      agentId,
      sessionKey,
      ...params.wake,
      deps: { getReplyFromConfig: replySpy, getQueueSize: () => 0, nowMs: () => 0 },
    });
    expect(replySpy).toHaveBeenCalledOnce();
    const [ctx, options, passedConfig] = replySpy.mock.calls[0]!;
    expect(passedConfig).toBe(cfg);
    expect(options?.isHeartbeat).toBe(true);
    return { ctx, options, cfg };
  });
}

it("keeps configured run options when a direct wake overrides only the destination", async () => {
  const { options } = await replyOptions({
    heartbeat: { timeoutSeconds: 45, lightContext: true },
    wake: { source: "manual", heartbeat: { target: "last" } },
  });
  expect(options).toMatchObject({
    timeoutOverrideSeconds: 45,
    bootstrapContextMode: "lightweight",
  });
});

it("passes the trimmed per-agent model override after merging defaults", async () => {
  const { options } = await replyOptions({
    heartbeat: { model: "openai/gpt-5.4" },
    perAgent: { model: "  ollama/llama3.2:1b  " },
  });
  expect(options?.heartbeatModelOverride).toBe("ollama/llama3.2:1b");
});

it("narrows heartbeat skills and tools while preserving explicit per-agent empty skills", async () => {
  const { options } = await replyOptions({
    heartbeat: { skills: ["calendar"], tools: ["exec"] },
    perAgent: { skills: [], tools: ["read"] },
    visibleReplies: "automatic",
  });
  expect(options?.skillFilter).toEqual([]);
  expect(options?.toolsAllow).toEqual(["read"]);
  expect(options?.forceHeartbeatTool).toBeUndefined();
});

it("retains the required response tool inside a narrowed heartbeat tool catalog", async () => {
  const { options } = await replyOptions({
    heartbeat: { skills: ["calendar"], tools: ["exec"] },
    visibleReplies: "message_tool",
  });
  expect(options?.skillFilter).toEqual(["calendar"]);
  expect(options?.toolsAllow).toEqual(["exec", "heartbeat_respond"]);
  expect(options?.forceHeartbeatTool).toBe(true);
});

it("retires the bundle MCP runtime only for isolated heartbeat runs", async () => {
  expect((await replyOptions({ heartbeat: { isolatedSession: true } })).options).toHaveProperty(
    "cleanupBundleMcpOnRunEnd",
    true,
  );
  expect((await replyOptions()).options).not.toHaveProperty("cleanupBundleMcpOnRunEnd");
});

it.each([
  ["exec continuation", "exec-event", "exec", false, false, false, 48 * 60 * 60_000],
  ["scheduled exec deferred", "exec-event", "exec", true, false, false, 45_000],
  [
    "scheduled blocked-task continuation",
    "background-task-blocked",
    "task",
    true,
    false,
    false,
    48 * 60 * 60_000,
  ],
  ["unconsumed base-session task", "background-task", "task", false, true, false, 45_000],
  ["isolated execution-queue task", "background-task", "task", false, true, true, 48 * 60 * 60_000],
  ["cron-carried task", "cron", "task", false, false, false, 48 * 60 * 60_000],
] as const)(
  "preserves the admitted-work timeout for %s",
  async (_name, source, event, scheduled, isolated, executionQueue, expected) => {
    const { ctx, options, cfg } = await replyOptions({
      heartbeat: { timeoutSeconds: 45, isolatedSession: isolated },
      event: {
        text:
          event === "exec"
            ? "Exec finished (gateway id=build, code 0)\nBuild passed"
            : "Delegated task completed. Review and verify the result.",
        contextKey: event === "task" ? "task:review" : undefined,
        isolated: executionQueue,
      },
      wake: {
        source,
        intent: source === "exec-event" ? "event" : "immediate",
        tasks: scheduled
          ? [{ jobId: "monitor", name: "status", prompt: "Check service status" }]
          : undefined,
      },
    });
    expect(ctx?.InternalTurnSource).toBe(
      scheduled
        ? "heartbeat"
        : source === "cron"
          ? "cron"
          : event === "exec"
            ? "exec"
            : "heartbeat",
    );
    expect(resolveAgentTimeoutMs({ cfg, overrideSeconds: options?.timeoutOverrideSeconds })).toBe(
      expected,
    );
  },
);
