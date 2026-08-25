import crypto from "node:crypto";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { withBeforeAgentReplyObserver } from "../../plugins/before-agent-reply.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { resolveReplyRunDeliveryContext, resolveSourceReplyPolicy } from "./agent-runner-core.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import {
  buildRecoverablePendingFinalDeliveryText,
  normalizePendingFinalDeliveryPayloads,
} from "./pending-final-delivery.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import type { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

type RestartRecoveryHookController = Pick<
  ReturnType<typeof createReplyRestartRecoveryClaimController>,
  "beginBeforeAgentReply" | "checkpointBeforeAgentReply"
>;

/** Shares the exact hook-side-effect checkpoint policy across direct and queued turns. */
export function createBeforeAgentReplyRecoveryObserver(params: {
  cfg: OpenClawConfig;
  controller: RestartRecoveryHookController;
  getActiveSessionEntry: () => SessionEntry | undefined;
  opts?: InternalGetReplyOptions;
  replyOperation: ReplyOperation;
  runtimePolicySessionKey?: string;
  sessionCtx: TemplateContext;
  sessionKey?: string;
  storePath?: string;
}): Parameters<typeof withBeforeAgentReplyObserver>[0] {
  return {
    beforeDispatch: async () => await params.controller.beginBeforeAgentReply(),
    afterDispatch: async (hookResult) => {
      if (!hookResult?.handled) {
        await params.controller.checkpointBeforeAgentReply({ state: undefined });
        return hookResult;
      }
      const hookReply = hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
      const hookFinalDeliveryText = buildRecoverablePendingFinalDeliveryText([hookReply]);
      const normalizedHookReplies = normalizePendingFinalDeliveryPayloads([hookReply]);
      let hookCheckpoint: Parameters<
        RestartRecoveryHookController["checkpointBeforeAgentReply"]
      >[0] = {
        state: normalizedHookReplies.length === 0 ? "handled-silent" : "pending",
      };
      const activeSessionEntry = params.getActiveSessionEntry();
      if (params.sessionKey && params.storePath && normalizedHookReplies.length > 0) {
        const sourceReplyPolicy = resolveSourceReplyPolicy({
          cfg: params.cfg,
          sessionCtx: params.sessionCtx,
          sessionEntry: activeSessionEntry,
          sessionKey: params.sessionKey,
          runtimePolicySessionKey: params.runtimePolicySessionKey,
          opts: params.opts,
        });
        if (!sourceReplyPolicy.suppressDelivery) {
          const intentId = crypto.randomUUID();
          const deliveryId = crypto.randomUUID();
          setReplyPayloadMetadata(hookReply, {
            pendingFinalDeliveryCompletion: {
              deliveryId,
              intentId,
              ...(activeSessionEntry?.restartRecoveryDeliveryRunId
                ? { recoveryRunId: activeSessionEntry.restartRecoveryDeliveryRunId }
                : {}),
              sessionId: params.replyOperation.sessionId,
              sessionKey: params.sessionKey,
              storePath: params.storePath,
            },
          });
          hookCheckpoint = {
            state: "handled-reply",
            pendingFinalDelivery: {
              text: hookFinalDeliveryText ?? "",
              intentId,
              deliveries: [{ id: deliveryId, state: "prepared" }],
              context: resolveReplyRunDeliveryContext({
                cfg: params.cfg,
                sessionCtx: params.sessionCtx,
                sessionEntry: activeSessionEntry,
                sessionKey: params.sessionKey,
                runtimePolicySessionKey: params.runtimePolicySessionKey,
                opts: params.opts,
              }),
            },
          };
        } else {
          // Dispatch owns source visibility for every returned payload.
          hookCheckpoint = { state: "handled-silent" };
        }
      }
      await params.controller.checkpointBeforeAgentReply(hookCheckpoint);
      return { ...hookResult, reply: hookReply };
    },
  };
}
