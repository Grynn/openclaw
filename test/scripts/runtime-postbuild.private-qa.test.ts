import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRuntimePostBuildStamp } from "../../scripts/lib/local-build-metadata.mts";
import { resolveRepoRoot } from "../../scripts/lib/repo-root.mjs";
import { resolveRuntimePostBuildRequirement } from "../../scripts/run-node.mts";
import { runRuntimePostBuild } from "../../scripts/runtime-postbuild.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { setupStampedProject, trackProjectWithGit } from "./run-node.test-support.js";

const sourceRoot = path.join(resolveRepoRoot(import.meta.url), "src/cli");
const companions = [
  "cli-process-tree.test-support.cjs",
  "cli-process-diagnostics.test-support.cjs",
];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const node = resolveTestNodeExecPath();

async function fixture(privateQa: boolean) {
  const rootDir = tempDirs.make("openclaw-private-qa-assets-");
  await setupStampedProject(rootDir, {
    files: privateQa ? { "dist/plugin-sdk/test-env.js": "export {};\n" } : {},
  });
  if (privateQa) {
    fs.mkdirSync(path.join(rootDir, "src/cli"), { recursive: true });
    for (const name of companions) {
      fs.copyFileSync(path.join(sourceRoot, name), path.join(rootDir, "src/cli", name));
    }
  }
  return rootDir;
}

function postbuild(rootDir: string) {
  runRuntimePostBuild({ rootDir, env: {}, timings: false });
}

function runRelativeProbe(rootDir: string, source: string) {
  const probe = path.join(rootDir, "dist/private-qa-probe.mjs");
  fs.writeFileSync(
    probe,
    `import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const options = { env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" };
${source}
`,
  );
  const result = spawnSync(node, [probe], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const child = JSON.parse(result.stdout);
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return child;
}

describe("private QA CLI diagnostic artifacts", () => {
  it.skipIf(process.platform === "win32")(
    "runs the relative process observer on supported platforms",
    async () => {
      const rootDir = await fixture(true);
      postbuild(rootDir);
      const observation = runRelativeProbe(
        rootDir,
        `
const observer = fileURLToPath(new URL("./cli-process-tree.test-support.cjs", import.meta.url));
console.log(JSON.stringify(spawnSync(process.execPath, [observer, "0"], options)));
`,
      );
      expect(observation.stdout).toContain("root pid=0;");
    },
  );

  it("runs the relative diagnostic preload and preserves both companion files", async () => {
    const rootDir = await fixture(true);
    postbuild(rootDir);
    const diagnostic = runRelativeProbe(
      rootDir,
      `
const preload = fileURLToPath(new URL("./cli-process-diagnostics.test-support.cjs", import.meta.url));
console.log(JSON.stringify(spawnSync(process.execPath, ["--require", preload, "-e", "process.stdout.write('ready')"], options)));
`,
    );
    expect(diagnostic.stdout).toBe("ready");
    expect(diagnostic.stderr).toMatch(/^\[cli-process-diagnostics\] ready pid=\d+\n$/u);
    for (const name of companions) {
      expect(fs.readFileSync(path.join(rootDir, "dist", name))).toEqual(
        fs.readFileSync(path.join(sourceRoot, name)),
      );
    }
  });

  it("does not require or emit companions without the private QA facade", async () => {
    const rootDir = await fixture(false);
    expect(() => postbuild(rootDir)).not.toThrow();
    for (const name of companions) {
      expect(fs.existsSync(path.join(rootDir, "dist", name))).toBe(false);
    }
  });

  it("requires repair when either emitted companion disappears or its source changes", async () => {
    const rootDir = await fixture(true);
    postbuild(rootDir);
    const { deps } = await trackProjectWithGit(rootDir);
    writeRuntimePostBuildStamp({ cwd: rootDir, env: {} });
    expect(resolveRuntimePostBuildRequirement(deps).shouldSync).toBe(false);
    for (const name of companions) {
      fs.rmSync(path.join(rootDir, "dist", name));
      expect(resolveRuntimePostBuildRequirement(deps).reason).toBe(
        "missing_runtime_postbuild_output",
      );
      postbuild(rootDir);
      writeRuntimePostBuildStamp({ cwd: rootDir, env: {} });
      expect(resolveRuntimePostBuildRequirement(deps).shouldSync).toBe(false);
    }
    fs.appendFileSync(path.join(rootDir, "src/cli", companions[0]!), "\n// changed fixture\n");
    expect(resolveRuntimePostBuildRequirement(deps).reason).toBe("dirty_runtime_postbuild_inputs");
  });

  it("fails instead of silently publishing an incomplete private QA harness", async () => {
    const rootDir = await fixture(true);
    fs.rmSync(path.join(rootDir, "src/cli", companions[1]!));
    expect(() => postbuild(rootDir)).toThrow(/ENOENT/u);
  });
});
