// Preemptive compaction tests cover token-pressure estimates before prompt
// submission and the route chosen to compact, truncate, or proceed.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import "../../test-helpers/agent-session-token-mock.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import {
  estimateToolResultReductionPotential,
  truncateOversizedToolResultsInMessages,
} from "../tool-result-truncation.js";

let PREEMPTIVE_OVERFLOW_ERROR_TEXT: typeof import("./preemptive-compaction.js").PREEMPTIVE_OVERFLOW_ERROR_TEXT;
let estimateLlmBoundaryTokenPressure: typeof import("./preemptive-compaction.js").estimateLlmBoundaryTokenPressure;
let buildPrePromptContextBudgetStatus: typeof import("./preemptive-compaction.js").buildPrePromptContextBudgetStatus;
let estimateRenderedLlmBoundaryTokenPressure: typeof import("./preemptive-compaction.js").estimateRenderedLlmBoundaryTokenPressure;
let formatPrePromptPrecheckLog: typeof import("./preemptive-compaction.js").formatPrePromptPrecheckLog;
let shouldPreemptivelyCompactBeforePrompt: typeof import("./preemptive-compaction.js").shouldPreemptivelyCompactBeforePrompt;

beforeAll(async () => {
  // Import after the session-token mock is installed so token estimates match
  // the runtime environment these helpers protect.
  vi.resetModules();
  ({
    PREEMPTIVE_OVERFLOW_ERROR_TEXT,
    estimateLlmBoundaryTokenPressure,
    buildPrePromptContextBudgetStatus,
    estimateRenderedLlmBoundaryTokenPressure,
    formatPrePromptPrecheckLog,
    shouldPreemptivelyCompactBeforePrompt,
  } = await import("./preemptive-compaction.js"));
});

let timestamp = 1;

function makeAssistantHistory(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeProviderAssistant(params: {
  promptTokens: number;
  totalTokens: number;
  text?: string;
}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text ?? "provider answer" }],
    usage: {
      input: params.promptTokens,
      output: params.totalTokens - params.promptTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: params.totalTokens,
      contextUsage: {
        state: "available",
        promptTokens: params.promptTokens,
        totalTokens: params.totalTokens,
      },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeUnavailableAssistant(params: {
  totalTokens: number;
  legacyCli?: boolean;
}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "usage unavailable" }],
    api: params.legacyCli ? "cli" : "anthropic-messages",
    usage: {
      input: params.totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: params.totalTokens,
      ...(params.legacyCli ? {} : { contextUsage: { state: "unavailable" as const } }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeLegacyProviderAssistant(params: {
  input: number;
  output: number;
  cacheRead?: number;
}): AgentMessage {
  const cacheRead = params.cacheRead ?? 0;
  return {
    role: "assistant",
    api: "openai-chatgpt-responses",
    provider: "openai",
    model: "gpt-5.6-sol",
    content: [{ type: "text", text: "provider answer" }],
    usage: {
      input: params.input,
      output: params.output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: params.input + params.output + cacheRead,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeToolResultMessage(...texts: string[]): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "read",
    content: texts.map((text) => ({ type: "text", text })),
    isError: false,
    timestamp: timestamp++,
  } as AgentMessage;
}

function makeJsonToolResultMessage(payload: unknown): AgentMessage {
  // JSON tool results reach providers through rendered boundary payloads; this
  // fixture proves estimates count object payloads, not just text blocks.
  return {
    role: "toolResult",
    toolCallId: `call_${timestamp}`,
    toolName: "json_tool",
    content: [{ type: "json", payload }],
    isError: false,
    timestamp: timestamp++,
  } as unknown as AgentMessage;
}

function makeAssistantToolCall(args: unknown): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `call_${timestamp}`,
        name: "bulk_lookup",
        arguments: args,
      },
    ],
    timestamp: timestamp++,
  } as AgentMessage;
}

