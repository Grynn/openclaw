// Applies OpenClaw's default fs-safe runtime configuration.
import { configureFsSafeNative } from "@openclaw/fs-safe/config";

declare const WORKER_DEPLOY_BUILD: boolean;

// Normal runtimes allow fs-safe's documented env override. Portable worker
// deploys do not ship the host-native binding, so their build marker wins.
const hasModeOverride = Object.keys(process.env).some((key) =>
  /^(?:OPENCLAW_)?FS_SAFE_(?:NATIVE|PYTHON)_MODE$/u.test(
    process.platform === "win32" ? key.toUpperCase() : key,
  ),
);
const isWorkerDeployBuild = typeof WORKER_DEPLOY_BUILD === "boolean" && WORKER_DEPLOY_BUILD;

if (isWorkerDeployBuild || !hasModeOverride) {
  configureFsSafeNative({ mode: "off" });
}
