import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageContent } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/index.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";

const sessionId = "attempt-prompt-submit-test";

function createSession() {
  const state = {
    messages: [{ role: "user", content: "transcript prompt", timestamp: 1 }] as AgentMessage[],
  };
  const baseStreamFn: StreamFn = () => {
    throw new Error("stream function should not be called directly");
  };
  const originalTransformContext = async (messages: AgentMessage[]) => messages;
  const agent = {
    state,
    streamFn: baseStreamFn,
    transformContext: originalTransformContext,
  };
  const activeSession = {
    get messages() {
      return state.messages;
    },
    agent,
  };
  return { activeSession, baseStreamFn, originalTransformContext };
}

function createBaseInput() {
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  return {
    attempt: { sessionId },
    appendContext: "append context",
    contextTokenBudget: 8_000,
    images: [] as ImageContent[],
    modelPrompt: "model prompt",
    onFinalPromptText: vi.fn(),
    onSteeringAcknowledged: vi.fn(),
    prependContext: "prepend context",
    runtimeOnly: false,
    sessionPromptState,
    systemPrompt: "system prompt",
    toolResultAggregateMaxChars: 8_000,
    toolResultMaxChars: 4_000,
    toolResultPromptProjectionState: sessionPromptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: null,
    transcriptPrompt: "transcript prompt",
  };
}

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
});

