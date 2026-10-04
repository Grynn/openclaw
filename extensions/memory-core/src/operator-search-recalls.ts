import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveMemoryDreamingPluginConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { recordShortTermRecalls } from "./short-term-promotion.js";

/** Record search recall signals inside the long-lived memory plugin process. */
export async function recordOperatorMemorySearchRecalls(params: {
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  results: MemorySearchResult[];
}): Promise<void> {
  const pluginConfig = resolveMemoryDreamingPluginConfig(params.cfg);
  if (!resolveMemoryDreamingConfig({ pluginConfig, cfg: params.cfg }).enabled) {
    return;
  }
  const dreaming = resolveMemoryDeepDreamingConfig({ pluginConfig, cfg: params.cfg });
  await recordShortTermRecalls({
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
    query: params.query,
    results: params.results,
    ...(dreaming.timezone ? { timezone: dreaming.timezone } : {}),
  });
}
