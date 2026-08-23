import * as providerModelNormalization from "../agents/provider-model-normalization-provider.runtime.js";
import * as facadeActivationCheck from "../plugin-sdk/facade-activation-check.runtime.js";
import * as pluginMetadataCurrent from "../plugins/current-plugin-metadata-snapshot.js";
import * as pluginMetadataResolver from "../plugins/plugin-metadata-snapshot.js";
import { setWorkerDeployRuntimeCapabilities } from "./worker-deploy-runtime-registry.js";

setWorkerDeployRuntimeCapabilities({
  facadeActivationCheck,
  pluginMetadataCurrent,
  pluginMetadataResolver,
  providerModelNormalization,
  loadSubagentRegistry: () => import("../agents/subagents/registry/subagent-registry.runtime.js"),
  loadTaskRegistryControl: () => import("../tasks/task-registry-control.runtime.js"),
});
