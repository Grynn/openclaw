import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import * as bindings from "../../src/daemon/managed-gateway-bindings.js";
import type { GatewayServiceState } from "../../src/daemon/service-types.js";
import * as systemdFiles from "../../src/daemon/systemd-service-files.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => fsSync.readFileSync(...args),
  };
});

// Only the native service/proc boundary is simulated. Package discovery, physical
// output identity, alias handling, and the public fence decision use real owners.
export async function createImmutableGatewayLauncherFixture(root: string) {
  const release = path.join(root, "releases", "fixture-release");
  const checkout = path.join(root, "checkout");
  const entry = path.join(release, "dist", "index.js");
  const launcher = path.join(release, ".openclaw-release", "launcher");
  await fs.mkdir(path.dirname(entry), { recursive: true });
  await fs.mkdir(path.dirname(launcher));
  await fs.mkdir(checkout);
  await fs.writeFile(path.join(release, "package.json"), '{"name":"openclaw"}\n');
  await fs.writeFile(entry, "// Synthetic Gateway entry\n");
  await fs.writeFile(launcher, "#!/bin/sh\nexit 1\n", { mode: 0o500 });
  const pid = 9912345;
  const cgroup = "/fixture.slice/openclaw-gateway.service";
  const node = await fs.realpath(process.execPath);
  const proc = {
    argv: [node, entry, "gateway", "--port", "18789"],
    exe: node,
    executableFile: process.execPath,
    ticks: 12345,
    cgroup,
    inaccessible: false,
    view: (file: string) => file,
  };
  const state: GatewayServiceState = {
    installed: true,
    running: true,
    loadState: { status: "loaded" },
    env: {},
    command: {
      programArguments: [
        launcher,
        "run-release",
        "fixture-release",
        "--",
        "gateway",
        "--port",
        "18789",
      ],
      workingDirectory: root,
    },
    runtime: {
      status: "running",
      pid,
      systemd: { unit: "openclaw-gateway.service", controlGroup: cgroup },
    },
  };
  vi.spyOn(bindings, "discoverManagedGatewayBindings").mockResolvedValue([{ env: {} }]);
  vi.spyOn(systemdFiles, "readSystemdServiceCommandLocation").mockImplementation(async () => ({
    kind: "command",
    command: state.command!,
  }));
  const readState = vi
    .spyOn(bindings, "readManagedGatewayBindingState")
    .mockImplementation(async () => structuredClone(state));
  const readSync = fsSync.readFileSync;
  vi.spyOn(fsSync, "readFileSync").mockImplementation((...args) => {
    if (args[0] === `/proc/${pid}/stat`) {
      return `${pid} (node) S ${"0 ".repeat(18)}${proc.ticks}`;
    }
    if (args[0] === `/proc/${pid}/cgroup`) {
      return `0::${proc.cgroup}\n`;
    }
    return readSync(...args);
  });
  const readFile = fs.readFile;
  vi.spyOn(fs, "readFile").mockImplementation((...args) => {
    if (args[0] === `/proc/${pid}/cmdline`) {
      if (proc.inaccessible) {
        return Promise.reject(Object.assign(new Error("proc access denied"), { code: "EACCES" }));
      }
      return Promise.resolve(`${proc.argv.join("\0")}\0`);
    }
    return readFile(...args);
  });
  const readlink = fs.readlink;
  vi.spyOn(fs, "readlink").mockImplementation((...args) =>
    args[0] === `/proc/${pid}/exe` ? Promise.resolve(proc.exe) : readlink(...args),
  );
  const inProcessView = (file: unknown) =>
    typeof file === "string" && file.startsWith(`/proc/${pid}/root/`)
      ? proc.view(file.slice(`/proc/${pid}/root`.length))
      : file;
  const stat = fs.stat;
  vi.spyOn(fs, "stat").mockImplementation((...args) => {
    if (args[0] === `/proc/${pid}/exe`) {
      args[0] = proc.executableFile;
    }
    const mapped = inProcessView(args[0]);
    if (typeof mapped === "string") {
      args[0] = mapped;
    }
    return stat(...args);
  });
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation((...args) => {
    const mapped = inProcessView(args[0]);
    if (typeof mapped === "string") {
      args[0] = mapped;
    }
    return lstat(...args);
  });
  return { root, release, checkout, entry, proc, state, readState };
}
