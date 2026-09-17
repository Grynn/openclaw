/**
 * Input-schema enforcement for Codex dynamic tool calls: which tools are
 * validated, the bounded rejection text Codex sees, and the schema a given call
 * is validated against.
 */
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { getPluginToolMeta } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { DIRECT_SOURCE_REPLY_MESSAGE_SCHEMA } from "./dynamic-tool-catalog.js";
import type { CodexDynamicToolSpec, JsonValue } from "./protocol.js";

const INTERNAL_TOOL_EXECUTION_VALIDATION = Symbol.for("openclaw.internalToolExecutionValidation");
const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS = 4;
const MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS = 160;
const CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX = " [detail truncated]";

export function shouldValidateCodexDynamicToolInput(tool: AnyAgentTool): boolean {
  return getPluginToolMeta(tool)?.mcp?.operation !== "tool";
}

/**
 * Root `message` publishes a narrowed source-reply contract while the full
 * manager stays reachable as deferred `openclaw.message`. The published spec is
 * the dispatch contract, so it is read back here instead of recomputing the
 * catalog's direct/deferred policy; the two can then never disagree.
 */
export function resolveCodexNarrowedRootMessageSchema(params: {
  specs: readonly CodexDynamicToolSpec[];
  toolName: string;
  namespace?: string | null;
}): (JsonSchemaObject & JsonValue) | undefined {
  if (params.toolName !== "message" || (params.namespace ?? null) !== null) {
    return undefined;
  }
  const publishesNarrowedRoot = params.specs.some(
    (spec) =>
      spec.type === "function" &&
      spec.name === "message" &&
      spec.inputSchema === DIRECT_SOURCE_REPLY_MESSAGE_SCHEMA,
  );
  return publishesNarrowedRoot ? DIRECT_SOURCE_REPLY_MESSAGE_SCHEMA : undefined;
}

export function assertCodexDynamicToolInputMatchesSchema(params: {
  toolName: string;
  schema: JsonSchemaObject;
  value: unknown;
}): void {
  const validation = validateJsonSchemaValue({
    schema: params.schema,
    cacheKey: `codex-dynamic-tool-input:${params.toolName}:${JSON.stringify(params.schema)}`,
    value: params.value,
  });
  if (validation.ok) {
    return;
  }
  const visibleErrors = validation.errors.slice(0, MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERRORS);
  const details = visibleErrors
    .map((error) => {
      if (error.text.length <= MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS) {
        return error.text;
      }
      return `${error.text.slice(
        0,
        MAX_CODEX_DYNAMIC_TOOL_VALIDATION_ERROR_CHARS -
          CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX.length,
      )}${CODEX_DYNAMIC_TOOL_VALIDATION_TRUNCATED_SUFFIX}`;
    })
    .join("; ");
  const omitted = validation.errors.length - visibleErrors.length;
  const omittedSuffix = omitted > 0 ? `; ${omitted} more violation(s) omitted` : "";
  throw new Error(`Invalid arguments for tool "${params.toolName}": ${details}${omittedSuffix}.`);
}

export function createCodexDynamicToolValidationControl(params: {
  toolCallId: string;
  validate: (value: unknown) => void;
}): Record<PropertyKey, unknown> {
  return {
    [INTERNAL_TOOL_EXECUTION_VALIDATION]: true,
    toolCallId: params.toolCallId,
    validate: params.validate,
  };
}
