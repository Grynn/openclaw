import { appendCurrentInboundContext } from "../../agents/embedded-agent-runner/run/runtime-context-prompt.js";
import type { SessionEntry } from "../../config/sessions.js";
import { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { readPendingUserTurnTranscriptAdmission } from "../../sessions/user-turn-transcript-admission.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import {
  scheduleFollowupDrainAfterReplyOperationClear,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { markPostCompactionModelFailurePayload } from "./agent-runner-failure-reply.js";
import { runMemoryFlushIfNeeded, runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { accountAgentTurnCompaction } from "./agent-runner-result-accounting.js";
import { finalizeReplyAgentRun } from "./agent-runner-result.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";
import { createBeforeAgentReplyRecoveryObserver } from "./before-agent-reply-recovery.js";
import type { CompactionNoticePhase } from "./compaction-notice.js";
import { createFollowupRunner } from "./followup-runner.js";
import { claimNextQueuedFollowupRequestFrom, enqueueFollowupRun } from "./queue.js";
import { FollowupRunDeferredError } from "./queue/types.js";
import { isReplyOperationSuperseded } from "./reply-operation-abort.js";
import { recordReplyOperationAgentTurn } from "./reply-operation-run-state.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { buildStalledTurnRecoveryRun, STALLED_TURN_GUIDANCE } from "./stalled-turn-recovery.js";

/** Continues a saved stalled request once, retaining its final-feedback obligation. */
export function continueStalledReplyTurn({
  followupRun,
  queueKey,
  resolvedQueue,
  replyOperation,
  runFollowupTurn,
}: Pick<RunReplyAgentParams, "followupRun" | "queueKey" | "resolvedQueue"> & {
  replyOperation: ReplyOperation;
  runFollowupTurn: FinalizeReplyAgentRunInput["runFollowupTurn"];
}): boolean {
  // Preflight can stall before admission persists the request. Transcript-only
  // recovery cannot answer that input; leave its notice with dispatch.
  if (followupRun.userTurnTranscriptRecorder?.hasPersisted() !== true) {
    return false;
  }
  try {
    followupRun.operatorAuthority?.assertCurrent();
  } catch {
    return false;
  }
  const queuedRequest = claimNextQueuedFollowupRequestFrom(queueKey, followupRun);
  if (queuedRequest) {
    // The handoff owns the same last-resort feedback as a dedicated recovery.
    queuedRequest.stalledTurnRecovery = true;
    queuedRequest.currentInboundContext = appendCurrentInboundContext(
      queuedRequest.currentInboundContext,
      [{ kind: "runtime-instruction", text: STALLED_TURN_GUIDANCE }],
    );
    return true;
  }
  // Group-thread participants declare no queued reply owner, so a recovery's
  // answer would be dropped; leave the notice with the stalled turn's dispatch.
  if (followupRun.queuedFollowupReplyDisposition?.kind === "drop") {
    return false;
  }
  const enqueued = enqueueFollowupRun(
    queueKey,
    buildStalledTurnRecoveryRun(followupRun),
    resolvedQueue,
    "none",
    runFollowupTurn,
    false,
    { position: "front" },
  );
  if (enqueued) {
    scheduleFollowupDrainAfterReplyOperationClear({
      operation: replyOperation,
      queueKey,
      runFollowup: runFollowupTurn,
    });
  }
  return enqueued;
}

type ExecutePreparedReplyAgentRunInput = Omit<
  FinalizeReplyAgentRunInput,
  "activeSessionEntry" | "preflightCompactionApplied" | "execution" | "runId" | "runStartedAt"
> &
  Pick<
    RunReplyAgentParams,
    "blockReplyChunking" | "toolProgressDetail" | "transcriptCommandBody" | "typing" | "typingMode"
  > & {
    admitUserTurn: ReturnType<typeof createReplyRestartRecoveryClaimController>["admitUserTurn"];
    applyReplyToMode: (payload: ReplyPayload) => ReplyPayload;
    beginBeforeAgentReply: ReturnType<
      typeof createReplyRestartRecoveryClaimController
    >["beginBeforeAgentReply"];
    checkpointBeforeAgentReply: ReturnType<
      typeof createReplyRestartRecoveryClaimController
    >["checkpointBeforeAgentReply"];
    resolveVisibleReplyDelivery: () => Promise<boolean>;
    getActiveSessionEntry: () => SessionEntry | undefined;
    isRestartRecoveryArmed: () => Promise<boolean>;
    sendDirectCompactionNotice: ((phase: CompactionNoticePhase) => Promise<void>) | undefined;
    setRunFollowupTurn: (runner: FinalizeReplyAgentRunInput["runFollowupTurn"]) => void;
    setActiveSessionEntry: (entry: SessionEntry | undefined) => void;
    shouldEmitToolOutput: () => boolean;
    shouldEmitToolResult: () => boolean;
    traceAgentPhase: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
    turnAdoptionLifecycle: NonNullable<RunReplyAgentParams["opts"]>["turnAdoptionLifecycle"];
  };

export async function executePreparedReplyAgentRun(
  input: ExecutePreparedReplyAgentRunInput,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  // Preserve the invocation snapshot across preparation; live session state uses its getters.
  const context = { ...input };
  const {
    activeSessionStore,
    admitUserTurn,
    beginBeforeAgentReply,
    cfg,
    checkpointBeforeAgentReply,
    defaultModel,
    followupRun,
    getActiveSessionEntry,
    opts,
    replyOperation,
    replyThreadingOverride,
    returnWithQueuedFollowupDrain,
    runtimePolicySessionKey,
    sendDirectCompactionNotice,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    setRunFollowupTurn,
    storePath,
    toolProgressDetail,
    traceAgentPhase,
    turnAdoptionLifecycle,
    typing,
    typingMode,
    typingSignals,
  } = context;
  let activeSessionEntry = getActiveSessionEntry();

  await typingSignals.signalRunStart();

  const preflightAdmission = readPendingUserTurnTranscriptAdmission(
    followupRun.userTurnTranscriptRecorder,
  );
  const checkpointMemory = async (entry: SessionEntry) => {
    const flushed = await traceAgentPhase("reply.memory_flush", () =>
      runMemoryFlushIfNeeded({
        ...context,
        preflightAdmission,
        promptForEstimate: followupRun.prompt,
        sessionEntry: entry,
        sessionStore: activeSessionStore,
      }),
    );
    setActiveSessionEntry(flushed.sessionEntry);
    replyOperation.abortSignal.throwIfAborted();
    if (flushed.outcome === "exhausted") {
      await sendDirectCompactionNotice?.("memory_flush_degraded");
    }
    return flushed.sessionEntry;
  };

  const prePreflightCompactionCount = activeSessionEntry?.compactionCount ?? 0;
  activeSessionEntry = await traceAgentPhase("reply.preflight_compaction", () =>
    runSessionCompactionIfNeeded({
      ...context,
      pendingUserEntryId: preflightAdmission?.entryId,
      promptForEstimate: followupRun.prompt,
      sessionEntry: activeSessionEntry,
      sessionStore: activeSessionStore,
      abortSignal: replyOperation.abortSignal,
      beforeCompaction: checkpointMemory,
      onCompactionStart: () => replyOperation.setPhase("preflight_compacting"),
      onSessionIdChanged: (sessionId) => replyOperation.updateSessionId(sessionId),
      onCompactionNotice: sendDirectCompactionNotice,
    }),
  );
  setActiveSessionEntry(activeSessionEntry);
  const preflightCompactionApplied =
    (activeSessionEntry?.compactionCount ?? 0) > prePreflightCompactionCount;

  const runFollowupTurn = createFollowupRunner({
    resolveGatewayContext: getGatewayContextResolver(replyOperation),
    opts,
    typing,
    typingMode,
    sessionEntry: activeSessionEntry,
    sessionStore: activeSessionStore,
    sessionKey,
    storePath,
    defaultModel,
    toolProgressDetail,
  });
  setRunFollowupTurn(runFollowupTurn);

  replyOperation.setPhase("running");
  const runStartedAt = Date.now();
  const userTurnAdmission = await admitUserTurn(followupRun.userTurnTranscriptRecorder);
  activeSessionEntry = getActiveSessionEntry();
  if (userTurnAdmission === "duplicate-source") {
    return returnWithQueuedFollowupDrain(undefined);
  }
  if (userTurnAdmission === "source-overlap") {
    throw new FollowupRunDeferredError("queued aggregate source changed before admission");
  }
  // Adoption marks run start and must never be spool-replayed (would re-run tools).
  // Suppressed delivery persists only the user transcript; crashed suppressed runs die
  // silently. Deliverable turns atomically persist transcript plus recovery ownership.
  await turnAdoptionLifecycle?.onAdopted();
  const runOutcome = await withBeforeAgentReplyObserver(
    createBeforeAgentReplyRecoveryObserver({
      agentId: followupRun.run.agentId,
      cfg,
      controller: { beginBeforeAgentReply, checkpointBeforeAgentReply },
      getActiveSessionEntry,
      opts,
      replyOperation,
      runtimePolicySessionKey,
      sessionCtx,
      sessionKey,
      storePath,
    }),
    () =>
      traceAgentPhase("reply.run_agent_turn", () =>
        executeAgentTurn({
          ...context,
          resolveVisibleReplyDelivery: input.resolveVisibleReplyDelivery,
          replyThreading: replyThreadingOverride ?? sessionCtx.ReplyThreading,
        }),
      ),
  );
  const operationSuperseded = isReplyOperationSuperseded(replyOperation);
  recordReplyOperationAgentTurn(
    followupRun.replyOperationRunStates,
    replyOperation,
    runOutcome.outcome,
  );
  activeSessionEntry = getActiveSessionEntry();

  if (runOutcome.outcome.kind !== "settled") {
    // Only captured facts cross cancellation; no successor adoption, hooks, or reply work.
    await accountAgentTurnCompaction({
      compaction: runOutcome.outcome.compaction,
      sessionStore: activeSessionStore,
      replyOperation,
    });
  }
  if (operationSuperseded) {
    return { text: SILENT_REPLY_TOKEN };
  }
  if (runOutcome.outcome.kind !== "settled") {
    if (runOutcome.outcome.kind === "rejected" && !replyOperation.result) {
      replyOperation.fail("run_failed", new Error("reply operation exited with final payload"));
    }
    return returnWithQueuedFollowupDrain(
      runOutcome.outcome.kind === "rejected"
        ? markPostCompactionModelFailurePayload(
            runOutcome.outcome.postCompactionModelFailure,
            runOutcome.outcome.payload,
          )
        : { text: SILENT_REPLY_TOKEN },
    );
  }

  const result = await finalizeReplyAgentRun({
    ...context,
    activeSessionEntry,
    preflightCompactionApplied,
    runFollowupTurn,
    execution: runOutcome.outcome,
    runId: runOutcome.runId,
    runStartedAt,
  });
  const { postCompactionModelFailure } = runOutcome.outcome;
  if (Array.isArray(result)) {
    return result.map((payload) =>
      markPostCompactionModelFailurePayload(postCompactionModelFailure, payload),
    );
  }
  return result
    ? markPostCompactionModelFailurePayload(postCompactionModelFailure, result)
    : result;
}
