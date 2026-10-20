/**
 * Resolves fast-mode state from agent config and runtime defaults.
 */
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeFastMode } from "../auto-reply/thinking.shared.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOpenAIServiceTier } from "../llm/providers/openai-fast-mode.js";
import { type FastModeSource, resolveFastModeModelAutoOnSeconds } from "../shared/fast-mode.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { resolveAliasedParamValue, resolveModelExtraParamSources } from "./model-extra-params.js";

export {
  DEFAULT_FAST_MODE_AUTO_ON_SECONDS,
  formatFastModeAutoProgressText,
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeSourceSuffix,
  formatFastModeStatusValue,
  formatFastModeValue,
  resolveFastModeForElapsed,
} from "../shared/fast-mode.js";
export type { FastModeAutoProgressState } from "../shared/fast-mode.js";

// Resolves effective fast-mode state from session, agent, model config, then
// default. Callers keep the source for diagnostics and prompt explanations.
type FastModeState = {
  mode: FastMode;
  /** Undefined preserves an inherited provider tier instead of manufacturing Standard. */
  requestMode: FastMode | undefined;
  enabled: boolean;
  allowed: boolean;
  source: FastModeSource;
  fastAutoOnSeconds: number;
};

function readFastModeAllowed(params: Record<string, unknown> | undefined): boolean | undefined {
  const value = params?.fastModeAllowed ?? params?.fast_mode_allowed;
  return typeof value === "boolean" ? value : undefined;
}

/** Operator policy is independent of session, run, and transport speed preferences. */
export function resolveFastModeAllowed(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): boolean {
  const { modelParams } = resolveModelExtraParamSources({
    config: params.cfg,
    provider: params.provider,
    modelId: params.model,
  });
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, params.provider);
  const providerModel = findConfiguredProviderModel(providerConfig, params.provider, params.model);
  // Exact model policy can override the provider default; run/session preferences cannot.
  return (
    readFastModeAllowed(providerModel?.params) ??
    readFastModeAllowed(modelParams) ??
    readFastModeAllowed(providerConfig?.params) ??
    true
  );
}

/** Resolve the effective fast-mode setting and its source. */
export function resolveFastModeState(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentId?: string;
  sessionEntry?: Pick<SessionEntry, "fastMode"> | undefined;
  fastModeOverride?: FastMode;
}): FastModeState {
  const { defaultParams, modelParams, agentModelParams, agentParams } =
    resolveModelExtraParamSources({
      config: params.cfg,
      provider: params.provider,
      modelId: params.model,
      agentId: params.agentId,
    });
  const fastAutoOnSeconds = resolveFastModeModelAutoOnSeconds({
    ...params,
    modelParamSources: [agentModelParams, modelParams],
  });
  const allowed = resolveFastModeAllowed(params);
  let mode = normalizeFastMode(params.fastModeOverride ?? params.sessionEntry?.fastMode);
  let source: FastModeSource = "session";
  if (mode === undefined) {
    mode = normalizeFastMode(
      params.agentId && params.cfg
        ? resolveAgentConfig(params.cfg, params.agentId)?.fastModeDefault
        : params.cfg?.agents?.defaults?.fastModeDefault,
    );
    source = "agent";
  }
  if (mode === undefined) {
    const configuredRaw = resolveAliasedParamValue(
      [defaultParams, modelParams, agentModelParams, agentParams],
      ["fastMode", "fast_mode"],
    );
    mode = normalizeFastMode(configuredRaw as string | boolean | null | undefined);
    source = "config";
  }

  const tier =
    params.provider === "openai"
      ? normalizeOpenAIServiceTier(
          resolveAliasedParamValue(
            [defaultParams, modelParams, agentModelParams, agentParams],
            ["serviceTier", "service_tier"],
          ),
        )
      : undefined;
  if (!allowed) {
    return {
      mode: false,
      // A prohibition is not an explicit Standard selection for an inherited non-fast tier.
      requestMode:
        mode === undefined && tier && tier !== "priority" && tier !== "ultrafast"
          ? undefined
          : false,
      enabled: false,
      allowed,
      source: "config",
      fastAutoOnSeconds,
    };
  }
  const requestMode = mode ?? (tier ? undefined : false);
  if (mode === undefined && tier) {
    mode = tier === "ultrafast" ? "ultrafast" : tier === "priority";
    source = "config";
  }

  return {
    mode: mode ?? false,
    requestMode,
    enabled: mode === "auto" || mode === true || mode === "ultrafast",
    allowed,
    source: mode === undefined ? "default" : source,
    fastAutoOnSeconds,
  };
}
