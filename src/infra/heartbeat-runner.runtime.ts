// Lazy heartbeat runtime facade keeps tests from importing the full auto-reply
// runtime unless the runner path needs it.
import { loadPublishedGatewayReplyDispatchRuntime } from "../agents/prepared-model-runtime.js";
import { getReplyFromConfigWithoutPublishedRuntime } from "../auto-reply/reply.js";
import { bindPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

/** Runs a heartbeat against the exact config, credentials, and catalog generation published by Gateway. */
export async function getReplyFromConfig(
  ...args: Parameters<typeof getReplyFromConfigWithoutPublishedRuntime>
): Promise<Awaited<ReturnType<typeof getReplyFromConfigWithoutPublishedRuntime>>> {
  const [ctx, opts, configOverride] = args;
  const explicitAgentId = typeof ctx.AgentId === "string" ? ctx.AgentId.trim() : "";
  const sessionAgentId = explicitAgentId
    ? undefined
    : parseAgentSessionKey(ctx.SessionKey)?.agentId;
  const agentId = explicitAgentId || sessionAgentId;
  if (!agentId) {
    return await getReplyFromConfigWithoutPublishedRuntime(ctx, opts, configOverride);
  }

  const preparedRuntime = await loadPublishedGatewayReplyDispatchRuntime({
    agentId: normalizeAgentId(agentId),
  });
  if (!preparedRuntime) {
    return await getReplyFromConfigWithoutPublishedRuntime(ctx, opts, configOverride);
  }

  // A scheduler may retain the source config across SecretRef materialization or hot reload.
  // The published runtime owns the live resolved config, catalog, auth, and plugin generation.
  return await bindPreparedReplyDispatchRuntime(
    preparedRuntime,
    getReplyFromConfigWithoutPublishedRuntime,
  )(ctx, opts);
}
