import "../infra/fs-safe-defaults.js";
import { flushCompileCache } from "node:module";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import "./worker-deploy-runtime.js";
import "./worker-deploy-capability-runtime.js";
import workerDeployBrowserRuntime from "./worker-deploy-browser-runtime.js";
import {
  assertWorkerDeployRuntimeReady,
  prewarmWorkerDeployRuntime,
} from "./worker-deploy-runtime-registry.js";
import { formatWorkerPrewarmAcknowledgement } from "./worker-prewarm-protocol.js";
import { runWorkerProcess } from "./worker-process.js";

const args = process.argv.slice(2);
const internalWorkerIpc = args[0] === "--internal-worker-ipc";
const internalWorkerPrewarm = args[0] === "--internal-worker-prewarm";
if (args.length > 1 || (args.length === 1 && !internalWorkerIpc && !internalWorkerPrewarm)) {
  throw new Error("worker deploy entry received unsupported arguments");
}

assertWorkerDeployRuntimeReady();
if (internalWorkerPrewarm) {
  await prewarmWorkerDeployRuntime();
  flushCompileCache();
  process.stdout.write(formatWorkerPrewarmAcknowledgement(getFsSafeNativeConfig().mode));
} else {
  await runWorkerProcess({
    internalWorkerIpc,
    browserRuntime: workerDeployBrowserRuntime,
  });
}
