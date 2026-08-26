import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  admitLifecycle: vi.fn(),
  admitReply: vi.fn(),
  claimAdmit: vi.fn(),
  claimClear: vi.fn(),
  claimDefer: vi.fn(),
  claimIsTracked: vi.fn(),
  preflight: vi.fn(),
}));

vi.mock("./agent-runner-auto-fallback.js", () => ({
  resolveRunAfterAutoFallbackPrimaryProbeRecheck: ({ run }: { run: unknown }) => run,
}));

vi.mock("./agent-restart-recovery-controller.js", () => ({
  createReplyAgentRestartRecoveryController: () => ({
    admitUserTurn: (...args: unknown[]) => state.claimAdmit(...args),
    beginBeforeAgentReply: vi.fn(),
    checkpointBeforeAgentReply: vi.fn(),
    clear: (...args: unknown[]) => state.claimClear(...args),
    deferToRecovery: (...args: unknown[]) => state.claimDefer(...args),
    isArmed: vi.fn(() => false),
    isTracked: (...args: unknown[]) => state.claimIsTracked(...args),
  }),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runPreflightCompactionIfNeeded: (...args: unknown[]) => state.preflight(...args),
}));

vi.mock("./agent-runner-utils.js", () => ({
  resolveQueuedReplyExecutionConfig: (config: unknown) => Promise.resolve(config),
  resolveQueuedReplyRuntimeConfig: (config: unknown) => config,
}));

vi.mock("./reply-turn-admission.js", () => ({
  admitReplyTurn: (...args: unknown[]) => state.admitReply(...args),
}));

vi.mock("./queue.js", () => ({
  admitFollowupRunLifecycle: (...args: unknown[]) => state.admitLifecycle(...args),
  isFollowupRunAborted: (run: FollowupRun) =>
    run.abortSignal?.aborted === true || run.queueAbortSignal?.aborted === true,
  resolveFollowupAbortSignal: (run: FollowupRun) => run.abortSignal ?? run.queueAbortSignal,
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({ loadSessionEntry: () => undefined }));
vi.mock("../../sessions/send-policy.js", () => ({ resolveSendPolicy: () => "allow" }));
vi.mock("./inbound-meta.js", () => ({ refreshActiveGoalContext: (context: unknown) => context }));
vi.mock("./compaction-notice.js", () => ({
  createCompactionNoticePayload: ({ phase }: { phase: string }) => ({ text: phase }),
  shouldNotifyUserAboutCompaction: () => false,
}));
vi.mock("./agent-runner-failure-reply.js", () => ({
  buildPreflightCompactionFailureText: () => "preflight failed",
}));

const { admitFollowupTurn } = await import("./followup-turn-admission.js");

function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "queued-session",
      sessionKey: "main",
      sessionFile: "/tmp/queued.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

function createOperation() {
  return {
    sessionId: "queued-session",
    abortForRestart: vi.fn(() => true),
    retainFailureUntilComplete: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
}

function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    typing: {} as never,
    typingMode: "never" as const,
    defaultModel: "claude",
    sessionKey: "main",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.claimAdmit.mockResolvedValue("admitted");
  state.claimClear.mockResolvedValue(undefined);
  state.claimDefer.mockResolvedValue(true);
  state.claimIsTracked.mockReturnValue(false);
  state.preflight.mockImplementation(async ({ sessionEntry }) => sessionEntry);
  state.admitLifecycle.mockResolvedValue(undefined);
});

describe("admitFollowupTurn restart recovery custody", () => {
  it("persists queued recovery custody before adopting the source", async () => {
    const order: string[] = [];
    const operation = createOperation();
    const recorder = { hasPersisted: () => false } as never;
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.preflight.mockImplementation(async ({ sessionEntry }) => {
      order.push("preflight");
      return sessionEntry;
    });
    state.claimAdmit.mockImplementation(async () => {
      order.push("claim");
      return "admitted";
    });
    state.admitLifecycle.mockImplementation(async () => {
      order.push("source-adopted");
    });

    const result = await admitFollowupTurn({
      queued: createRun({
        restartRecovery: { sourceTurnId: "channel-user:v1:stable" },
        userTurnTranscriptRecorder: recorder,
      }),
      defaults: createDefaults({
        opts: { onQueuedFollowupAdmitted: () => order.push("presentation-admitted") },
      }),
    });

    expect(result.kind).toBe("admitted");
    expect(state.claimAdmit).toHaveBeenCalledWith(recorder);
    expect(order).toEqual(["preflight", "claim", "source-adopted", "presentation-admitted"]);
  });

  it("defers a partially overlapping aggregate before adopting any source", async () => {
    const operation = createOperation();
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.claimAdmit.mockResolvedValue("source-overlap");

    await expect(
      admitFollowupTurn({
        queued: createRun({
          restartRecovery: {
            sourceTurnId: "followup-collect:aggregate",
            constituentSourceTurnIds: ["channel-user:v1:old", "channel-user:v1:fresh"],
          },
          userTurnTranscriptRecorder: { hasPersisted: () => false } as never,
        }),
        defaults: createDefaults(),
      }),
    ).resolves.toEqual({ kind: "deferred", reason: "source-overlap" });

    expect(state.admitLifecycle).not.toHaveBeenCalled();
    expect(state.claimClear).not.toHaveBeenCalled();
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("does not adopt a queued source when durable claim persistence fails", async () => {
    const operation = createOperation();
    const failure = new Error("claim persistence failed");
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.claimAdmit.mockRejectedValue(failure);

    await expect(
      admitFollowupTurn({
        queued: createRun({
          restartRecovery: { sourceTurnId: "channel-user:v1:stable" },
          userTurnTranscriptRecorder: { hasPersisted: () => false } as never,
        }),
        defaults: createDefaults(),
      }),
    ).rejects.toBe(failure);

    expect(state.admitLifecycle).not.toHaveBeenCalled();
    expect(state.claimClear).toHaveBeenCalledOnce();
    expect(operation.complete).toHaveBeenCalledOnce();
  });

  it("hands an admitted durable source to recovery when source adoption fails", async () => {
    const operation = createOperation();
    const failure = new Error("source adoption failed");
    state.admitReply.mockResolvedValue({ status: "owned", operation });
    state.claimIsTracked.mockReturnValue(true);
    state.admitLifecycle.mockRejectedValue(failure);

    await expect(
      admitFollowupTurn({
        queued: createRun({
          restartRecovery: { sourceTurnId: "channel-user:v1:stable" },
          userTurnTranscriptRecorder: { hasPersisted: () => false } as never,
        }),
        defaults: createDefaults(),
      }),
    ).resolves.toMatchObject({
      kind: "skipped",
      reason: "recovery-scheduled",
      operation,
    });

    expect(state.claimDefer).toHaveBeenCalledOnce();
    expect(state.claimClear).not.toHaveBeenCalled();
    expect(operation.fail).toHaveBeenCalledWith("run_failed", failure);
    expect(operation.complete).toHaveBeenCalledOnce();
  });
});
