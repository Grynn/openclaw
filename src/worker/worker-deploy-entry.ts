import { flushCompileCache } from "node:module";
import "./worker-deploy-runtime.js";
import { formatCliOperatorError } from "../cli/failure-output.js";
import { getFsSafeNativeConfig } from "../infra/fs-safe-defaults.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { drainProcessOutput } from "../process/output-drain.js";
import workerDeployBrowserRuntime from "./worker-deploy-browser-runtime.js";
import { formatWorkerPrewarmAcknowledgement } from "./worker-prewarm-protocol.js";
import { runWorkerProcess } from "./worker-process.js";

try {
  await assertSupportedRuntime();

  const args = process.argv.slice(2);
  const internalWorkerIpc = args.includes("--internal-worker-ipc");
  const internalWorkerPrewarm = args.includes("--internal-worker-prewarm");
  const managed = args.includes("--internal-worker-session");
  if (
    new Set(args).size !== args.length ||
    args.some(
      (arg) =>
        ![
          "--internal-worker-ipc",
          "--internal-worker-prewarm",
          "--internal-worker-session",
        ].includes(arg),
    ) ||
    (internalWorkerPrewarm && args.length !== 1)
  ) {
    throw new Error("worker deploy entry received unsupported arguments");
  }

  if (internalWorkerPrewarm) {
    flushCompileCache();
    // Read after ./worker-deploy-runtime.js has sealed the process: the effective
    // policy, not the requested one, is what a host-native escape would change.
    process.stdout.write(formatWorkerPrewarmAcknowledgement(getFsSafeNativeConfig().mode));
  } else {
    await runWorkerProcess({
      internalWorkerIpc,
      managed,
      browserRuntime: workerDeployBrowserRuntime,
    });
  }
} catch (error) {
  process.stderr.write(`${formatCliOperatorError(error)}\n`);
  process.exitCode = 1;
  drainProcessOutput(() => process.exit(1));
}
