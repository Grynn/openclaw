import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue/types.js";
import { setChannelSourceTurnId } from "./source-turn-id.js";

type FollowupTemplateContextSource = {
  queued: FollowupRun;
  session: { kind: "detached" } | { kind: "session"; key: string };
};

/** Rebuilds the exact source-channel context captured by an admitted queued turn. */
export function buildFollowupTemplateContext(turn: FollowupTemplateContextSource): TemplateContext {
  const queued = turn.queued;
  const run = queued.run;
  const surface = queued.originatingChannel ?? run.messageProvider;
  const sessionKey = turn.session.kind === "session" ? turn.session.key : run.sessionKey;
  const currentMessageId =
    run.inputProvenance?.kind === "internal_system" &&
    run.inputProvenance.sourceTool === "restart-sentinel"
      ? queued.originatingReplyToId
      : queued.messageId;
  const context = {
    Provider: run.messageProvider,
    Surface: surface,
    OriginatingChannel: queued.originatingChannel,
    OriginatingTo: queued.originatingTo,
    To: queued.originatingTo,
    AccountId: queued.originatingAccountId ?? run.agentAccountId,
    ChatType: queued.originatingChatType ?? run.chatType,
    SessionKey: sessionKey,
    RuntimePolicySessionKey: run.runtimePolicySessionKey ?? sessionKey,
    MessageSid: currentMessageId,
    MessageSidFull: currentMessageId,
    MessageThreadId: queued.originatingThreadId,
    ReplyToId: queued.originatingReplyToId,
    SenderId: run.senderId,
    MemberRoleIds: run.memberRoleIds,
    ChannelContext: run.channelContext,
    SenderName: run.senderName,
    SenderUsername: run.senderUsername,
    SenderE164: run.senderE164,
    GroupChannel: run.groupChannel,
    GroupSpace: run.groupSpace,
    InputProvenance: run.inputProvenance,
    InboundEventKind: queued.currentInboundEventKind,
    media: queued.media,
  } as TemplateContext;
  setChannelSourceTurnId(context, queued.restartRecovery?.sourceTurnId);
  return context;
}
