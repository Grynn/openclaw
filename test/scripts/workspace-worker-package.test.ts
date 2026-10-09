import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterEach, expect, it } from "vitest";
import { collectNpmPackInventory } from "../../scripts/lib/npm-pack-inventory.mts";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import buildConfigs from "../../tsdown.config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("launches workspace file workers from npm-selected package output without loose sealed workers", async () => {
  const root = fs.realpathSync(tempDirs.make("openclaw-workspace-worker-package-"));
  const sourceRoot = path.join(root, "build");
  const installedRoot = path.join(root, "installed package");
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(installedRoot);
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
  fs.writeFileSync(
    path.join(sourceRoot, "package.json"),
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      files: manifest.files,
      exports: manifest.exports,
    }),
  );
  const configs = Array.isArray(buildConfigs) ? buildConfigs : [buildConfigs];
  const selected = configs.find((config) => config.name === TSDOWN_UNIFIED_CONFIG_GROUP);
  if (!selected) {
    throw new Error("Missing unified runtime build config");
  }
  // Select actual source owners, leaving the shared declarations to choose installed paths.
  const sources = new Set(
    [
      "src/worker/memory-worker-entry.ts",
      "src/worker/skills-worker-entry.ts",
      "src/plugin-sdk/agent-workspace-runtime.ts",
      "src/plugin-sdk/file-access-runtime.ts",
      "src/plugin-sdk/memory-core-host-engine-storage.ts",
      "extensions/memory-core/worker-api.ts",
    ].map((source) => path.resolve(source)),
  );
  const entries = Object.fromEntries(
    Object.entries(selected.entry ?? {}).filter(([, source]) => sources.has(path.resolve(source))),
  );
  expect(Object.keys(entries)).toHaveLength(sources.size);
  const { bundles } = await build({
    ...selected,
    config: false,
    entry: entries,
    outDir: path.join(sourceRoot, "dist"),
    dts: false,
    logLevel: "silent",
  });
  try {
    const pluginRoot = path.join(sourceRoot, "dist/extensions/memory-core");
    for (const name of ["package.json", "openclaw.plugin.json"]) {
      fs.writeFileSync(
        path.join(pluginRoot, name),
        fs.readFileSync(path.join("extensions/memory-core", name)),
      );
    }
    const inventory = collectNpmPackInventory(sourceRoot, { timeoutMs: 30_000 });
    for (const relative of inventory.files) {
      const target = path.join(installedRoot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, fs.readFileSync(path.join(sourceRoot, relative)));
    }
    // This proof owns package file selection and launch, not production dependency installation.
    fs.symlinkSync(
      fs.realpathSync("node_modules"),
      path.join(installedRoot, "node_modules"),
      "junction",
    );
    const result = await new Promise<{ error: Error | null; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          resolveTestNodeExecPath(),
          [
            fileURLToPath(new URL("./workspace-worker-package.test-support.mjs", import.meta.url)),
            installedRoot,
            path.join(root, "workspace"),
          ],
          {
            cwd: installedRoot,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              WINDIR: process.env.WINDIR,
              HOME: root,
              USERPROFILE: root,
              TMPDIR: root,
              TMP: root,
              TEMP: root,
              OPENCLAW_STATE_DIR: path.join(root, "state"),
            },
            timeout: 30_000,
          },
          (error, stdout, stderr) => resolve({ error, stdout, stderr }),
        );
      },
    );
    expect(result.error, result.stderr || result.stdout).toBeNull();
    expect(result.stdout.trim()).toBe(
      "Packaged Memory and Skills workers returned workspace content",
    );
    expect(fs.existsSync(path.join(installedRoot, "dist/worker"))).toBe(false);
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
});
