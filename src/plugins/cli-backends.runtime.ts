// Runtime bridge for plugin-provided CLI backends.
import type { CliBackendPlugin } from "./cli-backend.types.js";
import { getPluginRegistryState } from "./runtime-state.js";

/** Runtime CLI backend registration with owning plugin id. */
type PluginCliBackendEntry = CliBackendPlugin & {
  pluginId: string;
  builtWithOpenClawVersion?: string;
};

/** Resolves CLI backends from the active runtime plugin registry. */
export function resolveRuntimeCliBackends(): PluginCliBackendEntry[] {
  return (getPluginRegistryState()?.activeRegistry?.cliBackends ?? []).map((entry) =>
    Object.assign({}, entry.backend, {
      pluginId: entry.pluginId,
      builtWithOpenClawVersion: entry.builtWithOpenClawVersion,
    }),
  );
}
