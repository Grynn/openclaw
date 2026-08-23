/**
 * Runtime bridge for provider-owned model id normalization hooks. Source and
 * built artifacts can resolve different extensions, so this module probes both
 * once and caches the result.
 */
import { createRequire } from "node:module";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";

type ProviderRuntimeModule = Pick<
  typeof import("./provider-model-normalization-provider.runtime.js"),
  "normalizeProviderModelIdWithPlugin"
>;

const require = createRequire(import.meta.url);
// The unified build flattens shared chunks into dist/, so this adjacent stable
// entry resolves from both source and packaged artifacts. Try the source
// extension only for source/jiti execution.
const PROVIDER_RUNTIME_CANDIDATES = [
  "./provider-model-normalization-provider.runtime.js",
  "./provider-model-normalization-provider.runtime.ts",
] as const;

let providerRuntimeModule: ProviderRuntimeModule | undefined;
let providerRuntimeLoadAttempted = false;

function loadProviderRuntime(): ProviderRuntimeModule | null {
  if (providerRuntimeModule) {
    return providerRuntimeModule;
  }
  if (providerRuntimeLoadAttempted) {
    return null;
  }
  providerRuntimeLoadAttempted = true;
  for (const candidate of PROVIDER_RUNTIME_CANDIDATES) {
    try {
      providerRuntimeModule = require(candidate) as ProviderRuntimeModule;
      return providerRuntimeModule;
    } catch {
      // Try source/runtime candidates in order.
    }
  }
  return null;
}

/** Normalizes provider model ids through plugin runtime hooks when available. */
export function normalizeProviderModelIdWithRuntime(params: {
  provider: string;
  plugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
  context: {
    provider: string;
    modelId: string;
  };
}): string | undefined {
  return loadProviderRuntime()?.normalizeProviderModelIdWithPlugin(params);
}
