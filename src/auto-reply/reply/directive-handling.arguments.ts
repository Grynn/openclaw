/** Interprets command-owned session directive arguments before persistence. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  type resolveFastModeState,
} from "../../agents/fast-mode.js";
import type { ReplyPayload } from "../types.js";
import type { HandleDirectiveOnlyParams } from "./directive-handling.params.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
import { withOptions } from "./directive-handling.shared.js";

export function maybeHandleFastDirective({
  directives,
  fastModeState,
  currentFastMode,
}: Pick<HandleDirectiveOnlyParams, "directives" | "currentFastMode"> & {
  fastModeState: ReturnType<typeof resolveFastModeState>;
}): ReplyPayload | undefined {
  if (
    directives.hasFastDirective &&
    directives.fastMode === undefined &&
    !directives.clearFastMode
  ) {
    const isFastStatus = normalizeLowercaseStringOrEmpty(directives.rawFastMode) === "status";
    if (!directives.rawFastMode || isFastStatus) {
      const effectiveFastMode = fastModeState.allowed
        ? (currentFastMode ?? fastModeState.mode)
        : false;
      const statusText = formatFastModeCurrentStatus({
        mode: effectiveFastMode,
        source: fastModeState.source,
        fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
      });
      return {
        text: isFastStatus
          ? statusText
          : withOptions(
              statusText,
              formatFastModeCommandOptions({ fastAutoOnSeconds: fastModeState.fastAutoOnSeconds }),
            ),
      };
    }
    return {
      text: `Unrecognized fast mode "${directives.rawFastMode}". Valid levels: on, off, ultrafast, auto, default, status.`,
    };
  }
  if (
    directives.hasFastDirective &&
    directives.fastMode !== undefined &&
    directives.fastMode !== false &&
    !fastModeState.allowed
  ) {
    return { text: "Fast mode is disabled by policy for the current model." };
  }
  return undefined;
}

export function resolveInvalidExecDirectiveMessage(
  directives: InlineDirectives,
): string | undefined {
  return directives.invalidExecHost
    ? `Unrecognized exec host "${directives.rawExecHost ?? ""}". Valid hosts: auto, sandbox, gateway, node.`
    : directives.invalidExecSecurity
      ? `Unrecognized exec security "${directives.rawExecSecurity ?? ""}". Valid: deny, allowlist, full.`
      : directives.invalidExecAsk
        ? `Unrecognized exec ask "${directives.rawExecAsk ?? ""}". Valid: off, on-miss, always.`
        : directives.invalidExecNode
          ? "Exec node requires a value."
          : undefined;
}

/** Rejects prose left over after canonical command-specific validation succeeds. */
export function maybeHandleUnexpectedDirectiveArguments(
  directives: InlineDirectives,
): ReplyPayload | undefined {
  const command = directives.command;
  const unconsumedArguments = command?.unconsumedArguments;
  if (!command || !unconsumedArguments) {
    return undefined;
  }

  // One token is enough to explain the rejected boundary without echoing an unbounded prompt.
  const unexpectedArgument =
    unconsumedArguments.trimStart().split(/\s+/, 1)[0] ?? unconsumedArguments;
  return {
    text: `Unexpected argument "${unexpectedArgument}" for /${command.name}.`,
  };
}
