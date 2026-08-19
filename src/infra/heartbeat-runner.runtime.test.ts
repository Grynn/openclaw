import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedReplyDispatchRuntime } from "../agents/prepared-model-runtime.types.js";
import { getPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const runtimeMocks = vi.hoisted(() => ({
  getReplyFromConfigRaw: vi.fn(),
  loadPublishedGatewayReplyDispatchRuntime: vi.fn(),
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  loadPublishedGatewayReplyDispatchRuntime: runtimeMocks.loadPublishedGatewayReplyDispatchRuntime,
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: runtimeMocks.getReplyFromConfigRaw,
  getReplyFromConfigWithoutPublishedRuntime: runtimeMocks.getReplyFromConfigRaw,
}));

import { getReplyFromConfig } from "./heartbeat-runner.runtime.js";

function createPreparedRuntime(config: OpenClawConfig): PreparedReplyDispatchRuntime {
  return Object.freeze({
    agentId: "main",
    agentDir: "/tmp/published-main-agent",
    workspaceDir: "/tmp/published-main-workspace",
    config,
    modelCatalog: { entries: [], routeVariants: [] },
    inboundPluginRegistry: {} as never,
    pluginGeneration: {} as never,
  });
}

describe("heartbeat reply runtime ownership", () => {
  beforeEach(() => {
    runtimeMocks.getReplyFromConfigRaw.mockReset();
    runtimeMocks.loadPublishedGatewayReplyDispatchRuntime.mockReset();
  });

  it("uses the published runtime across SecretRef materialization and scheduler config drift", async () => {
    const capturedSchedulerConfig = {
      agents: { defaults: { userTimezone: "UTC" } },
      channels: {
        slack: {
          botToken: {
            source: "env",
            provider: "default",
            id: "SLACK_BOT_TOKEN",
          },
        },
      },
    } satisfies OpenClawConfig;
    const publishedConfig = {
      agents: { defaults: { userTimezone: "Asia/Kolkata" } },
      channels: { slack: { botToken: "resolved-after-reload" } },
    } satisfies OpenClawConfig;
    const publishedRuntime = createPreparedRuntime(publishedConfig);
    runtimeMocks.loadPublishedGatewayReplyDispatchRuntime.mockResolvedValue(publishedRuntime);

    let observedRuntime: PreparedReplyDispatchRuntime | undefined;
    runtimeMocks.getReplyFromConfigRaw.mockImplementation(async () => {
      observedRuntime = getPreparedReplyDispatchRuntime();
      return { text: "ok" };
    });
    const ctx = { AgentId: "main", SessionKey: "agent:main:main:heartbeat" };
    const opts = { isHeartbeat: true };

    await getReplyFromConfig(ctx, opts, capturedSchedulerConfig);

    expect(runtimeMocks.loadPublishedGatewayReplyDispatchRuntime).toHaveBeenCalledWith({
      agentId: "main",
    });
    expect(observedRuntime).toBe(publishedRuntime);
    expect(observedRuntime?.config).toBe(publishedConfig);
    expect(observedRuntime?.config).not.toBe(capturedSchedulerConfig);
    expect(observedRuntime?.config.channels?.slack?.botToken).toBe("resolved-after-reload");
    expect(capturedSchedulerConfig.channels.slack.botToken).toMatchObject({
      source: "env",
      id: "SLACK_BOT_TOKEN",
    });
    expect(runtimeMocks.getReplyFromConfigRaw.mock.calls[0]).toEqual([ctx, opts]);
  });

  it("preserves the captured config for standalone heartbeat callers without a Gateway owner", async () => {
    const config = { agents: { defaults: { userTimezone: "Asia/Kolkata" } } } as OpenClawConfig;
    runtimeMocks.loadPublishedGatewayReplyDispatchRuntime.mockResolvedValue(undefined);
    runtimeMocks.getReplyFromConfigRaw.mockResolvedValue({ text: "ok" });
    const ctx = { AgentId: "main", SessionKey: "agent:main:main:heartbeat" };
    const opts = { isHeartbeat: true };

    await getReplyFromConfig(ctx, opts, config);

    expect(getPreparedReplyDispatchRuntime()).toBeUndefined();
    expect(runtimeMocks.getReplyFromConfigRaw).toHaveBeenCalledWith(ctx, opts, config);
  });

  it("derives the owner from an isolated heartbeat session when AgentId is absent", async () => {
    runtimeMocks.loadPublishedGatewayReplyDispatchRuntime.mockResolvedValue(undefined);
    runtimeMocks.getReplyFromConfigRaw.mockResolvedValue({ text: "ok" });

    await getReplyFromConfig({ SessionKey: "agent:Research:main:heartbeat" }, undefined, {});

    expect(runtimeMocks.loadPublishedGatewayReplyDispatchRuntime).toHaveBeenCalledWith({
      agentId: "research",
    });
  });
});
