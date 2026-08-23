import type { ResolveSecureTempRoot } from "../infra/secure-temp-root.js";

type FacadeActivationCheckRuntime =
  typeof import("../plugin-sdk/facade-activation-check.runtime.js");
type PluginMetadataCurrentRuntime = Pick<
  typeof import("../plugins/current-plugin-metadata-snapshot.js"),
  "getCurrentPluginMetadataSnapshot"
>;
type PluginMetadataResolverRuntime = Pick<
  typeof import("../plugins/plugin-metadata-snapshot.js"),
  "resolvePluginMetadataSnapshot"
>;
type ProviderModelNormalizationRuntime = Pick<
  typeof import("../agents/provider-model-normalization-provider.runtime.js"),
  "normalizeProviderModelIdWithPlugin"
>;
type SubagentRegistryRuntime = Pick<
  typeof import("../agents/subagents/registry/subagent-registry.runtime.js"),
  "ensureContextEnginesInitialized" | "resolveContextEngine"
>;
type WorkerTaskRegistryControlRuntime = typeof import("../tasks/task-registry-control.runtime.js");

type WorkerDeployRuntime = {
  facadeActivationCheck?: FacadeActivationCheckRuntime;
  highlightJs?: unknown;
  json5?: unknown;
  pluginMetadataCurrent?: PluginMetadataCurrentRuntime;
  pluginMetadataResolver?: PluginMetadataResolverRuntime;
  providerModelNormalization?: ProviderModelNormalizationRuntime;
  resolveSecureTempRoot?: ResolveSecureTempRoot;
  loadSubagentRegistry?: () => Promise<SubagentRegistryRuntime>;
  loadTaskRegistryControl?: () => Promise<WorkerTaskRegistryControlRuntime>;
};

const runtime: WorkerDeployRuntime = {};

export function setWorkerDeployRuntime(next: Required<WorkerDeployRuntime>): void {
  setWorkerDeployBootstrapRuntime(next);
  setWorkerDeployRuntimeCapabilities(next);
}

export function setWorkerDeployBootstrapRuntime(
  next: Required<Pick<WorkerDeployRuntime, "highlightJs" | "json5" | "resolveSecureTempRoot">>,
): void {
  runtime.highlightJs = next.highlightJs;
  runtime.json5 = next.json5;
  runtime.resolveSecureTempRoot = next.resolveSecureTempRoot;
}

export function setWorkerDeployRuntimeCapabilities(
  next: Required<Omit<WorkerDeployRuntime, "highlightJs" | "json5" | "resolveSecureTempRoot">>,
): void {
  runtime.facadeActivationCheck = next.facadeActivationCheck;
  runtime.pluginMetadataCurrent = next.pluginMetadataCurrent;
  runtime.pluginMetadataResolver = next.pluginMetadataResolver;
  runtime.providerModelNormalization = next.providerModelNormalization;
  runtime.loadSubagentRegistry = next.loadSubagentRegistry;
  runtime.loadTaskRegistryControl = next.loadTaskRegistryControl;
}

export function getWorkerDeployFacadeActivationCheck(): FacadeActivationCheckRuntime | undefined {
  return runtime.facadeActivationCheck;
}

export function getWorkerDeployHighlightJs(): unknown {
  return runtime.highlightJs;
}

export function getWorkerDeployJson5(): unknown {
  return runtime.json5;
}

export function getWorkerDeployPluginMetadataCurrent(): PluginMetadataCurrentRuntime | undefined {
  return runtime.pluginMetadataCurrent;
}

export function getWorkerDeployPluginMetadataResolver(): PluginMetadataResolverRuntime | undefined {
  return runtime.pluginMetadataResolver;
}

export function getWorkerDeployProviderModelNormalization():
  | ProviderModelNormalizationRuntime
  | undefined {
  return runtime.providerModelNormalization;
}

export function getWorkerDeploySecureTempRoot(): ResolveSecureTempRoot | undefined {
  return runtime.resolveSecureTempRoot;
}

export function getWorkerDeploySubagentRegistryLoader():
  | (() => Promise<SubagentRegistryRuntime>)
  | undefined {
  return runtime.loadSubagentRegistry;
}

export function getWorkerDeployTaskRegistryControlLoader():
  | (() => Promise<WorkerTaskRegistryControlRuntime>)
  | undefined {
  return runtime.loadTaskRegistryControl;
}

export function assertWorkerDeployRuntimeReady(): void {
  const requiredFunctions = [
    runtime.facadeActivationCheck?.resolveBundledPluginPublicSurfaceAccess,
    runtime.pluginMetadataCurrent?.getCurrentPluginMetadataSnapshot,
    runtime.pluginMetadataResolver?.resolvePluginMetadataSnapshot,
    runtime.providerModelNormalization?.normalizeProviderModelIdWithPlugin,
    runtime.resolveSecureTempRoot,
    runtime.loadSubagentRegistry,
    runtime.loadTaskRegistryControl,
  ];
  if (
    runtime.highlightJs === undefined ||
    runtime.json5 === undefined ||
    requiredFunctions.some((value) => typeof value !== "function")
  ) {
    throw new Error("Worker deploy runtime composition is incomplete");
  }
}

export async function prewarmWorkerDeployRuntime(): Promise<void> {
  assertWorkerDeployRuntimeReady();
  const [subagentRegistry, taskRegistryControl] = await Promise.all([
    runtime.loadSubagentRegistry!(),
    runtime.loadTaskRegistryControl!(),
  ]);
  const requiredFunctions = [
    subagentRegistry.ensureContextEnginesInitialized,
    subagentRegistry.resolveContextEngine,
    taskRegistryControl.cancelActiveCronTaskRun,
    taskRegistryControl.cancelBackgroundExecSession,
    taskRegistryControl.getAcpSessionManager,
    taskRegistryControl.isContextEngineTurnMaintenanceRunActive,
    taskRegistryControl.killSubagentRunAdmin,
  ];
  if (requiredFunctions.some((value) => typeof value !== "function")) {
    throw new Error("Worker deploy lazy runtime composition is incomplete");
  }
}
