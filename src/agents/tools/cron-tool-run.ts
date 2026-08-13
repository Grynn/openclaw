import { projectCronRunTerminalEntry, waitForCronRunTerminalEntry } from "../../cron/run-wait.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isRecord } from "../../utils.js";
import { readPositiveIntegerParam } from "./common.js";
import { CRON_TOOL_COMPLETION_TIMEOUT_MAX_MS } from "./cron-tool-schema.js";
import type { GatewayToolCaller } from "./cron-tool.types.js";
import type { GatewayCallOptions } from "./gateway.js";

const CRON_TOOL_COMPLETION_POLL_INTERVAL_MS = 2_000;

/** Enqueue a cron run and, when requested, wait for that exact run's terminal ledger entry. */
export async function runCronJobFromAgentTool(params: {
  jobId: string;
  toolParams: Record<string, unknown>;
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
  operationSignal?: AbortSignal;
}): Promise<unknown> {
  const runMode =
    params.toolParams.runMode === "due" || params.toolParams.runMode === "force"
      ? params.toolParams.runMode
      : "due";
  const waitForCompletion = params.toolParams.waitForCompletion === true;
  const completionTimeoutMs = waitForCompletion
    ? (readPositiveIntegerParam(params.toolParams, "completionTimeoutMs", {
        max: CRON_TOOL_COMPLETION_TIMEOUT_MAX_MS,
        message: `completionTimeoutMs must be a positive integer no greater than ${CRON_TOOL_COMPLETION_TIMEOUT_MAX_MS}`,
      }) ?? CRON_TOOL_COMPLETION_TIMEOUT_MAX_MS)
    : undefined;
  const completionWaitStartedAt = Date.now();
  const admissionGatewayOpts = waitForCompletion
    ? {
        ...params.gatewayOpts,
        timeoutMs: Math.min(
          params.gatewayOpts.timeoutMs ?? 60_000,
          completionTimeoutMs ?? CRON_TOOL_COMPLETION_TIMEOUT_MAX_MS,
        ),
      }
    : params.gatewayOpts;
  const admission = await params.callGateway(
    "cron.run",
    admissionGatewayOpts,
    { id: params.jobId, mode: runMode },
    { signal: params.operationSignal },
  );
  if (
    !waitForCompletion ||
    !isRecord(admission) ||
    admission.ok !== true ||
    admission.enqueued !== true
  ) {
    return admission;
  }
  const runId = typeof admission.runId === "string" ? admission.runId.trim() : "";
  if (!runId) {
    return {
      ...admission,
      completed: false,
      waitError:
        "Completion wait unavailable because cron.run returned no runId; inspect this job's run history before retrying.",
    };
  }
  try {
    const completionWaitRemainingMs = Math.max(
      0,
      (completionTimeoutMs ?? CRON_TOOL_COMPLETION_TIMEOUT_MAX_MS) -
        Math.max(0, Date.now() - completionWaitStartedAt),
    );
    const run = await waitForCronRunTerminalEntry({
      timeoutMs: completionWaitRemainingMs,
      pollIntervalMs: CRON_TOOL_COMPLETION_POLL_INTERVAL_MS,
      signal: params.operationSignal,
      readPage: async (remainingMs) =>
        await params.callGateway(
          "cron.runs",
          {
            ...params.gatewayOpts,
            timeoutMs: Math.min(params.gatewayOpts.timeoutMs ?? 60_000, remainingMs),
          },
          { id: params.jobId, runId, limit: 1 },
          { signal: params.operationSignal },
        ),
    });
    return run
      ? {
          ...admission,
          completed: true,
          status: run.status,
          run: projectCronRunTerminalEntry(run),
        }
      : { ...admission, completed: false, timedOut: true };
  } catch (error) {
    params.operationSignal?.throwIfAborted();
    if (
      Date.now() - completionWaitStartedAt >=
      (completionTimeoutMs ?? CRON_TOOL_COMPLETION_TIMEOUT_MAX_MS)
    ) {
      return { ...admission, completed: false, timedOut: true };
    }
    return {
      ...admission,
      completed: false,
      waitError: `Completion wait failed after the run was queued: ${formatErrorMessage(error)}. Inspect run history for runId ${runId} before retrying.`,
    };
  }
}
