import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/index.js";
import { createToolResultPromptProjectionState } from "../session-prompt-state.js";
import {
  handleEmbeddedAttemptMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight,
} from "./attempt-prompt-preflight.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  estimateLlmBoundaryTokenPressure,
} from "./preemptive-compaction.js";

const attempt = {
  provider: "test-provider",
  modelId: "test-model",
  sessionFile: "/tmp/openclaw-attempt-preflight-test.jsonl",
  sessionId: "session-1",
  sessionKey: "agent:test:main",
};

const request = {
  route: "compact_only" as const,
  estimatedPromptTokens: 150,
  promptBudgetBeforeReserve: 100,
  overflowTokens: 50,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 20,
};

function makeToolResultMessage(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  } as AgentMessage;
}

function createSessionManagerWithMessage(message: AgentMessage): SessionManager {
  const sessionManager = SessionManager.inMemory();
  sessionManager.appendMessage(message as Parameters<typeof sessionManager.appendMessage>[0]);
  return sessionManager;
}

describe("attempt prompt preflight", () => {
  it("routes a mid-turn compaction request with its measured budget", async () => {
    const outcome = await handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request,
      sessionAgentId: "test",
      sessionManager: SessionManager.inMemory(),
      prePromptMessageCount: 4,
      replaceSessionMessages: vi.fn(),
    });

    expect(outcome).toEqual({
      preflightRecovery: {
        route: "compact_only",
        source: "mid-turn",
        estimatedPromptTokens: 150,
        promptBudgetBeforeReserve: 100,
        overflowTokens: 50,
      },
      promptError: expect.objectContaining({ message: PREEMPTIVE_OVERFLOW_ERROR_TEXT }),
    });
  });

  it("admits a retry without changing history when persisted truncation cannot help", async () => {
    const toolResult = makeToolResultMessage("already capped tool output");
    const sessionManager = createSessionManagerWithMessage(toolResult);
    const messagesBefore = sessionManager.buildSessionContext().messages;
    const replaceSessionMessages = vi.fn();
    const outcome = await handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request: { ...request, route: "truncate_tool_results_only" },
      sessionAgentId: "test",
      sessionManager,
      prePromptMessageCount: 4,
      replaceSessionMessages,
    });

    expect(outcome.preflightRecovery).toEqual(
      expect.objectContaining({
        route: "truncate_tool_results_only",
        source: "mid-turn",
        handled: true,
        truncatedCount: 0,
      }),
    );
    expect(outcome.promptError).toBeUndefined();
    expect(replaceSessionMessages).not.toHaveBeenCalled();
    expect(sessionManager.buildSessionContext().messages).toEqual(messagesBefore);
  });

  it("keeps the compaction fallback when persisted truncation cannot inspect history", async () => {
    const outcome = await handleEmbeddedAttemptMidTurnPrecheck({
      attempt,
      request: { ...request, route: "truncate_tool_results_only" },
      sessionAgentId: "test",
      sessionManager: SessionManager.inMemory(),
      prePromptMessageCount: 4,
      replaceSessionMessages: vi.fn(),
    });

    expect(outcome.preflightRecovery.route).toBe("compact_only");
    expect(outcome.promptError?.message).toBe(PREEMPTIVE_OVERFLOW_ERROR_TEXT);
  });

  it("handles successful mid-turn tool-result truncation without a prompt error", async () => {
    const sessionManager = createSessionManagerWithMessage(
      makeToolResultMessage("large tool output ".repeat(5_000)),
    );
    const replaceSessionMessages = vi.fn();
    const outcome = await handleEmbeddedAttemptMidTurnPrecheck({
      attempt: { ...attempt, contextTokenBudget: 100 },
      request: { ...request, route: "truncate_tool_results_only" },
      sessionAgentId: "test",
      sessionManager,
      prePromptMessageCount: 4,
      replaceSessionMessages,
    });

    expect(outcome.promptError).toBeUndefined();
    expect(outcome.preflightRecovery).toEqual(
      expect.objectContaining({
        route: "truncate_tool_results_only",
        source: "mid-turn",
        handled: true,
        truncatedCount: 1,
      }),
    );
    expect(replaceSessionMessages).toHaveBeenCalledWith(
      sessionManager.buildSessionContext().messages,
    );
  });

  it("records heuristic pressure without short-circuiting the provider attempt", async () => {
    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      contextEngineAssemblySucceeded: false,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget: 100,
      hookMessagesForCurrentPrompt: [],
      includeBoundaryTimestamp: false,
      promptForPrecheck: "x".repeat(4_000),
      reserveTokens: 20,
      sessionMessageCount: 0,
      state: {
        contextBudgetStatus: undefined,
        preflightRecovery: undefined,
        promptError: null,
        promptErrorSource: null,
        skipPromptSubmission: false,
      },
      systemPrompt: "",
      toolResultAggregateMaxChars: 1_000,
      toolResultMaxChars: 1_000,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    });

    expect(result.skipPromptSubmission).toBe(false);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toBeUndefined();
    expect(result.contextBudgetStatus?.shouldCompact).toBe(true);
    expect(result.contextBudgetStatus?.overflowTokens).toBeGreaterThan(0);
  });

  it("defers overflow admission to a context engine that owns compaction", async () => {
    const state: Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0]["state"] = {
      contextBudgetStatus: undefined,
      preflightRecovery: undefined,
      promptError: null,
      promptErrorSource: null,
      skipPromptSubmission: false,
    };
    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      activeContextEngine: {
        info: { id: "owner", name: "Owner", ownsCompaction: true },
      },
      contextEngineAssemblySucceeded: true,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget: 100,
      hookMessagesForCurrentPrompt: [],
      includeBoundaryTimestamp: false,
      promptForPrecheck: "x".repeat(4_000),
      reserveTokens: 20,
      sessionMessageCount: 0,
      state,
      systemPrompt: "",
      toolResultAggregateMaxChars: 1_000,
      toolResultMaxChars: 1_000,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    });

    expect(result).toEqual(state);
  });

  it("does not persist heuristic pre-prompt tool-result truncation", async () => {
    const toolResult = makeToolResultMessage("alpha beta gamma delta epsilon ".repeat(2_200));
    const messages = [toolResult];
    const reserveTokens = 2_000;
    const estimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const contextTokenBudget = estimatedPromptTokens - 200 + reserveTokens;
    const sessionManager = createSessionManagerWithMessage(toolResult);

    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      contextEngineAssemblySucceeded: false,
      contextEnginePromptAuthority: "assembled",
      contextTokenBudget,
      hookMessagesForCurrentPrompt: messages,
      includeBoundaryTimestamp: true,
      promptForPrecheck: "hello",
      reserveTokens,
      sessionMessageCount: messages.length,
      state: {
        contextBudgetStatus: undefined,
        preflightRecovery: undefined,
        promptError: null,
        promptErrorSource: null,
        skipPromptSubmission: false,
      },
      systemPrompt: "sys",
      toolResultAggregateMaxChars: 1_000,
      toolResultMaxChars: 1_000,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
    });

    expect(result.skipPromptSubmission).toBe(false);
    expect(result.promptError).toBeNull();
    expect(result.promptErrorSource).toBeNull();
    expect(result.preflightRecovery).toBeUndefined();
    expect(sessionManager.buildSessionContext().messages).toEqual([toolResult]);
  });

  it("bounds context-engine preassembly tool results before they override preflight pressure", async () => {
    const unwindowedMessages = [
      { role: "user", content: "raw context", timestamp: 1 } as AgentMessage,
      ...Array.from({ length: 12 }, (_, index) => ({
        ...makeToolResultMessage(String(index).repeat(60_000)),
        toolCallId: `call-${index}`,
        timestamp: index + 2,
      })),
      {
        role: "assistant",
        content: [{ type: "text", text: "prior provider reply" }],
        usage: {
          input: 119_800,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 120_000,
          contextUsage: { state: "available", promptTokens: 119_800, totalTokens: 120_000 },
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 20,
      } as AgentMessage,
    ];
    const sourceBytes = JSON.stringify(unwindowedMessages);
    const unboundedEstimate = estimateLlmBoundaryTokenPressure({
      messages: unwindowedMessages,
      systemPrompt: "system",
      prompt: "continue",
    });

    const result = await prepareEmbeddedAttemptPromptPreflight({
      attempt,
      contextEngineAssemblySucceeded: true,
      contextEnginePromptAuthority: "preassembly_may_overflow",
      contextTokenBudget: 128_000,
      hookMessagesForCurrentPrompt: [
        { role: "user", content: "small assembled context", timestamp: 20 } as AgentMessage,
      ],
      includeBoundaryTimestamp: false,
      promptForPrecheck: "continue",
      reserveTokens: 20_000,
      sessionMessageCount: unwindowedMessages.length,
      state: {
        contextBudgetStatus: undefined,
        preflightRecovery: undefined,
        promptError: null,
        promptErrorSource: null,
        skipPromptSubmission: false,
      },
      systemPrompt: "system",
      toolResultAggregateMaxChars: 128_000,
      toolResultMaxChars: 32_000,
      toolResultPromptProjectionState: createToolResultPromptProjectionState(),
      unwindowedContextEngineMessagesForPrecheck: unwindowedMessages,
    });

    expect(result.contextBudgetStatus?.route).toBe("fits");
    expect(result.contextBudgetStatus?.shouldCompact).toBe(false);
    expect(result.contextBudgetStatus?.estimatedPromptTokens).toBeLessThan(unboundedEstimate);
    expect(JSON.stringify(unwindowedMessages)).toBe(sourceBytes);
  });
});
