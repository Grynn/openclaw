import type { SessionsPatchParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAcpSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import { isAgentSessionModelPatchOrigin } from "../session-model-patch-origin.js";

export function persistSessionPatchModelSelection(params: {
  callerScopes: readonly string[];
  cfg: OpenClawConfig;
  entry: SessionEntry;
  patch: SessionsPatchParams;
  sessionKey: string;
  targetAgentId: string;
}): void {
  if (
    isAgentSessionModelPatchOrigin() ||
    isSubagentSessionKey(params.sessionKey) ||
    isAcpSessionKey(params.sessionKey) ||
    (params.entry.spawnDepth ?? 0) > 0 ||
    Boolean(params.entry.spawnedBy?.trim()) ||
    Boolean(params.entry.parentSessionKey?.trim()) ||
    typeof params.patch.model !== "string" ||
    !params.callerScopes.includes(ADMIN_SCOPE) ||
    params.entry.modelOverrideSource !== "user" ||
    !params.entry.providerOverride ||
    !params.entry.modelOverride
  ) {
    return;
  }
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.targetAgentId,
  });
  const resolved = resolveSessionModelRef(params.cfg, params.entry, agentId);
  persistStickyModelSelectionBestEffort({
    agentId,
    model: `${resolved.provider}/${resolved.model}`,
  });
}
