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
import { runAfterReplyOperationClear, type ReplyOperation } from "./reply-run-registry.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

/** Binds the generic durable claim to one admitted reply operation and exact source route. */
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
  const restartRecoveryClaim = createReplyRestartRecoveryClaimController({
    admissionRunId:
      normalizeOptionalString(sessionCtx.MessageSid) ??
      normalizeOptionalString(sessionCtx.MessageSidFull),
    getEntry: () =>
      sessionKey
        ? (activeSessionStore?.[sessionKey] ?? getActiveSessionEntry())
        : getActiveSessionEntry(),
    getSessionId: () => replyOperation.sessionId,
    isRestartAbort: () =>
      replyOperation.result?.kind === "aborted" &&
      replyOperation.result.code === "aborted_for_restart",
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
  const {
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear: clearRestartRecoveryDeliveryClaim,
    isArmed: isRestartRecoveryArmed,
  } = restartRecoveryClaim;
  let recoveryWakeRegistered = false;
  const deferToRecovery = async (): Promise<boolean> => {
    const armed = await restartRecoveryClaim.deferToRecovery();
    if (!armed || recoveryWakeRegistered || !sessionKey || !storePath) {
      return armed;
    }
    recoveryWakeRegistered = true;
    runAfterReplyOperationClear(replyOperation, () => {
      scheduleMainSessionRecoveryPendingTarget({
        sessionId: replyOperation.sessionId,
        sessionKey,
        storePath,
      });
    });
    return true;
  };
  return {
    admitUserTurn,
    beginBeforeAgentReply,
    checkpointBeforeAgentReply,
    clear: clearRestartRecoveryDeliveryClaim,
    deferToRecovery,
    isArmed: isRestartRecoveryArmed,
    isTracked: restartRecoveryClaim.isTracked,
  };
}