describe("preemptive-compaction", () => {
  const verboseHistory =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(40);
  const verboseSystem =
    "system guidance with multiple distinct words to avoid tokenizer overcompression ".repeat(25);
  const verbosePrompt =
    "user request with distinct content asking for a detailed answer and more context ".repeat(25);

  it("exports a context-overflow-compatible precheck error text", () => {
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("Context overflow:");
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("(precheck)");
  });

  it("raises the estimate as prompt-side content grows", () => {
    const smaller = estimateLlmBoundaryTokenPressure({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: "sys",
      prompt: "hello",
    });
    const larger = estimateLlmBoundaryTokenPressure({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });

    expect(larger).toBeGreaterThan(smaller);
  });

  it("requests preemptive compaction when the reserve-based prompt budget would be exceeded", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory(verboseHistory)],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("does not request preemptive compaction when the reserve-based prompt budget still fits", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
    expect(result.estimatedPromptTokens).toBeLessThan(result.promptBudgetBeforeReserve);
  });

  it("uses exact provider context plus later transcript and current prompt pressure", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        makeProviderAssistant({ promptTokens: 240_000, totalTokens: 240_304 }),
        { role: "user", content: "small tail", timestamp: timestamp++ } as AgentMessage,
      ],
      systemPrompt: "current system prompt",
      prompt: "continue",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThan(240_304);
    expect(result.estimatedPromptTokens).toBeLessThan(252_000);
    expect(result.route).toBe("fits");
  });

  it("drops a stale provider-usage floor when prompt projection changed earlier results", () => {
    const rawMessages = [
      { role: "user", content: "run the batch", timestamp: timestamp++ } as AgentMessage,
      ...Array.from({ length: 12 }, () => makeToolResultMessage("r".repeat(60_000))),
      makeProviderAssistant({ promptTokens: 278_803, totalTokens: 279_011 }),
    ];
    const projection = truncateOversizedToolResultsInMessages(
      rawMessages,
      272_000,
      32_000,
      256_000,
      createToolResultPromptProjectionState(),
    );
    const projectedMessages = projection.messages;

    const staleFloor = shouldPreemptivelyCompactBeforePrompt({
      messages: projectedMessages,
      prompt: "continue",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
    });
    const projectedEstimate = shouldPreemptivelyCompactBeforePrompt({
      messages: projectedMessages,
      prompt: "continue",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
      providerProjectionFirstChangedMessageIndex: projection.firstChangedMessageIndex,
    });

    expect(projectedMessages).not.toBe(rawMessages);
    expect(staleFloor.pressureSource).toBe("provider_context_usage");
    expect(staleFloor.estimatedPromptTokens).toBeGreaterThanOrEqual(279_011);
    expect(projectedEstimate.pressureSource).toBe("transcript_estimate");
    expect(projectedEstimate.estimatedPromptTokens).toBeLessThan(200_000);
    expect(projectedEstimate.estimatedPromptTokens).toBeLessThan(staleFloor.estimatedPromptTokens);
    expect(projectedEstimate.route).toBe("fits");
  });

  it("caps a pessimistic projected replay with the prior provider measurement", () => {
    const rawMessages = [
      {
        role: "user",
        content: "historical context ".repeat(60_000),
        timestamp: timestamp++,
      } as AgentMessage,
      ...Array.from({ length: 12 }, () => makeToolResultMessage("r".repeat(60_000))),
      makeProviderAssistant({ promptTokens: 198_418, totalTokens: 199_436 }),
      makeToolResultMessage("r".repeat(32_000)),
    ];
    const projection = truncateOversizedToolResultsInMessages(
      rawMessages,
      272_000,
      32_000,
      256_000,
      createToolResultPromptProjectionState(),
    );

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: projection.messages,
      systemPrompt: "current system prompt ".repeat(1_600),
      prompt: "continue",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
      providerProjectionFirstChangedMessageIndex: projection.firstChangedMessageIndex,
    });

    expect(projection.firstChangedMessageIndex).toBeGreaterThan(0);
    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThan(199_436);
    expect(result.estimatedPromptTokens).toBeLessThan(252_000);
    expect(result.route).toBe("fits");
  });

  it("prefers a newer reductive provider cap over an older exact boundary", () => {
    const rawMessages = [
      makeProviderAssistant({ promptTokens: 179_000, totalTokens: 180_000 }),
      ...Array.from({ length: 12 }, () => makeToolResultMessage("r".repeat(60_000))),
      makeProviderAssistant({ promptTokens: 198_418, totalTokens: 199_436 }),
      makeToolResultMessage("r".repeat(32_000)),
    ];
    const projection = truncateOversizedToolResultsInMessages(
      rawMessages,
      272_000,
      32_000,
      256_000,
      createToolResultPromptProjectionState(),
    );

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: projection.messages,
      prompt: "continue",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
      providerProjectionFirstChangedMessageIndex: projection.firstChangedMessageIndex,
    });

    expect(projection.firstChangedMessageIndex).toBeGreaterThan(0);
    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThan(199_436);
    expect(result.estimatedPromptTokens).toBeLessThan(252_000);
    expect(result.route).toBe("fits");
  });

  it("preserves an authoritative provider-usage floor for an unchanged view", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "short history", timestamp: timestamp++ } as AgentMessage,
        makeProviderAssistant({ promptTokens: 278_803, totalTokens: 279_011 }),
      ],
      prompt: "continue",
      contextTokenBudget: 300_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThanOrEqual(279_011);
  });

  it("preserves a provider-usage prefix when only trailing results are projected", () => {
    const rawMessages = [
      { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
      makeProviderAssistant({ promptTokens: 150_000, totalTokens: 150_200 }),
      ...Array.from({ length: 12 }, () => makeToolResultMessage("r".repeat(60_000))),
    ];
    const projection = truncateOversizedToolResultsInMessages(
      rawMessages,
      1_000_000,
      32_000,
      256_000,
      createToolResultPromptProjectionState(),
    );

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: projection.messages,
      prompt: "continue",
      contextTokenBudget: 1_000_000,
      reserveTokens: 20_000,
      providerProjectionFirstChangedMessageIndex: projection.firstChangedMessageIndex,
    });

    expect(projection.firstChangedMessageIndex).toBeGreaterThan(1);
    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThan(150_200);
    expect(result.estimatedPromptTokens).toBeLessThan(400_000);
  });

  it("uses legacy embedded provider usage when contextUsage is absent", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        makeLegacyProviderAssistant({ input: 143_687, output: 372, cacheRead: 37_376 }),
        makeToolResultMessage("small post-call result"),
      ],
      systemPrompt: "current rendered system and tool schema ".repeat(4_000),
      prompt: "continue",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("provider_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThan(181_435);
    expect(result.estimatedPromptTokens).toBeLessThan(252_000);
    expect(result.route).toBe("fits");
  });

  it("prefers newer legacy provider usage over an older contextUsage boundary", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        makeProviderAssistant({ promptTokens: 240_000, totalTokens: 240_304 }),
        makeLegacyProviderAssistant({ input: 143_687, output: 372, cacheRead: 37_376 }),
        makeToolResultMessage("small post-call result"),
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("provider_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThan(181_435);
    expect(result.estimatedPromptTokens).toBeLessThan(190_000);
    expect(result.route).toBe("fits");
  });

  it("does not promote errored legacy provider usage into a context boundary", () => {
    const failed = makeLegacyProviderAssistant({ input: 10, output: 1 });
    if (failed.role === "assistant") {
      failed.stopReason = "error";
    }
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        failed,
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("transcript_estimate");
    expect(result.route).toBe("compact_only");
  });

  it("counts the current system prompt after a provider usage boundary", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        makeProviderAssistant({ promptTokens: 240_000, totalTokens: 240_304 }),
        { role: "user", content: "small tail", timestamp: timestamp++ } as AgentMessage,
      ],
      systemPrompt: "new system instruction ".repeat(5_000),
      prompt: "continue",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
    expect(result.route).toBe("compact_only");
  });

  it("counts the system prompt only when the provider boundary predates the prompt fence", () => {
    const messages = [
      { role: "user", content: "current turn", timestamp: timestamp++ } as AgentMessage,
      makeProviderAssistant({ promptTokens: 230_324, totalTokens: 230_895 }),
      makeToolResultMessage("r".repeat(21_600)),
    ];
    const common = {
      messages,
      systemPrompt: "s".repeat(37_495),
      prompt: "",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
    };

    const sameTurn = shouldPreemptivelyCompactBeforePrompt({
      ...common,
      providerBoundaryIncludesSystemPromptFromIndex: 1,
    });
    const olderTurn = shouldPreemptivelyCompactBeforePrompt({
      ...common,
      providerBoundaryIncludesSystemPromptFromIndex: 2,
    });

    expect(sameTurn.estimatedPromptTokens).toBe(243_894);
    expect(sameTurn.route).toBe("fits");
    expect(olderTurn.estimatedPromptTokens).toBe(255_157);
    expect(olderTurn.route).toBe("compact_only");
  });

  it("matches the live same-turn provider boundary without re-adding the rendered system prompt", () => {
    const providerBoundary = makeProviderAssistant({
      promptTokens: 175_900,
      totalTokens: 176_411,
    });
    if (providerBoundary.role === "assistant") {
      providerBoundary.stopReason = "toolUse";
    }
    const messages = [
      { role: "user", content: "current turn", timestamp: timestamp++ } as AgentMessage,
      providerBoundary,
      makeToolResultMessage("t".repeat(102_990)),
    ];
    const common = {
      messages,
      systemPrompt: "s".repeat(168_937),
      prompt: "",
      contextTokenBudget: 272_000,
      reserveTokens: 20_000,
    };

    const sameTurn = shouldPreemptivelyCompactBeforePrompt({
      ...common,
      providerBoundaryIncludesSystemPromptFromIndex: 1,
    });
    const unknownSystemProvenance = shouldPreemptivelyCompactBeforePrompt({
      ...common,
      providerBoundaryIncludesSystemPromptFromIndex: 2,
    });

    expect(sameTurn.estimatedPromptTokens).toBe(238_244);
    expect(sameTurn.route).toBe("fits");
    expect(unknownSystemProvenance.estimatedPromptTokens).toBe(288_940);
    expect(unknownSystemProvenance.route).toBe("compact_then_truncate");
  });

  it("uses the later assistant boundary when distinct responses have equal totals", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000, text: "first" }),
        makeToolResultMessage("x".repeat(100_000)),
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000, text: "second" }),
        { role: "user", content: "small tail", timestamp: timestamp++ } as AgentMessage,
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.estimatedPromptTokens).toBeGreaterThan(180_000);
    expect(result.estimatedPromptTokens).toBeLessThan(190_000);
    expect(result.route).toBe("fits");
  });

  it("still compacts when content after the provider boundary exceeds the budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000 }),
        makeToolResultMessage("x".repeat(40_000)),
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.estimatedPromptTokens).toBeGreaterThan(190_000);
    expect(result.route).not.toBe("fits");
  });

  it("falls back to full transcript pressure without available provider context", () => {
    const unavailable = makeProviderAssistant({ promptTokens: 1, totalTokens: 2 });
    if (unavailable.role === "assistant") {
      unavailable.usage.contextUsage = { state: "unavailable" };
    }
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        unavailable,
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("transcript_estimate");
    expect(result.route).not.toBe("fits");
  });

  it("does not scan past a zero unavailable context marker", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000 }),
        makeUnavailableAssistant({ totalTokens: 0 }),
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("transcript_estimate");
    expect(result.route).toBe("compact_only");
  });

  it("treats legacy CLI usage without context provenance as a barrier", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000 }),
        makeUnavailableAssistant({ totalTokens: 1_000, legacyCli: true }),
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("transcript_estimate");
    expect(result.route).toBe("compact_only");
  });

  it("can reuse an older provider boundary past nonzero unavailable billing usage", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [
        { role: "user", content: "x".repeat(1_000_000), timestamp: timestamp++ } as AgentMessage,
        makeProviderAssistant({ promptTokens: 179_900, totalTokens: 180_000 }),
        makeUnavailableAssistant({ totalTokens: 927_907 }),
      ],
      prompt: "continue",
      contextTokenBudget: 210_000,
      reserveTokens: 20_000,
    });

    expect(result.pressureSource).toBe("provider_context_usage");
    expect(result.route).toBe("fits");
  });

  it("formats all-route pre-prompt diagnostics for a fits decision", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });
    const line = formatPrePromptPrecheckLog({
      result,
      sessionKey: "discord:channel:thread",
      sessionId: "session-1",
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      messageCount: 1,
      unwindowedMessageCount: 3,
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
      sessionFile: "sessions/session-1.json",
    });

    expect(line).toContain("[context-overflow-precheck] pre-prompt check");
    expect(line).toContain("sessionKey=discord:channel:thread");
    expect(line).toContain("provider=anthropic/claude-opus-4-6");
    expect(line).toContain("route=fits");
    expect(line).toContain(`estimatedPromptTokens=${result.estimatedPromptTokens}`);
    expect(line).toContain(`promptBudgetBeforeReserve=${result.promptBudgetBeforeReserve}`);
    expect(line).toContain("overflowTokens=0");
    expect(line).toContain(`toolResultReducibleChars=${result.toolResultReducibleChars}`);
    expect(line).toContain("reserveTokens=1000");
    expect(line).toContain(`effectiveReserveTokens=${result.effectiveReserveTokens}`);
    expect(line).toContain("contextTokenBudget=10000");
    expect(line).toContain("messages=1");
    expect(line).toContain("unwindowedMessages=3");
  });

  it("builds a durable estimated context budget status snapshot", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    const status = buildPrePromptContextBudgetStatus({
      result,
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      messageCount: 1,
      unwindowedMessageCount: 3,
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
      sessionId: "session-1",
      now: 123,
    });

    expect(status).toMatchObject({
      schemaVersion: 1,
      source: "pre-prompt-estimate",
      updatedAt: 123,
      provider: "anthropic",
      model: "claude-opus-4-6",
      route: "fits",
      shouldCompact: false,
      contextTokenBudget: 10_000,
      promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
      reserveTokens: 1_000,
      effectiveReserveTokens: result.effectiveReserveTokens,
      overflowTokens: 0,
      messageCount: 1,
      unwindowedMessageCount: 3,
      sessionId: "session-1",
    });
    expect(status.remainingPromptBudgetTokens).toBe(
      result.promptBudgetBeforeReserve - result.estimatedPromptTokens,
    );
  });

  it("uses the larger unwindowed message estimate when explicitly provided", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("small assembled window")],
      unwindowedMessages: [makeAssistantHistory(verboseHistory.repeat(4))],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("uses rendered LLM-boundary pressure when the runtime owns the final payload shape", () => {
    // Runtime renderers can add large provider-facing payloads after transcript
    // assembly, so the precheck must prefer that boundary estimate when present.
    const renderedPrompt = "x".repeat(60_000);
    const estimatedPromptTokens = estimateRenderedLlmBoundaryTokenPressure({
      systemPrompt: "sys",
      prompt: renderedPrompt,
    });
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("the transcript view is intentionally small")],
      systemPrompt: "sys",
      prompt: "small prompt before runtime projection",
      contextTokenBudget: 16_000,
      reserveTokens: 4_000,
      llmBoundaryTokenPressure: {
        estimatedPromptTokens,
        source: "test_rendered_payload",
        renderedChars: renderedPrompt.length,
      },
    });

    expect(result.pressureSource).toBe("test_rendered_payload");
    expect(result.estimatedPromptTokens).toBe(estimatedPromptTokens);
    expect(result.route).toBe("compact_only");
    expect(result.shouldCompact).toBe(true);
  });

  it("counts array/object tool-result payloads at the LLM boundary", () => {
    const objectPayload = {
      rows: Array.from({ length: 120 }, (_, index) => ({
        path: `/tmp/generated-${index}.txt`,
        body: "x".repeat(1_500),
      })),
    };
    const messages = [makeJsonToolResultMessage(objectPayload)];
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
    });

    expect(estimatedPromptTokens).toBeGreaterThan(80_000);

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 96_000,
      reserveTokens: 20_000,
    });

    expect(result.route).not.toBe("fits");
    expect(result.estimatedPromptTokens).toBe(estimatedPromptTokens);
    expect(result.overflowTokens).toBeGreaterThan(0);
  });

  it("counts assistant tool-call arguments instead of trusting text-only token estimates", () => {
    const messages = [
      makeAssistantToolCall({
        queryPlan: "find relevant files",
        candidates: Array.from({ length: 100 }, (_, index) => ({
          path: `/repo/file-${index}.ts`,
          content: "z".repeat(1_000),
        })),
      }),
    ];
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
    });

    expect(estimatedPromptTokens).toBeGreaterThan(30_000);
  });

  it("prechecks a regression-sized synthetic tool-heavy transcript as over budget", () => {
    const toolResultCharsPerMessage = Math.ceil(427_000 / 120);
    const generalCharsPerMessage = Math.ceil((503_000 - 427_000) / 121);
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 241; index += 1) {
      if (index % 2 === 0) {
        messages.push(
          makeToolResultMessage(
            "t".repeat(toolResultCharsPerMessage),
            JSON.stringify({ index, payload: "p".repeat(80) }),
          ),
        );
      } else {
        messages.push(makeAssistantHistory("h".repeat(generalCharsPerMessage)));
      }
    }

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "system".repeat(200),
      prompt: "continue",
      contextTokenBudget: 200_000,
      reserveTokens: 32_000,
    });

    expect(result.estimatedPromptTokens).toBeGreaterThan(200_000);
    expect(result.promptBudgetBeforeReserve).toBe(168_000);
    expect(result.route).not.toBe("fits");
    expect(result.overflowTokens).toBeGreaterThan(0);
  });

  it("caps reserve tokens so small context models keep usable prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 16_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(8_000);
    expect(result.promptBudgetBeforeReserve).toBe(8_000);
    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
  });

  it("keeps the requested reserve when it leaves enough prompt budget", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeAssistantHistory("short history")],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 32_000,
      reserveTokens: 20_000,
    });

    expect(result.effectiveReserveTokens).toBe(20_000);
    expect(result.promptBudgetBeforeReserve).toBe(12_000);
    expect(result.shouldCompact).toBe(false);
  });

  it("routes to direct tool-result truncation when recent tool tails can clearly absorb the overflow", () => {
    // If reducible recent tool output covers the overflow, truncation is enough
    // and a full transcript compaction would waste time/context.
    const medium = "alpha beta gamma delta epsilon ".repeat(2200);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(medium, medium, medium, medium),
    ];
    const reserveTokens = 2_000;
    const contextTokenBudget = 26_000;
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const desiredOverflowTokens = 200;
    const adjustedContextTokenBudget =
      estimatedPromptTokens - desiredOverflowTokens + reserveTokens;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: Math.max(contextTokenBudget, adjustedContextTokenBudget),
      reserveTokens,
    });

    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("routes to compact then truncate when recent tool tails help but cannot fully cover the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(600);
    const longHistory = "old discussion with substantial retained context and decisions ".repeat(
      5000,
    );
    const messages = [
      makeAssistantHistory(longHistory),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 500;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 12_000,
      reserveTokens,
    });

    expect(result.route).toBe("compact_then_truncate");
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("treats mixed oversized-plus-aggregate tool tails as cumulative recovery potential", () => {
    const oversized = "x".repeat(45_000);
    const medium = "alpha beta gamma delta epsilon ".repeat(500);
    const messages: AgentMessage[] = [
      makeAssistantHistory("short history"),
      makeToolResultMessage(oversized),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
      makeToolResultMessage(medium),
    ];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const potential = estimateToolResultReductionPotential({
      messages,
      contextWindowTokens: 20_000,
    });
    const desiredOverflowTokens = 2_000;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: estimatedPromptTokens - desiredOverflowTokens + reserveTokens,
      reserveTokens,
    });

    expect(potential.oversizedReducibleChars).toBeGreaterThan(0);
    expect(potential.aggregateReducibleChars).toBeGreaterThan(0);
    expect(potential.oversizedReducibleChars).toBeLessThan(potential.maxReducibleChars);
    expect(potential.maxReducibleChars).toBeGreaterThan(desiredOverflowTokens * 4);
    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
  });

  it("estimates CJK tool results at roughly one token per character", () => {
    const cjkText = "中".repeat(85_000);
    const toolResultTokens = estimateLlmBoundaryTokenPressure({
      messages: [makeToolResultMessage(cjkText)],
      systemPrompt: "sys",
      prompt: "continue",
    });
    const assistantTokens = estimateLlmBoundaryTokenPressure({
      messages: [makeAssistantHistory(cjkText)],
      systemPrompt: "sys",
      prompt: "continue",
    });
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeToolResultMessage(cjkText)],
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 128_000,
      reserveTokens: 20_000,
    });

    expect(toolResultTokens).toBeGreaterThanOrEqual(assistantTokens);
    expect(toolResultTokens - assistantTokens).toBeLessThanOrEqual(5);
    expect(result.estimatedPromptTokens).toBe(toolResultTokens);
    expect(result.promptBudgetBeforeReserve).toBeGreaterThan(result.estimatedPromptTokens);
    expect(result.route).toBe("fits");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBe(0);
  });

  it("avoids false overflow when CJK is less than half of a tool result", () => {
    const mixedContent = "中".repeat(40_000) + "a".repeat(60_000);
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [makeToolResultMessage(mixedContent)],
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 100_000,
      reserveTokens: 20_000,
    });

    expect(result.estimatedPromptTokens).toBeLessThan(result.promptBudgetBeforeReserve);
    expect(result.route).toBe("fits");
    expect(result.shouldCompact).toBe(false);
  });

  it("keeps mixed-script estimates monotonic across the former CJK cutoff", () => {
    const estimate = (cjkChars: number) =>
      estimateLlmBoundaryTokenPressure({
        messages: [makeToolResultMessage("中".repeat(cjkChars) + "a".repeat(10_000 - cjkChars))],
        systemPrompt: "sys",
        prompt: "continue",
      });

    const belowCutoff = estimate(4_999);
    const atCutoff = estimate(5_000);
    const aboveCutoff = estimate(5_001);

    expect(atCutoff).toBeGreaterThanOrEqual(belowCutoff);
    expect(aboveCutoff).toBeGreaterThanOrEqual(atCutoff);
    expect(aboveCutoff - belowCutoff).toBeLessThanOrEqual(2);
  });

  it("keeps the conservative ratio for non-CJK tool results", () => {
    const latinText = "alpha beta gamma delta epsilon ".repeat(1000);
    const toolResultTokens = estimateLlmBoundaryTokenPressure({
      messages: [makeToolResultMessage(latinText)],
      systemPrompt: "sys",
      prompt: "continue",
    });
    const assistantTokens = estimateLlmBoundaryTokenPressure({
      messages: [makeAssistantHistory(latinText)],
      systemPrompt: "sys",
      prompt: "continue",
    });

    expect(toolResultTokens).toBeGreaterThan(assistantTokens * 1.5);
    expect(toolResultTokens).toBeLessThan(assistantTokens * 2.5);
  });

  it("applies the CJK-aware ratio to JSON tool-result payloads", () => {
    const cjkPayload = {
      summary: "中文内容".repeat(5_000),
      note: "更多中文文本".repeat(2_000),
    };
    const messages = [makeJsonToolResultMessage(cjkPayload)];

    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
    });

    expect(estimatedPromptTokens).toBeLessThan(90_000);

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 128_000,
      reserveTokens: 20_000,
    });

    expect(result.route).toBe("fits");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBe(0);
  });

  it("does not throw when tool-result content cannot be serialized", () => {
    const circular: Record<string, unknown> = { self: undefined };
    circular.self = circular;
    const message = {
      role: "toolResult",
      toolCallId: "call_circular",
      toolName: "bad_tool",
      content: circular,
      isError: false,
      timestamp: timestamp++,
    } as unknown as AgentMessage;

    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [message],
      systemPrompt: "sys",
      prompt: "continue",
      contextTokenBudget: 128_000,
      reserveTokens: 20_000,
    });

    expect(Number.isFinite(result.estimatedPromptTokens)).toBe(true);
  });
});