describe("submitEmbeddedAttemptPrompt", () => {
  it("submits runtime-only prompts without images and acknowledges steering", async () => {
    const { activeSession, baseStreamFn, originalTransformContext } = createSession();
    const input = createBaseInput();
    const promptActiveSession = vi.fn(
      async (
        prompt: string,
        options?: { images?: ImageContent[]; preflightResult?: (submitted: boolean) => void },
      ) => {
        expect(prompt).toBe("transcript prompt");
        expect(options).not.toHaveProperty("images");
        expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
        expect(activeSession.agent.streamFn).not.toBe(baseStreamFn);
        expect(activeSession.agent.transformContext).not.toBe(originalTransformContext);
        options?.preflightResult?.(true);
      },
    );

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      leasedSteering: { leaseId: "lease-1", runIds: ["missing-run"] },
      promptActiveSession,
      runtimeOnly: true,
    });

    expect(input.onSteeringAcknowledged).toHaveBeenCalledOnce();
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
  });

  it("cleans up runtime context and transforms when normal submission fails", async () => {
    const { activeSession, baseStreamFn, originalTransformContext } = createSession();
    const input = createBaseInput();
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const runtimeContextMessage: RuntimeContextCustomMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "runtime context",
      display: false,
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
      timestamp: 2,
    };
    const promptActiveSession = vi.fn(
      async (
        _prompt: string,
        options?: { images?: ImageContent[]; preflightResult?: (submitted: boolean) => void },
      ) => {
        expect(activeSession.messages).toContain(runtimeContextMessage);
        expect(options?.images).toEqual([image]);
        options?.preflightResult?.(true);
        throw new Error("provider failed");
      },
    );

    await expect(
      submitEmbeddedAttemptPrompt({
        ...input,
        activeSession,
        images: [image],
        promptActiveSession,
        runtimeContextMessage,
      }),
    ).rejects.toThrow("provider failed");

    expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
    expect(input.onSteeringAcknowledged).not.toHaveBeenCalled();
    expect(activeSession.messages).not.toContain(runtimeContextMessage);
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
  });

  it("caps oversized MCP tool results at the provider boundary", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const oversized = "x".repeat(5 * 1024 * 1024);
    const small = "small MCP result";
    activeSession.agent.state.messages = [
      { role: "user", content: "call MCP tools", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "mcp-huge-call",
        toolName: "huge__return_text",
        content: [{ type: "text", text: oversized }],
        isError: false,
        details: { mcpServer: "huge", mcpTool: "return_text" },
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "mcp-small-call",
        toolName: "huge__small_text",
        content: [{ type: "text", text: small }],
        isError: false,
        details: { mcpServer: "huge", mcpTool: "small_text" },
        timestamp: 3,
      },
    ] as AgentMessage[];
    let providerMessages: AgentMessage[] = [];
    activeSession.agent.streamFn = ((_model, context) => {
      providerMessages = (context as { messages: AgentMessage[] }).messages;
      return undefined as never;
    }) as StreamFn;

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: async () => {
        await activeSession.agent.streamFn(
          {} as never,
          { messages: activeSession.messages } as never,
          {} as never,
        );
      },
    });

    type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
    const hugeResult = providerMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "mcp-huge-call",
    );
    const smallResult = providerMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "mcp-small-call",
    );
    expect(hugeResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/more characters truncated/),
    });
    expect(hugeResult?.content[0]?.type === "text" ? hugeResult.content[0].text.length : 0).toBe(
      input.toolResultMaxChars,
    );
    expect(smallResult?.content).toEqual([{ type: "text", text: small }]);
    const originalHugeResult = activeSession.messages[1];
    expect(originalHugeResult?.role).toBe("toolResult");
    expect(
      originalHugeResult?.role === "toolResult" ? originalHugeResult.content : undefined,
    ).toEqual([{ type: "text", text: oversized }]);
  });

  it("projects the exact incident tail only at provider dispatch", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const incidentChars = [
      50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 50_000, 65_954,
      66_337,
    ];
    const durableMessages = [
      { role: "user", content: "continue", timestamp: 1 },
      {
        role: "assistant",
        content: incidentChars.map((_, index) => ({
          type: "toolCall",
          id: `incident-${index}`,
          name: "read",
          arguments: { path: `/tmp/incident-${index}` },
        })),
        stopReason: "toolUse",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 2,
      } satisfies AgentMessage,
      ...incidentChars.map(
        (chars, index) =>
          ({
            role: "toolResult",
            toolCallId: `incident-${index}`,
            toolName: "read",
            content: [{ type: "text", text: String(index % 10).repeat(chars) }],
            isError: false,
            timestamp: index + 3,
          }) as AgentMessage,
      ),
    ];
    const durableSession = SessionManager.inMemory();
    for (const message of durableMessages) {
      durableSession.appendMessage(message as Parameters<typeof durableSession.appendMessage>[0]);
    }
    activeSession.agent.state.messages = durableSession.buildSessionContext().messages;
    const sourceBytes = JSON.stringify(activeSession.messages);
    const durableBytes = JSON.stringify(durableSession.getEntries());
    let providerMessages: AgentMessage[] = [];
    activeSession.agent.streamFn = ((_model, context) => {
      providerMessages = (context as { messages: AgentMessage[] }).messages;
      return undefined as never;
    }) as StreamFn;

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      contextTokenBudget: 272_000,
      toolResultAggregateMaxChars: 256_000,
      toolResultMaxChars: 32_000,
      promptActiveSession: async () => {
        expect(input.toolResultPromptProjectionState.frozen.size).toBe(0);
        expect(input.toolResultPromptProjectionState.replacements.size).toBe(0);
        await activeSession.agent.streamFn(
          {} as never,
          { messages: activeSession.messages } as never,
          {} as never,
        );
        expect(input.toolResultPromptProjectionState.frozen.size).toBe(12);
        expect(input.toolResultPromptProjectionState.replacements.size).toBeGreaterThan(0);
      },
    });

    const providerResults = providerMessages.filter((message) => message.role === "toolResult");
    const providerLengths = providerResults.map((message) =>
      message.content.reduce(
        (sum, block) => sum + (block.type === "text" ? block.text.length : 0),
        0,
      ),
    );
    expect(incidentChars.reduce((sum, chars) => sum + chars, 0)).toBe(632_291);
    expect(providerResults).toHaveLength(12);
    expect(providerLengths.every((chars) => chars > 0 && chars <= 32_000)).toBe(true);
    expect(providerLengths.reduce((sum, chars) => sum + chars, 0)).toBeLessThanOrEqual(256_000);
    expect(JSON.stringify(activeSession.messages)).toBe(sourceBytes);
    expect(JSON.stringify(durableSession.getEntries())).toBe(durableBytes);
  });
});
