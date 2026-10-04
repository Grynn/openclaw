/** Projects normalized wire metadata without owning transport or catalog lifetime. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  McpCatalogTool,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
} from "./agent-bundle-mcp-types.js";
import { readMcpAppToolExtensions } from "./mcp-app-extension-metadata.js";
import { normalizeMcpCodexToolAnnotations } from "./mcp-codex-tool-approval.js";
import { isMcpServiceAvailabilityError, redactMcpDiagnosticError } from "./mcp-error.js";
import { normalizeToolUiVisibility, sanitizeMcpMetadataText } from "./mcp-metadata.js";
import { McpStartupBackoffError } from "./mcp-startup-backoff.js";
import type { normalizeMcpToolCatalog } from "./mcp-tool-metadata.js";

/** Projects a catalog failure without deciding transport retirement or logging policy. */
export function projectBundleMcpCatalogFailure(params: {
  error: unknown;
  serverName: string;
  safeServerName: string;
  launchDescription: string;
}): {
  retryAfterMs: number | undefined;
  reportFailure: boolean;
  diagnostic: McpToolCatalogDiagnostic;
} {
  const { error } = params;
  const backoff = error instanceof McpStartupBackoffError ? error : undefined;
  const serviceUnavailable = backoff
    ? backoff.serviceUnavailable
    : isMcpServiceAvailabilityError(error);
  return {
    retryAfterMs: backoff?.retryAfterMs,
    reportFailure: backoff?.reportFailure ?? true,
    diagnostic: {
      serverName: params.serverName,
      safeServerName: params.safeServerName,
      launchSummary: params.launchDescription,
      message: redactMcpDiagnosticError(error),
      ...(serviceUnavailable ? { errorCode: "mcp-service-unavailable" } : {}),
    },
  };
}

export function projectBundleMcpCatalogTools({
  normalizedTools,
  deniedToolNames,
  serverName,
  safeServerName,
  launchDescription,
}: {
  normalizedTools: ReturnType<typeof normalizeMcpToolCatalog>;
  deniedToolNames: ReadonlySet<string>;
  serverName: string;
  safeServerName: string;
  launchDescription: string;
}): Pick<McpToolCatalog, "tools" | "policyTools" | "sessionDeniedTools"> {
  const toolEntries: McpCatalogTool[] = [];
  const policyToolEntries: McpCatalogTool[] = [];
  for (const [tool, excludedFromOpenClawCatalog, deniedBySession] of [
    ...normalizedTools.tools.map((entry) => [entry, false, false] as const),
    ...normalizedTools.deniedTools.map((entry) => [entry, false, true] as const),
    ...normalizedTools.excludedTools.map(
      (entry) => [entry, true, deniedToolNames.has(entry.name)] as const,
    ),
  ]) {
    const { _meta: metadata } = tool;
    const uiMeta = asOptionalRecord(metadata?.ui);
    const rawResourceUri = uiMeta?.resourceUri ?? metadata?.["ui/resourceUri"];
    const uiResourceUri =
      typeof rawResourceUri === "string" && rawResourceUri.startsWith("ui://")
        ? rawResourceUri
        : undefined;
    const uiVisibility = normalizeToolUiVisibility(uiMeta?.visibility);
    const entry: McpCatalogTool = {
      serverName,
      safeServerName,
      toolName: tool.name,
      title: tool.title ?? tool.annotations?.title,
      appExtensions: readMcpAppToolExtensions(tool),
      description: sanitizeMcpMetadataText(tool.description),
      inputSchema: tool.inputSchema,
      fallbackDescription: `Provided by bundle MCP server "${serverName}" (${launchDescription}).`,
      ...(uiResourceUri ? { uiResourceUri } : {}),
      ...(uiVisibility ? { uiVisibility } : {}),
      ...(excludedFromOpenClawCatalog ? { excludedFromOpenClawCatalog: true as const } : {}),
      ...(deniedBySession ? { deniedBySession: true } : {}),
      codexAnnotations: normalizeMcpCodexToolAnnotations(tool.annotations),
    };
    policyToolEntries.push(entry);
    if (!entry.excludedFromOpenClawCatalog) {
      toolEntries.push(entry);
    }
  }
  return {
    tools: toolEntries.filter((tool) => !tool.deniedBySession),
    policyTools: policyToolEntries,
    sessionDeniedTools: toolEntries.filter((tool) => tool.deniedBySession),
  };
}
