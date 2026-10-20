import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { expect, it, vi } from "vitest";
import { wrapAnthropicProviderStream } from "../../extensions/anthropic/api.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { streamSimple } from "../llm/stream.js";
import type { Model } from "../llm/types.js";
import { useProviderCatalogMetadata } from "../plugin-sdk/plugin-test-runtime.js";
import { attachModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { applyExtraParamsToAgent } from "./embedded-agent-runner/extra-params.js";
import type { StreamFn } from "./runtime/index.js";
import "./ai-transport-runtime-host.js";

useProviderCatalogMetadata(new URL("../../extensions/anthropic/", import.meta.url));

type RequestCase = {
  name: string;
  allowed?: boolean;
  modelId?: string;
  configured?: Record<string, unknown>;
  override?: Record<string, unknown>;
  prepared?: Record<string, unknown>;
  expectedSpeed?: "fast";
  expectedTier?: string;
};

const autoMode = vi.fn(() => true);
const sharedPrepared = Object.freeze({ fastMode: true });
const cases: RequestCase[] = [
  { name: "unset policy", configured: { fastMode: true }, expectedSpeed: "fast" },
  { name: "allowed policy", allowed: true, configured: { fastMode: true }, expectedSpeed: "fast" },
  { name: "configured speed", allowed: false, configured: { fastMode: true } },
  { name: "configured alias", allowed: false, configured: { fast_mode: true } },
  { name: "explicit speed", allowed: false, override: { fastMode: true } },
  { name: "explicit alias", allowed: false, override: { fast_mode: "ultrafast" } },
  { name: "auto callback", allowed: false, override: { fastMode: autoMode } },
  { name: "prepared speed", allowed: false, prepared: sharedPrepared },
  {
    name: "prepared alias with outer override",
    allowed: false,
    prepared: Object.freeze({ fast_mode: true }),
    override: Object.freeze({ fastMode: autoMode }),
  },
  {
    name: "later unrestricted use of prepared speed",
    prepared: sharedPrepared,
    expectedSpeed: "fast",
  },
  {
    name: "independent non-native service tier",
    allowed: false,
    modelId: "claude-sonnet-4-6",
    configured: { fastMode: true, service_tier: "auto" },
    expectedTier: "auto",
  },
];

it.each(cases)("enforces Fast policy on the final Anthropic request: $name", async (fixture) => {
  const previousHost = getAiTransportHost();
  const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
  const modelId = fixture.modelId ?? "claude-opus-5";
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        anthropic: {
          baseUrl: "",
          models: [],
          params: fixture.allowed === undefined ? {} : { fastModeAllowed: fixture.allowed },
        },
      },
    },
    agents: {
      defaults: { models: { [`anthropic/${modelId}`]: { params: fixture.configured } } },
    },
  };
  const configBefore = structuredClone(cfg);
  const overrideBefore = { ...fixture.override };
  const preparedBefore = { ...fixture.prepared };
  autoMode.mockClear();
  configureAiTransportHost({
    ...previousHost,
    buildModelFetch: () => async (_input, init) => {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized Anthropic request");
      }
      requests.push({ headers: new Headers(init.headers), payload: JSON.parse(init.body) });
      return new Response(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_policy","model":"claude-opus-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const model = attachModelProviderRuntimePluginHandle<Model<"anthropic-messages">>(
      {
        provider: "anthropic",
        id: modelId,
        name: "Policy fixture",
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        reasoning: false,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        provider: "anthropic",
        modelId,
        config: cfg,
        plugin: {
          id: "anthropic",
          label: "Anthropic",
          auth: [],
          wrapStreamFn: wrapAnthropicProviderStream,
        },
      },
    );
    const agent: { streamFn: StreamFn } = { streamFn: streamSimple };
    // Direct maintenance/plugin and worker calls enter this shared boundary without
    // the command/reply caller pre-resolving fast mode. Capture the actual wire.
    applyExtraParamsToAgent(
      agent,
      cfg,
      model.provider,
      model.id,
      fixture.override,
      undefined,
      undefined,
      undefined,
      model,
      undefined,
      undefined,
      { preparedExtraParams: fixture.prepared },
    );
    const stream = await agent.streamFn(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { apiKey: "sk-ant-api-synthetic" },
    );
    expect((await stream.result()).errorMessage).toBeUndefined();
  } finally {
    configureAiTransportHost(previousHost);
  }
  expect(requests).toHaveLength(1);
  if (fixture.expectedSpeed) {
    expect(requests[0]?.payload).toMatchObject({ speed: fixture.expectedSpeed });
    expect(requests[0]?.headers.get("anthropic-beta")).toContain("fast-mode-2026-02-01");
  } else {
    expect(requests[0]?.payload).not.toHaveProperty("speed");
    expect(requests[0]?.headers.get("anthropic-beta") ?? "").not.toContain("fast-mode-2026-02-01");
    expect(autoMode).not.toHaveBeenCalled();
  }
  if (fixture.expectedTier) {
    expect(requests[0]?.payload).toMatchObject({ service_tier: fixture.expectedTier });
  }
  expect(cfg).toEqual(configBefore);
  expect({ ...fixture.override }).toEqual(overrideBefore);
  expect({ ...fixture.prepared }).toEqual(preparedBefore);
});
