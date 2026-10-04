import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { scheduleMainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-owner-release.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveReplyRunDeliveryContext,
  resolveSourceReplyPolicy,
  type RunReplyAgentParams,
} from "./agent-runner-core.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import {
  replyRunRegistry,
  runAfterReplyOperationClear,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";
import { resolveReplySourceTurnId } from "./source-turn-id.js";

export function createReplyAgentRestartRecoveryController(
  context: Pick<
    RunReplyAgentParams,
    "followupRun" | "opts" | "runtimePolicySessionKey" | "sessionCtx" | "sessionKey" | "storePath"
  > & {
    activeSessionStore: Record<string, SessionEntry> | undefined;
    cfg: OpenClawConfig;
    getActiveSessionEntry: () => SessionEntry | undefined;
    replyOperation: ReplyOperation;
    restartRecoverySourceTurnId: string | undefined;
    restartRecoveryConstituentSourceTurnIds?: readonly string[];
    setActiveSessionEntry: (entry: SessionEntry) => void;
  },
) {
  const {
    activeSessionStore,
    cfg,
    followupRun,
    getActiveSessionEntry,
    opts,
    replyOperation,
    restartRecoverySourceTurnId,
    restartRecoveryConstituentSourceTurnIds,
    runtimePolicySessionKey,
    sessionCtx,
    sessionKey,
    setActiveSessionEntry,
    storePath,
  } = context;

  const restartRecoverySameChannelThreadRequired = restartRecoverySourceTurnId
    ? buildThreadingToolContext({
        sessionCtx,
        config: cfg,
        hasRepliedRef: undefined,
      }).sameChannelThreadRequired
    : undefined;
  const admissionRunId =
    normalizeOptionalString(sessionCtx.MessageSid) ??
    normalizeOptionalString(sessionCtx.MessageSidFull);
  const recovery = createReplyRestartRecoveryClaimController({
    agentId: followupRun.run.agentId,
    lifecycleGeneration: replyOperation.lifecycleGeneration,
    admissionRunId,
    getEntry: () =>
      sessionKey
        ? (activeSessionStore?.[sessionKey] ?? getActiveSessionEntry())
        : getActiveSessionEntry(),
    getSessionId: () => replyOperation.sessionId,
    isRestartAbort: () =>
      replyOperation.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_for_restart",
    assertRecoveryDeferralCurrent: () => {
      replyOperation.abortSignal.throwIfAborted();
      followupRun.operatorAuthority?.assertCurrent();
    },
    resolveDeliveryContext: (entry) =>
      sessionKey
        ? resolveReplyRunDeliveryContext({
            cfg,
            sessionCtx,
            sessionEntry: entry,
            sessionKey,
            runtimePolicySessionKey,
            opts,
          })
        : undefined,
    requesterAccountId:
      followupRun.originatingAccountId ?? sessionCtx.AccountId ?? followupRun.run.agentAccountId,
    requesterSenderId: sessionCtx.SenderId,
    resolveUserTurnTarget: ({
      entry,
      sessionId,
      sessionKey: targetSessionKey,
      storePath: targetStorePath,
    }) => ({
      sessionId,
      sessionKey: targetSessionKey,
      sessionEntry: entry,
      ...(activeSessionStore ? { sessionStore: activeSessionStore } : {}),
      storePath: targetStorePath,
      agentId: followupRun.run.agentId,
      cwd: followupRun.run.workspaceDir,
      config: cfg,
    }),
    ...(sessionKey ? { sessionKey } : {}),
    setEntry: (entry) => {
      setActiveSessionEntry(entry);
      if (activeSessionStore && sessionKey) {
        activeSessionStore[sessionKey] = entry;
      }
    },
    sameChannelThreadRequired: restartRecoverySameChannelThreadRequired,
    sourceTurnId: restartRecoverySourceTurnId,
    constituentSourceTurnIds: restartRecoveryConstituentSourceTurnIds,
    sourceReplyDeliveryMode: sessionKey
      ? resolveSourceReplyPolicy({
          cfg,
          sessionCtx,
          sessionEntry: getActiveSessionEntry(),
          sessionKey,
          runtimePolicySessionKey,
          opts,
        }).sourceReplyDeliveryMode
      : opts?.sourceReplyDeliveryMode,
    ...(storePath ? { storePath } : {}),
  });
  let recoveryWakeRegistered = false;
  const deferToRecovery = async (cause?: unknown): Promise<boolean> => {
    const armed = await recovery.deferToRecovery(cause);
    if (!armed || recoveryWakeRegistered || !sessionKey || !storePath) {
      return armed;
    }
    recoveryWakeRegistered = true;
    runAfterReplyOperationClear(replyOperation, () => {
      scheduleMainSessionRecoveryPendingTarget({
        agentId: followupRun.run.agentId,
        sessionId: replyOperation.sessionId,
        sessionKey,
        storePath,
      });
    });
    return true;
  };
  return {
    ...recovery,
    deferToRecovery,
    admitUserTurn: async (...args: Parameters<typeof recovery.admitUserTurn>) => {
      const result = await recovery.admitUserTurn(...args);
      if (result === "admitted") {
        const sourceTurnId = resolveReplySourceTurnId({
          sourceTurnId: restartRecoverySourceTurnId,
          admissionRunId,
          ingressProvider: sessionCtx.Provider ?? sessionCtx.Surface,
          entry: getActiveSessionEntry(),
        });
        if (sourceTurnId) {
          replyRunRegistry.bindSourceTurnId(replyOperation, sourceTurnId);
        }
      }
      return result;
    },
  };
}
