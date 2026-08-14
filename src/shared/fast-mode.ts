import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export type { FastMode } from "@openclaw/normalization-core/string-coerce";

export const DEFAULT_FAST_MODE_AUTO_ON_SECONDS = 60;

export type FastModeSource = "session" | "agent" | "config" | "default";

export type FastModeAutoProgressState = {
  offAnnounced: boolean;
  resetAnnounced: boolean;
};

type FastModeModelConfig = {
  params?: Record<string, unknown>;
};

type FastModeProviderConfig = {
  params?: Record<string, unknown>;
  models?: Array<{ id?: string; params?: Record<string, unknown> }>;
};

type FastModeConfig = {
  agents?: {
    defaults?: {
      models?: Record<string, FastModeModelConfig | undefined>;
    };
  };
  models?: {
    providers?: Record<string, FastModeProviderConfig | undefined>;
  };
};

function modelConfigKey(provider?: string, model?: string): string {
  const providerId = provider?.trim() ?? "";
  const modelId = model?.trim() ?? "";
  if (!providerId) {
    return modelId;
  }
  if (!modelId) {
    return providerId;
  }
  return normalizeLowercaseStringOrEmpty(modelId).startsWith(
    `${normalizeLowercaseStringOrEmpty(providerId)}/`,
  )
    ? modelId
    : `${providerId}/${modelId}`;
}

export function resolveFastModeModelParams(params: {
  cfg: FastModeConfig | undefined;
  provider?: string;
  model?: string;
}): Record<string, unknown> | undefined {
  const models = params.cfg?.agents?.defaults?.models;
  if (!models) {
    return undefined;
  }
  return models[modelConfigKey(params.provider, params.model)]?.params;
}

/** Whether a model/provider param is the shared fast-mode allow policy. */
export function isFastModeAllowedParam(key: string, value: unknown): boolean {
  return (key === "fastModeAllowed" || key === "fast_mode_allowed") && typeof value === "boolean";
}

function readFastModeAllowed(params: Record<string, unknown> | undefined): boolean | undefined {
  const value = params?.fastModeAllowed ?? params?.fast_mode_allowed;
  return typeof value === "boolean" ? value : undefined;
}

function resolveFastModeProviderConfig(params: {
  cfg: FastModeConfig | undefined;
  provider?: string;
}): FastModeProviderConfig | undefined {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  if (!provider) {
    return undefined;
  }
  return Object.entries(params.cfg?.models?.providers ?? {}).find(
    ([providerId]) => normalizeLowercaseStringOrEmpty(providerId) === provider,
  )?.[1];
}

function resolveFastModeProviderModelParams(params: {
  cfg: FastModeConfig | undefined;
  provider?: string;
  model?: string;
}): Record<string, unknown> | undefined {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const model = normalizeLowercaseStringOrEmpty(params.model);
  if (!provider || !model) {
    return undefined;
  }
  const modelId = model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model;
  return resolveFastModeProviderConfig(params)?.models?.find((entry) => {
    const candidate = normalizeLowercaseStringOrEmpty(entry.id);
    return candidate === modelId || candidate === model;
  })?.params;
}

/** Whether the selected model permits fast mode at all. Defaults to allowed. */
export function resolveFastModeModelAllowed(params: {
  cfg: FastModeConfig | undefined;
  provider?: string;
  model?: string;
}): boolean {
  return (
    readFastModeAllowed(resolveFastModeProviderModelParams(params)) ??
    readFastModeAllowed(resolveFastModeModelParams(params)) ??
    readFastModeAllowed(resolveFastModeProviderConfig(params)?.params) ??
    true
  );
}

function normalizeFastModeAutoOnSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveFastModeModelAutoOnSeconds(params: {
  cfg: FastModeConfig | undefined;
  provider?: string;
  model?: string;
}): number {
  const modelParams = resolveFastModeModelParams(params);
  return (
    normalizeFastModeAutoOnSeconds(modelParams?.fastAutoOnSeconds) ??
    normalizeFastModeAutoOnSeconds(modelParams?.fast_auto_on_seconds) ??
    normalizeFastModeAutoOnSeconds(modelParams?.fastSeconds) ??
    normalizeFastModeAutoOnSeconds(modelParams?.fast_seconds) ??
    DEFAULT_FAST_MODE_AUTO_ON_SECONDS
  );
}

export function resolveFastModeForElapsed(params: {
  mode?: FastMode;
  startedAtMs: number;
  fastAutoOnSeconds?: number;
  nowMs?: number;
}): {
  mode: FastMode | undefined;
  enabled: boolean;
  elapsedSeconds: number;
  fastAutoOnSeconds: number;
} {
  const nowMs = params.nowMs ?? Date.now();
  const elapsedMs = Math.max(0, nowMs - params.startedAtMs);
  const fastAutoOnSeconds =
    normalizeFastModeAutoOnSeconds(params.fastAutoOnSeconds) ?? DEFAULT_FAST_MODE_AUTO_ON_SECONDS;
  const thresholdMs = fastAutoOnSeconds * 1000;
  const enabled = params.mode === "auto" ? elapsedMs <= thresholdMs : params.mode === true;
  const elapsedSeconds = Math.floor(elapsedMs / 1000);
  return {
    mode: params.mode,
    enabled,
    elapsedSeconds,
    fastAutoOnSeconds,
  };
}

export function formatFastModeAutoProgressText(params: {
  enabled: boolean;
  elapsedSeconds: number;
  fastAutoOnSeconds?: number;
}): string {
  if (params.enabled) {
    return "💨Fast: auto-on";
  }
  const fastAutoOnSeconds =
    normalizeFastModeAutoOnSeconds(params.fastAutoOnSeconds) ?? DEFAULT_FAST_MODE_AUTO_ON_SECONDS;
  return `💨Fast: auto-off(${params.elapsedSeconds}s>=${fastAutoOnSeconds}s)`;
}

export function formatFastModeValue(mode: FastMode | undefined): "auto" | "on" | "off" {
  return mode === "auto" ? "auto" : mode === true ? "on" : "off";
}

export function formatFastModeAutoLabel(params?: { fastAutoOnSeconds?: number }): string {
  const fastAutoOnSeconds =
    normalizeFastModeAutoOnSeconds(params?.fastAutoOnSeconds) ?? DEFAULT_FAST_MODE_AUTO_ON_SECONDS;
  return `auto (${fastAutoOnSeconds} sec)`;
}

export function formatFastModeStatusValue(params: {
  mode: FastMode | undefined;
  fastAutoOnSeconds?: number;
}): string {
  if (params.mode === "auto") {
    return formatFastModeAutoLabel({ fastAutoOnSeconds: params.fastAutoOnSeconds });
  }
  return formatFastModeValue(params.mode);
}

export function formatFastModeCommandOptions(params?: { fastAutoOnSeconds?: number }): string {
  return `on, off, ${formatFastModeAutoLabel({
    fastAutoOnSeconds: params?.fastAutoOnSeconds,
  })}, default, status`;
}

export function formatFastModeSourceSuffix(source: FastModeSource | undefined): string {
  switch (source) {
    case "session":
      return " (session)";
    case "agent":
      return " (default: agent)";
    case "config":
      return " (default: model)";
    case "default":
      return " (default)";
    default:
      return "";
  }
}

export function formatFastModeCurrentStatus(params: {
  mode: FastMode | undefined;
  source?: FastModeSource;
  fastAutoOnSeconds?: number;
  label?: string;
}): string {
  const label = params.label ?? "Current fast mode";
  return `${label}: ${formatFastModeStatusValue({
    mode: params.mode,
    fastAutoOnSeconds: params.fastAutoOnSeconds,
  })}${formatFastModeSourceSuffix(params.source)}.`;
}
