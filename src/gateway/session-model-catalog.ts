import { PreparedModelCatalogConfigReplacedError } from "../agents/prepared-model-catalog.errors.js";
import { preparedModelRuntimeConfigsMatch } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";

/**
 * Projects catalog entries only after proving that a durable session mutation and
 * its prepared catalog still share the same agent/config owner.
 */
export function projectSessionMutationModelCatalog(params: {
  agentId: string;
  config: OpenClawConfig;
  snapshot: GatewayModelCatalogSnapshot;
}) {
  const requestedAgentId = normalizeAgentId(params.agentId);
  if (params.snapshot.agentId !== requestedAgentId) {
    throw new Error(
      `session model catalog resolved agent "${params.snapshot.agentId}" instead of "${requestedAgentId}"`,
    );
  }
  if (!preparedModelRuntimeConfigsMatch(params.snapshot.config, params.config)) {
    throw new PreparedModelCatalogConfigReplacedError(params.snapshot.agentDir);
  }
  return params.snapshot.entries;
}
