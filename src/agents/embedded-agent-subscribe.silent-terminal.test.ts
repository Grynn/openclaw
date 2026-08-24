import { describe, expect, it, vi } from "vitest";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { resolveEmbeddedRunAttemptTerminalState } from "./embedded-agent-runner/run/terminal-outcome.js";
import { resolveSettledTurnFinalizationRequest } from "./embedded-agent-runner/run/terminal-resolution.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import {
  buildEmbeddedRunnerAssistant,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";

describe("silent terminal subscription state", () => {
  it("preserves buffered NO_REPLY and prevents settled-turn finalization", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run:silent-terminal",
      silentExpected: true,
      onBlockReply,
      blockReplyBreak: "message_end",
      blockReplyChunking: {
        minChars: 50,
        maxChars: 200,
        breakPreference: "paragraph",
      },
    });
    await subscription.runToolLifecycle({
      toolName: "write",
      toolCallId: "write-1",
      args: { path: "note.txt" },
      replaySafe: false,
      execute: async (onImplementationStart) => {
        onImplementationStart();
        return { content: [{ type: "text", text: "wrote note.txt" }] };
      },
    });

    const assistant = buildEmbeddedRunnerAssistant({
      content: [{ type: "text", text: SILENT_REPLY_TOKEN }],
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    emit({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: SILENT_REPLY_TOKEN },
    });
    emit({ type: "message_end", message: assistant });
    await subscription.waitForPendingEvents();

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(subscription.getCurrentAttemptAssistant()?.content).toEqual(assistant.content);
    expect(subscription.assistantTexts).toEqual([SILENT_REPLY_TOKEN]);

    const currentAttemptAssistant = subscription.getCurrentAttemptAssistant();
    const toolMetas = subscription.toolMetas.map((toolMeta) => {
      const toolName = toolMeta.toolName;
      if (!toolName) {
        throw new Error("expected the subscribed tool lifecycle to retain its name");
      }
      return { ...toolMeta, toolName };
    });
    const attempt = makeEmbeddedRunnerAttempt({
      assistantTexts: [...subscription.assistantTexts],
      toolMetas,
      itemLifecycle: subscription.getItemLifecycle(),
      lastAssistant: currentAttemptAssistant,
      currentAttemptAssistant,
    });
    expect(attempt.replayMetadata.hadPotentialSideEffects).toBe(true);
    expect(
      resolveSettledTurnFinalizationRequest({
        runParams: {
          sessionId: "session:silent-terminal",
          runId: "run:silent-terminal",
          trigger: "cron",
          silentExpected: true,
          terminalReplyExpectation: "required",
        } as never,
        attempt,
        activeErrorContext: { provider: "openai", model: "gpt-5.6-luna" },
        modelApi: "openai-responses",
        executionContract: undefined,
        payloadsWithToolMedia: [],
        hasTerminalToolPresentation: false,
        terminalState: resolveEmbeddedRunAttemptTerminalState({
          attempt,
          assistant: currentAttemptAssistant,
        }),
        settledTurnFinalizationAvailable: true,
      }),
    ).toBeNull();
  });
});
