import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { summarizeSpawnError } from "../../spawn-pipeline.js";
import { removeQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import type {
  SpawnSubagentContext,
  SpawnSubagentParams,
  SpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";

type ResolvedSpawnRequest = Extract<
  ReturnType<typeof resolveSubagentSpawnRequest>,
  { ok: true }
>["resolved"];
type ResolvedChildPlan = Extract<
  Awaited<ReturnType<typeof resolveSubagentChildPlan>>,
  { ok: true }
>["resolved"];
type RetriableChildPlan = Extract<
  Awaited<ReturnType<typeof resolveSubagentChildPlan>>,
  { retry: unknown }
>["retry"];

type SubagentSpawnPreflightAttemptResult =
  | { status: "ready"; request: ResolvedSpawnRequest; child: ResolvedChildPlan }
  | { status: "result"; result: SpawnSubagentResult }
  | {
      status: "config-replaced";
      retry: RetriableChildPlan;
      custody: ResolvedSpawnRequest;
    };

export type SubagentSpawnPreflightResult = Exclude<
  SubagentSpawnPreflightAttemptResult,
  { status: "config-replaced" }
>;

function releaseDiscardedSpawnPreflight(request: ResolvedSpawnRequest): boolean {
  request.admission.reservation?.release();
  return !request.swarm.reservationPending || removeQueuedSwarmRun(request.childIdem);
}

function releasePreflightForResult(
  request: ResolvedSpawnRequest,
  result: SpawnSubagentResult,
): SubagentSpawnPreflightResult {
  return releaseDiscardedSpawnPreflight(request)
    ? { status: "result", result }
    : {
        status: "result",
        result: {
          status: "error",
          error: "sessions_spawn could not release its discarded swarm FIFO reservation.",
        },
      };
}

async function resolveSubagentSpawnPreflightAttempt(params: {
  request: SpawnSubagentParams;
  ctx: SpawnSubagentContext;
  sandboxMode: "require" | "inherit";
  cfgOverride?: OpenClawConfig;
  retryCustody?: ResolvedSpawnRequest;
}): Promise<SubagentSpawnPreflightAttemptResult> {
  let requestedAgentId = params.request.agentId?.trim();
  let requestResolution: ReturnType<typeof resolveSubagentSpawnRequest>;
  try {
    requestResolution = resolveSubagentSpawnRequest(
      params.request,
      params.ctx,
      {
        initial: requestedAgentId,
        applyDefault(agentId) {
          requestedAgentId = agentId;
          return requestedAgentId;
        },
      },
      { cfgOverride: params.cfgOverride, retryCustody: params.retryCustody },
    );
  } catch (error) {
    if (params.retryCustody) {
      releaseDiscardedSpawnPreflight(params.retryCustody);
    }
    throw error;
  }
  if (!requestResolution.ok) {
    return params.retryCustody
      ? releasePreflightForResult(params.retryCustody, requestResolution.result)
      : { status: "result", result: requestResolution.result };
  }
  const resolvedRequest = requestResolution.resolved;
  try {
    const childPlan = await resolveSubagentChildPlan({
      request: params.request,
      ctx: params.ctx,
      cfg: resolvedRequest.runtime.cfg,
      requesterInternalKey: resolvedRequest.runtime.requesterInternalKey,
      requesterAgentId: resolvedRequest.runtime.requesterAgentId,
      targetAgentId: resolvedRequest.runtime.targetAgentId,
      sandboxMode: params.sandboxMode,
      swarmEnabled: resolvedRequest.swarm.config.enabled,
    });
    if (childPlan.ok) {
      return { status: "ready", request: resolvedRequest, child: childPlan.resolved };
    }
    if ("retry" in childPlan) {
      return {
        status: "config-replaced",
        retry: childPlan.retry,
        custody: resolvedRequest,
      };
    }
    return releasePreflightForResult(resolvedRequest, childPlan.result);
  } catch (error) {
    releaseDiscardedSpawnPreflight(resolvedRequest);
    throw error;
  }
}

export async function resolveSubagentSpawnPreflight(params: {
  request: SpawnSubagentParams;
  ctx: SpawnSubagentContext;
  sandboxMode: "require" | "inherit";
}): Promise<SubagentSpawnPreflightResult> {
  let cfgOverride: OpenClawConfig | undefined;
  let retryCustody: ResolvedSpawnRequest | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const preflight = await resolveSubagentSpawnPreflightAttempt({
      ...params,
      cfgOverride,
      retryCustody,
    });
    if (preflight.status !== "config-replaced") {
      return preflight;
    }
    if (attempt > 0) {
      return releasePreflightForResult(preflight.custody, preflight.retry.result);
    }
    let owner: Awaited<
      ReturnType<ReturnType<typeof getSubagentSpawnDeps>["loadResolvedPublishedModelCatalogOwner"]>
    >;
    try {
      const deps = getSubagentSpawnDeps();
      owner = await deps.loadResolvedPublishedModelCatalogOwner({
        config: deps.getRuntimeConfig(),
        agentId: preflight.retry.targetAgentId,
        readOnly: true,
      });
    } catch (error) {
      return releasePreflightForResult(preflight.custody, {
        ...preflight.retry.result,
        status: "error",
        error: `${preflight.retry.result.error}; current catalog owner refresh failed: ${summarizeSpawnError(error)}`,
      });
    }
    if (owner.agentId !== preflight.retry.targetAgentId) {
      return releasePreflightForResult(preflight.custody, {
        ...preflight.retry.result,
        status: "error",
        error: `${preflight.retry.result.error}; current catalog owner resolved agent "${owner.agentId}" instead of "${preflight.retry.targetAgentId}"`,
      });
    }
    cfgOverride = owner.config;
    retryCustody = preflight.custody;
  }
  throw new Error("unreachable sessions_spawn preflight retry state");
}
