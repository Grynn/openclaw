import { describe, expect, it } from "vitest";
import { buildRestartSafeChatTranscriptState } from "./chat-restart-recovery.js";

describe("buildRestartSafeChatTranscriptState", () => {
  it("replaces prior channel aggregate membership with the Control UI claim", () => {
    const { sessionLifecyclePatch } = buildRestartSafeChatTranscriptState({
      admission: {
        priorTerminalConstituentSourceTurnIds: ["telegram-update-a", "telegram-update-b"],
        priorTerminalSourceRunId: "old-channel-aggregate",
        requestFingerprint: "new-control-ui-request",
      },
      clientRunId: "control-ui-run",
      startedAt: 42,
    });

    expect(sessionLifecyclePatch).toHaveProperty(
      "restartRecoveryDeliveryConstituentSourceTurnIds",
      undefined,
    );
    expect(sessionLifecyclePatch.restartRecoveryTerminalRunIds).toEqual([
      "old-channel-aggregate",
    ]);
    expect(sessionLifecyclePatch.restartRecoveryTerminalSourceTurnIdGroups).toEqual([
      ["telegram-update-a", "telegram-update-b"],
    ]);
  });
});
