import { formatErrorMessage } from "../../infra/errors.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../agent-bundle-mcp-tools.js";
import { log } from "./logger.js";

export async function retireEmbeddedMcp(params: {
  sessionId: string;
  sessionKey?: string;
}): Promise<void> {
  const onError = (error: unknown, sessionId: string) => {
    log.warn(`bundle-mcp cleanup failed after run for ${sessionId}: ${formatErrorMessage(error)}`);
  };
  const retiredBySessionKey = await retireSessionMcpRuntimeForSessionKey({
    sessionKey: params.sessionKey,
    reason: "embedded-run-end",
    // MCP App views hold bounded leases so their bridge can remain
    // usable after a one-shot gateway run returns.
    preserveActiveLeases: true,
    onError,
  });
  if (retiredBySessionKey) {
    return;
  }
  await retireSessionMcpRuntime({
    sessionId: params.sessionId,
    reason: "embedded-run-end",
    preserveActiveLeases: true,
    onError,
  });
}
