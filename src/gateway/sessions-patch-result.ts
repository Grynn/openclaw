import type { ErrorShape, SessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { isSubagentSessionFromEntry } from "../agents/subagents/spawn/subagent-depth-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import type { SessionAcpMeta } from "../config/sessions/types.js";

export type SessionPatchProjectionResult =
  | {
      ok: true;
      entry: SessionEntry;
      modelSelectionSessionOnly?: boolean;
      validateModelSelection?: () => ErrorShape | undefined;
    }
  | { ok: false; error: ErrorShape };

/** Completes a successful projection and classifies its model selection's locality. */
export function sessionPatchSuccess(params: {
  storeKey: string;
  entry: SessionEntry;
  patch: Pick<SessionsPatchParams, "model">;
  acpMeta: SessionAcpMeta | undefined;
  validateModelSelection: (() => ErrorShape | undefined) | undefined;
}): SessionPatchProjectionResult {
  const { storeKey, entry, patch, acpMeta, validateModelSelection } = params;
  return {
    ok: true,
    entry,
    // Reuse the canonical ACP join that admitted this selection; do not reload it after commit.
    ...(typeof patch.model === "string" && isSubagentSessionFromEntry(storeKey, entry, acpMeta)
      ? { modelSelectionSessionOnly: true }
      : {}),
    ...(validateModelSelection ? { validateModelSelection } : {}),
  };
}
