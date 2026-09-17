import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";

/** True only for the bounded, append-only pre-compaction memory maintenance turn. */
export function isCodexMemoryFlushRun(
  params?: Pick<EmbeddedRunAttemptParams, "trigger" | "memoryFlushWritePath">,
): boolean {
  return params?.trigger === "memory" && Boolean(params.memoryFlushWritePath?.trim());
}
