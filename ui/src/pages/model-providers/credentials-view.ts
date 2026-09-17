import { html, nothing } from "lit";
import type { ModelsProbeResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatAgentRuntimeLabel } from "../../lib/agent-runtime-label.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import type { ModelProviderCard } from "./data.ts";

export function renderCredentialSummary(card: ModelProviderCard, agentLabel: string) {
  const oauthCount = card.profiles.filter((profile) => profile.type === "oauth").length;
  const tokenCount = card.profiles.filter((profile) => profile.type === "token").length;
  const apiProfileCount = card.profiles.filter((profile) => profile.type === "api_key").length;
  const parts = [];
  if (card.availableAgentRuntimeIds.length > 0) {
    parts.push(
      t("modelProviders.credentials.runtimeManaged", {
        runtime: card.availableAgentRuntimeIds.map(formatAgentRuntimeLabel).join(", "),
      }),
    );
  }
  if (oauthCount > 0) {
    parts.push(t("modelProviders.credentials.oauth", { count: String(oauthCount) }));
  }
  if (tokenCount > 0) {
    parts.push(t("modelProviders.credentials.tokenProfiles", { count: String(tokenCount) }));
  }
  if (card.apiKey?.source === "config") {
    parts.push(t("modelProviders.credentials.configKey"));
  } else if (card.apiKey?.source === "env") {
    parts.push(
      card.apiKey.envVar
        ? t("modelProviders.credentials.envKeyNamed", { name: card.apiKey.envVar })
        : t("modelProviders.credentials.envKey"),
    );
  } else if (apiProfileCount > 0) {
    parts.push(t("modelProviders.credentials.profileKey", { count: String(apiProfileCount) }));
  }
  return html`
    <div class="model-providers__credentials">
      <span>${t("modelProviders.credentials.label", { agent: agentLabel })}</span>
      <strong
        >${parts.length > 0 ? parts.join(" · ") : t("modelProviders.credentials.none")}</strong
      >
    </div>
  `;
}

export function renderProbeResult(result: ModelsProbeResult | undefined) {
  if (!result) {
    return nothing;
  }
  const hasWarnings =
    result.status === "ok" && result.results.some((target) => target.status !== "ok");
  const presentation = hasWarnings ? "warning" : result.status === "ok" ? "success" : "error";
  return html`
    <div class="model-providers__probe model-providers__probe--${presentation}" role="status">
      <div class="model-providers__probe-summary">
        <strong
          >${hasWarnings
            ? t("modelProviders.probe.status.partial")
            : t(`modelProviders.probe.status.${result.status}`)}</strong
        >
        ${result.latencyMs !== undefined
          ? html`<span
              >${t("modelProviders.probe.latency", { ms: String(result.latencyMs) })}</span
            >`
          : nothing}
      </div>
      ${result.error ? html`<div>${formatUiExternalText(result.error)}</div>` : nothing}
      ${result.results.map(
        (target) => html`
          <div class="model-providers__probe-target">
            <span>${target.label}</span>
            <span>
              ${t(`modelProviders.probe.status.${target.status}`)}${target.latencyMs !== undefined
                ? ` · ${t("modelProviders.probe.latency", { ms: String(target.latencyMs) })}`
                : ""}
            </span>
            ${target.error ? html`<small>${formatUiExternalText(target.error)}</small>` : nothing}
          </div>
        `,
      )}
    </div>
  `;
}
