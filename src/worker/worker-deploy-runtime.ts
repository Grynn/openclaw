import { resolveSecureTempRoot } from "../infra/secure-temp-root.js";
import highlightJsRuntime from "./worker-deploy-highlight-runtime.mjs";
import json5Runtime from "./worker-deploy-json5-runtime.mjs";
import { setWorkerDeployBootstrapRuntime } from "./worker-deploy-runtime-registry.js";

// This minimal module must evaluate before the worker capability graph. Some
// capability dependencies initialize logging at module scope and therefore
// need secure temp resolution before their own evaluation begins.
setWorkerDeployBootstrapRuntime({
  highlightJs: highlightJsRuntime,
  json5: json5Runtime,
  resolveSecureTempRoot,
});
