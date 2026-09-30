import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { callGatewayFromCli, canFallbackToImplicitLocalGateway } from "../cli/gateway-rpc.js";
import { readGatewayDispatchConfigWithShellEnvFallback } from "../config/gateway-dispatch-config.js";
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
  results: Array<Pick<MemorySearchResult, "path" | "startLine" | "endLine" | "score" | "snippet">>;
  stale?: true;
  warning?: string;
  action?: string;
};

function isMemorySearchGatewayResponse(value: unknown): value is MemorySearchGatewayResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.results) &&
    value.results.every(
      (result: unknown) =>
        isRecord(result) &&
        typeof result.path === "string" &&
        typeof result.startLine === "number" &&
        typeof result.endLine === "number" &&
        typeof result.score === "number" &&
        typeof result.snippet === "string",
    ) &&
    (value.stale === undefined || value.stale === true) &&
    (value.warning === undefined || typeof value.warning === "string") &&
    (value.action === undefined || typeof value.action === "string")
  );
}

/** Search through the Gateway's watched, shared memory manager. */
export async function memorySearchGatewayCommand(
  args: MemorySearchGatewayArgs,
  runtime: OutputRuntimeEnv,
): Promise<boolean> {
  let response: MemorySearchGatewayResponse;
  try {
    const result = await callGatewayFromCli(
      "memory.search",
      { timeout: "30000" },
      {
        query: args.query,
        recordRecall: true,
        ...(args.agent ? { agentId: args.agent } : {}),
        ...(args.maxResults === undefined ? {} : { maxResults: args.maxResults }),
        ...(args.minScore === undefined ? {} : { minScore: args.minScore }),
      },
      { mode: "cli", scopes: ["operator.read", "operator.write"] },
    );
    if (!isMemorySearchGatewayResponse(result)) {
      return false;
    }
    response = result;
  } catch (error) {
    const config = await readGatewayDispatchConfigWithShellEnvFallback();
    if (
      !(await canFallbackToImplicitLocalGateway({
        config,
        error,
        legacyMethod: "memory.search",
      }))
    ) {
      throw error;
    }
    // Commander can use the existing local manager for an unavailable implicit
    // local Gateway or one older than the memory.search RPC surface.
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
