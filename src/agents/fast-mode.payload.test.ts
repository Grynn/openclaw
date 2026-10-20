import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddedRunExecutionParams,
  resolveRunFastModeForFallbackCandidate,
} from "../auto-reply/reply/agent-runner-utils.js";
import type { FollowupRun } from "../auto-reply/reply/queue.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import { buildProviderStreamFamilyHooks } from "../plugin-sdk/provider-stream.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import { resolveFastModeState } from "./fast-mode.js";
import type { StreamFn } from "./runtime/index.js";
import "./ai-transport-runtime-host.js";

const previousHost = getAiTransportHost();
const requests: unknown[] = [];
beforeEach(() => {
  requests.length = 0;
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      requests.push(JSON.parse(await request.text()));
      return new Response(
        'data: {"type":"response.completed","response":{"id":"speed-policy-proof","status":"completed","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
});
afterEach(() => configureAiTransportHost(previousHost));

const model: Model<"openai-responses"> = {
  id: "speed-fixture",
  name: "Speed fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 1_050_000,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const selections = [
  [false, "default"],
  [true, "priority"],
  ["ultrafast", "ultrafast"],
] as const;
const config = (defaults: AgentDefaultsConfig): OpenClawConfig => ({ agents: { defaults } });
const models = (params: Record<string, unknown>) => ({ "openai/speed-fixture": { params } });

async function captureRequest(
  cfg: OpenClawConfig,
  fastMode: false | true | "auto" | "ultrafast" | undefined,
  turnOverride?: Record<string, unknown>,
  prepared = false,
  preparedExtraParams?: Record<string, unknown>,
) {
  const requestMode = prepared
    ? fastMode
    : resolveFastModeState({
        cfg,
        provider: "openai",
        model: model.id,
        sessionEntry: { fastMode },
      }).requestMode;
  const preparedModel = attachModelProviderRuntimePluginHandle(model, {
    provider: "openai",
    modelId: model.id,
    config: cfg,
    plugin: {
      id: "openai",
      label: "Speed fixture",
      auth: [],
      ...buildProviderStreamFamilyHooks("openai-responses-defaults"),
    },
  });
  const agent: { streamFn: StreamFn } = { streamFn: streamSimple };
  applyExtraParamsToAgent(
    agent,
    cfg,
    "openai",
    model.id,
    turnOverride ?? (requestMode === undefined ? undefined : { fastMode: requestMode }),
    undefined,
    undefined,
    undefined,
    preparedModel,
    undefined,
    undefined,
    { nativeWebSearchPolicyContext: { runtimeToolAllowlist: [] }, preparedExtraParams },
  );
  const previousRequests = requests.length;
  const output = await agent.streamFn(
    preparedModel,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { apiKey: "synthetic-test-key" },
  );
  expect((await output.result()).errorMessage).toBeUndefined();
  expect(requests).toHaveLength(previousRequests + 1);
  return requests.at(-1);
}

async function checkSpeeds(cfg: OpenClawConfig, inherited?: string, key?: string, compact = false) {
  for (const [mode, tier] of [[undefined, inherited], ...selections] as const) {
    if (tier === undefined) {
      continue;
    }
    const override = key ? { [key]: mode } : undefined;
    const payload = await captureRequest(cfg, key ? true : mode, override);
    const threshold = tier === "ultrafast" ? 260_000 : 735_000;
    const compaction = { type: "compaction", compact_threshold: threshold };
    expect(payload).toMatchObject({
      service_tier: tier,
      ...(compact ? { context_management: [compaction] } : {}),
    });
  }
}

describe("fast-mode request assembly", () => {
  it.each(["flex", "auto", "default"])(
    "preserves inherited %s under denial while explicit speed selections still select Standard",
    async (tier) => {
      for (const key of ["serviceTier", "service_tier"]) {
        const cfg = config({ models: models({ fastModeAllowed: false, [key]: tier }) });
        expect(await captureRequest(cfg, undefined)).toMatchObject({ service_tier: tier });
        // Maintenance/plugin callers may enter assembly without a resolved run control.
        expect(await captureRequest(cfg, undefined, { temperature: 0.25 }, true)).toMatchObject({
          service_tier: tier,
          temperature: 0.25,
        });
        expect(
          await captureRequest(cfg, undefined, undefined, true, {
            [key]: tier,
            fastMode: undefined,
          }),
        ).toMatchObject({ service_tier: tier });
        for (const mode of [false, true, "auto", "ultrafast"] as const) {
          expect(await captureRequest(cfg, mode)).toMatchObject({ service_tier: "default" });
        }
      }
    },
  );

  it.each(["priority", "ultrafast"])("caps inherited %s under denial", async (tier) => {
    const cfg = config({ models: models({ fastModeAllowed: false, serviceTier: tier }) });
    expect(await captureRequest(cfg, undefined)).toMatchObject({ service_tier: "default" });
    expect(await captureRequest(cfg, undefined, undefined, true)).toMatchObject({
      service_tier: "default",
    });
  });

  it("caps direct aliases and callbacks without evaluating a denied dynamic preference", async () => {
    const cfg = config({ models: models({ fastModeAllowed: false, serviceTier: "flex" }) });
    const autoMode = vi.fn(() => true);
    for (const override of [{ fastMode: undefined, fast_mode: true }, { fastMode: autoMode }]) {
      expect(await captureRequest(cfg, undefined, override, true)).toMatchObject({
        service_tier: "default",
      });
    }
    expect(autoMode).not.toHaveBeenCalled();
  });

  it("caps an explicit fallback speed at the selected model policy without erasing the run preference", async () => {
    const cfg = config({ models: models({ fastModeAllowed: false, serviceTier: "priority" }) });
    const run: FollowupRun["run"] = {
      config: cfg,
      provider: "anthropic",
      model: "primary-fixture",
      agentId: "main",
      agentDir: "/tmp/speed-policy-proof/agent",
      workspaceDir: "/tmp/speed-policy-proof/workspace",
      sessionId: "fallback-policy",
      sessionFile: "/tmp/speed-policy-proof/session.jsonl",
      timeoutMs: 60_000,
      blockReplyBreak: "text_end",
      skipProviderRuntimeHints: true,
      fastMode: "ultrafast",
      fastModeOverride: true,
      thinkingCatalog: [],
    };
    const candidate = resolveRunFastModeForFallbackCandidate({
      run,
      config: cfg,
      provider: "openai",
      model: model.id,
    });
    const invocation = await buildEmbeddedRunExecutionParams({
      run: { ...run, ...candidate },
      provider: "openai",
      model: model.id,
      runId: "fallback-policy-run",
      sessionCtx: {},
      hasRepliedRef: undefined,
    });
    expect(
      await captureRequest(invocation.config, invocation.fastMode, undefined, true),
    ).toMatchObject({
      service_tier: "default",
    });
    expect(
      resolveRunFastModeForFallbackCandidate({
        run,
        config: cfg,
        provider: "openai",
        model: "unrestricted-fixture",
      }).fastMode,
    ).toBe("ultrafast");
    expect(run.fastMode).toBe("ultrafast");
  });

  it.each(["serviceTier", "service_tier"])(
    "inherits %s without pinning it and honors session selections",
    async (key) => {
      for (const tier of ["flex", "auto", "ultrafast"]) {
        const cfg = config({
          params: { [key === "serviceTier" ? "service_tier" : "serviceTier"]: "priority" },
          models: models({ [key]: tier }),
        });
        await checkSpeeds(cfg, tier, undefined, true);
      }
    },
  );

  it.each(["fastMode", "fast_mode"])("honors per-turn %s ahead of stored defaults", async (key) => {
    const cfg = config({ params: { fastMode: "ultrafast", serviceTier: "flex" } });
    await checkSpeeds(cfg, undefined, key);
  });

  it.each(["fastModeDefault", "fastMode", "fast_mode"])(
    "lets session selections override %s",
    async (key) => {
      const cfg = config({
        ...(key === "fastModeDefault"
          ? { fastModeDefault: "ultrafast" }
          : { params: { [key]: "ultrafast" } }),
        models: models({ serviceTier: "flex" }),
      });
      await checkSpeeds(cfg, "ultrafast");
    },
  );

  it.each([
    ["flex", undefined],
    ["auto", undefined],
    ["flex", false],
    ["auto", false],
  ])(
    "inherits the candidate's %s tier with fastModeAllowed=%s without leaking the primary speed",
    async (tier, fastModeAllowed) => {
      const cfg = config({ models: models({ serviceTier: tier, fastModeAllowed }) });
      for (const explicit of [false, true]) {
        const run: FollowupRun["run"] = {
          config: cfg,
          provider: "openai",
          model: "primary-fixture",
          agentId: "main",
          agentDir: "/tmp/speed-default-proof/agent",
          workspaceDir: "/tmp/speed-default-proof/workspace",
          sessionId: "fallback-speed",
          sessionFile: "/tmp/speed-default-proof/session.jsonl",
          timeoutMs: 60_000,
          blockReplyBreak: "text_end",
          skipProviderRuntimeHints: true,
          // The primary's inherited Ultrafast must not become a candidate override.
          fastMode: explicit ? false : "ultrafast",
          fastModeOverride: explicit,
          thinkingCatalog: [],
        };
        const candidate = resolveRunFastModeForFallbackCandidate({
          run,
          config: cfg,
          provider: "openai",
          model: model.id,
        });
        const invocation = await buildEmbeddedRunExecutionParams({
          run: { ...run, ...candidate },
          provider: "openai",
          model: model.id,
          runId: "fallback-speed-run",
          sessionCtx: {},
          hasRepliedRef: undefined,
        });
        expect(
          await captureRequest(invocation.config, invocation.fastMode, undefined, true),
        ).toMatchObject({
          service_tier: explicit ? "default" : tier,
        });
      }
    },
  );
});
