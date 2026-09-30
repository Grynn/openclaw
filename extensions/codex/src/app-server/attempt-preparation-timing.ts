import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createStageTimingTracker,
  formatStageTimings,
  type StageTimingSummary,
} from "openclaw/plugin-sdk/time-runtime";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";

const CODEX_DYNAMIC_TOOL_BUILD_WARN_TOTAL_MS = 1_000;
const CODEX_DYNAMIC_TOOL_BUILD_WARN_STAGE_MS = 500;
export function shouldWarnCodexDynamicToolBuildStageSummary(
  summary: StageTimingSummary,
  profilerEnabled = false,
): boolean {
  const totalWarnMs = profilerEnabled ? CODEX_DYNAMIC_TOOL_BUILD_WARN_TOTAL_MS : 10_000;
  const stageWarnMs = profilerEnabled ? CODEX_DYNAMIC_TOOL_BUILD_WARN_STAGE_MS : 5_000;
  return (
    summary.totalMs >= totalWarnMs ||
    summary.stages.some((stage) => stage.durationMs >= stageWarnMs)
  );
}

/** Records startup before the native turn owns inference and tool execution. */
export function createCodexAttemptPreparationTiming(
  params: Pick<EmbeddedRunAttemptParamsV2, "runId" | "sessionId" | "sessionKey" | "config">,
) {
  const tracker = createStageTimingTracker();
  const profilerEnabled = isCodexAppServerProfilerEnabled(params.config);
  const totalWarnMs = profilerEnabled ? 1_000 : 10_000;
  const stageWarnMs = profilerEnabled ? 500 : 5_000;
  const log = (stage: string, outcome: "completed" | "error" | "ready") => {
    const summary = tracker.snapshot();
    const lastStage = summary.stages.at(-1);
    const slowTotal = outcome !== "completed" && summary.totalMs >= totalWarnMs;
    const slowStage = outcome !== "ready" && (lastStage?.durationMs ?? 0) >= stageWarnMs;
    if (!slowTotal && !slowStage) {
      return;
    }
    embeddedAgentLog.warn(
      `codex app-server preparation timings runId=${params.runId} sessionId=${params.sessionId} stage=${stage} outcome=${outcome} totalMs=${summary.totalMs} stages=${formatStageTimings(summary.stages)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        stage,
        outcome,
        totalMs: summary.totalMs,
        stages: summary.stages,
      },
    );
  };
  return {
    async measure<T>(stage: string, run: () => Promise<T> | T): Promise<T> {
      let outcome: "completed" | "error" = "error";
      try {
        const result = await run();
        outcome = "completed";
        return result;
      } finally {
        tracker.mark(stage);
        // Emit completed slow stages immediately: a later stalled stage must
        // not erase the work already spent before the native turn starts.
        log(stage, outcome);
      }
    },
    ready() {
      log("native-turn-handoff", "ready");
    },
  };
}
