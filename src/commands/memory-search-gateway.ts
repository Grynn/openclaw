import { theme } from "../../packages/terminal-core/src/theme.js";
import { callGatewayFromCli } from "../cli/gateway-rpc.js";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";

type MemorySearchGatewayArgs = {
  query: string;
  agent?: string;
  maxResults?: number;
  minScore?: number;
  json: boolean;
};

type MemorySearchGatewayResponse = {
  agentId: string;
  provider: string;
  searchMode: "hybrid" | "fts-only";
  results: MemorySearchResult[];
  stale?: true;
  warning?: string;
  action?: string;
};

/** Search through the Gateway's watched, shared memory manager. */
export async function memorySearchGatewayCommand(
  args: MemorySearchGatewayArgs,
  runtime: OutputRuntimeEnv,
): Promise<boolean> {
  let response: MemorySearchGatewayResponse;
  try {
    response = (await callGatewayFromCli(
      "memory.search",
      { timeout: "30000" },
      {
        query: args.query,
        recordRecall: true,
        ...(args.agent ? { agentId: args.agent } : {}),
        ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
        ...(args.minScore === undefined ? {} : { minScore: args.minScore }),
      },
      { mode: "cli", scopes: ["operator.read"] },
    )) as MemorySearchGatewayResponse;
  } catch {
    // Let Commander use the existing local manager when the Gateway is offline
    // or older than the memory.search RPC surface.
    return false;
  }
  if (!response || !Array.isArray(response.results)) {
    return false;
  }
  if (args.json) {
    runtime.writeJson(
      {
        results: response.results,
        ...(response.stale
          ? {
              stale: true,
              warning: response.warning,
              action: response.action,
            }
          : {}),
      },
      2,
    );
    return true;
  }
  if (response.stale && response.warning) {
    runtime.error(`${response.warning}${response.action ? ` ${response.action}` : ""}`);
  }
  if (response.results.length === 0) {
    runtime.log("No matches.");
    return true;
  }
  const lines: string[] = [];
  for (const result of response.results) {
    lines.push(
      `${theme.success(result.score.toFixed(3))} ${theme.accent(`${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`)}`,
      theme.muted(result.snippet),
      "",
    );
  }
  runtime.log(lines.join("\n").trim());
  return true;
}
