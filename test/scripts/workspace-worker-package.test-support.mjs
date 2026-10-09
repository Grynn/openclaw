import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageRoot, workspace] = process.argv.slice(2);
assert(packageRoot && workspace, "Requires installed package and disposable workspace paths");
fs.mkdirSync(workspace);
const memoryPath = path.join(workspace, "MEMORY.md");
const skillPath = path.join(workspace, "SKILL.md");
fs.writeFileSync(memoryPath, "Packaged memory content\n");
fs.writeFileSync(skillPath, "Packaged skill instructions\n");
const { resolveWorkspaceWorkerArgv } = await import(
  pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/agent-workspace-runtime.js")).href
);
const failures = [];
for (const [kind, args, request, expected] of [
  [
    "memory",
    ["--files", workspace],
    { operation: "readForIndexing", filePath: memoryPath },
    { result: { content: "Packaged memory content\n", canonicalRelativePath: "MEMORY.md" } },
  ],
  [
    "skills",
    [workspace, path.dirname(workspace), "readInstructions"],
    { filePath: skillPath },
    "Packaged skill instructions\n",
  ],
]) {
  try {
    const argv = resolveWorkspaceWorkerArgv(kind);
    const child = spawnSync(process.execPath, [...argv, ...args], {
      cwd: workspace,
      env: process.env,
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, `${kind}: ${child.stderr}`);
    assert.deepEqual(JSON.parse(child.stdout), expected);
  } catch (error) {
    failures.push(`${kind}: ${String(error)}`);
  }
}
assert.deepEqual(failures, []);
console.log("Packaged Memory and Skills workers returned workspace content");
