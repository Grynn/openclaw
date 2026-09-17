import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueueTestRun } from "./queue.test-helpers.js";
import {
  createReplyOperation,
  forceClearReplyOperation,
  type ReplyOperation,
} from "./reply-run-registry.js";

const claimFactory = vi.hoisted(() =>
  vi.fn(() => ({
    admitUserTurn: vi.fn(),
    beginBeforeAgentReply: vi.fn(),
    checkpointBeforeAgentReply: vi.fn(),
    clear: vi.fn(),
    deferToRecovery: vi.fn(),
    isArmed: vi.fn(),
    isTracked: vi.fn(),
  })),
);

vi.mock("./restart-recovery-claim.js", () => ({
  createReplyRestartRecoveryClaimController: claimFactory,
}));

const { createReplyAgentRestartRecoveryController } = await import(
  "./agent-restart-recovery-controller.js"
);

describe("createReplyAgentRestartRecoveryController", () => {
  let replyOperation: ReplyOperation | undefined;

  afterEach(() => {
    if (replyOperation) {
      forceClearReplyOperation(replyOperation);
      replyOperation = undefined;
    }
    claimFactory.mockClear();
  });

  it("binds claim cleanup to the admitting Gateway lifecycle", () => {
    const followupRun = createQueueTestRun({ prompt: "hello" });
    replyOperation = createReplyOperation({
      sessionId: followupRun.run.sessionId,
      sessionKey: "agent:agent:main",
      resetTriggered: false,
    });

    createReplyAgentRestartRecoveryController({
      activeSessionStore: undefined,
      cfg: followupRun.run.config,
      followupRun,
      getActiveSessionEntry: () => undefined,
      replyOperation,
      restartRecoverySourceTurnId: undefined,
      sessionCtx: {},
      setActiveSessionEntry: vi.fn(),
    });

    expect(claimFactory).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleGeneration: replyOperation.lifecycleGeneration }),
    );
  });
});
