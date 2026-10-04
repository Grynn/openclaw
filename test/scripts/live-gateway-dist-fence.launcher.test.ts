import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import * as bindings from "../../src/daemon/managed-gateway-bindings.js";
import type { GatewayServiceState } from "../../src/daemon/service-types.js";
import * as systemdFiles from "../../src/daemon/systemd-service-files.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => fsSync.readFileSync(...args),
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

// Only the native service/proc boundary is simulated. Package discovery, physical
// output identity, alias handling, and the public fence decision use real owners.
async function fixture() {
  const root = dirs.make("openclaw-launcher-fence-");
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

describe.skipIf(process.platform !== "linux")("immutable launcher build fence", () => {
  it("permits a physically separate checkout only after corroborating the loaded release", async () => {
    const f = await fixture();
    await expect(
      resolveLiveManagedGatewayDistFence(f.checkout, {
        env: {},
        requireVerified: true,
        outputPaths: ["dist", "dist-runtime"],
      }),
    ).resolves.toEqual({ refuse: false });
  });

  it.each(["release", "output alias"])("refuses rebuilding the live %s", async (kind) => {
    const f = await fixture();
    if (kind === "output alias") {
      await fs.symlink(path.join(f.release, "dist"), path.join(f.checkout, "dist"));
    }
    const result = await resolveLiveManagedGatewayDistFence(
      kind === "release" ? f.release : f.checkout,
      { env: {}, requireVerified: true },
    );
    expect(result).toMatchObject({
      refuse: true,
      message: expect.stringContaining("overlapping build outputs"),
    });
  });

  it.each([
    "wrong release",
    "wrong argv",
    "wrong executable",
    "same executable path with different inode",
    "missing PID",
    "unreadable proc",
    "foreign cgroup",
  ])("keeps %s evidence fail-closed", async (kind) => {
    const f = await fixture();
    if (kind === "wrong release") {
      f.state.command!.programArguments[2] = "another-release";
    }
    if (kind === "wrong argv") {
      f.proc.argv[1] = path.join(f.checkout, "dist", "index.js");
    }
    if (kind === "wrong executable") {
      f.proc.exe = "/bin/sh";
    }
    if (kind === "same executable path with different inode") {
      f.proc.executableFile = f.entry;
    }
    if (kind === "missing PID") {
      delete f.state.runtime!.pid;
    }
    if (kind === "unreadable proc") {
      f.proc.inaccessible = true;
    }
    if (kind === "foreign cgroup") {
      f.proc.cgroup = "/another.slice/service";
    }
    await expect(
      resolveLiveManagedGatewayDistFence(f.checkout, { env: {}, requireVerified: true }),
    ).resolves.toMatchObject({ refuse: true, message: expect.stringContaining("Cannot verify") });
  });

  it.each(["entry", "output", "missing output"])(
    "rejects a different Gateway mount view of the %s",
    async (kind) => {
      const f = await fixture();
      const other = path.join(f.root, "other-view");
      await fs.mkdir(path.join(other, "dist-runtime"), { recursive: true });
      await fs.writeFile(path.join(other, "index.js"), "// Different file identity\n");
      const target =
        kind === "entry"
          ? f.entry
          : path.join(f.release, kind === "output" ? "dist" : "dist-runtime");
      f.proc.view = (file) =>
        file === target ? (kind === "entry" ? path.join(other, "index.js") : other) : file;
      await expect(
        resolveLiveManagedGatewayDistFence(f.checkout, {
          env: {},
          requireVerified: true,
          outputPaths: ["dist", "dist-runtime"],
        }),
      ).resolves.toMatchObject({ refuse: true });
    },
  );

  it("keeps an unverified recognized launcher fail-closed with default build options", async () => {
    const f = await fixture();
    f.proc.inaccessible = true;
    await expect(
      resolveLiveManagedGatewayDistFence(f.checkout, { env: {} }),
    ).resolves.toMatchObject({
      refuse: true,
      message: expect.stringContaining("Cannot verify"),
    });
  });

  it("does not let a verified launcher change best-effort handling of an unrelated unknown owner", async () => {
    const f = await fixture();
    vi.mocked(bindings.discoverManagedGatewayBindings).mockResolvedValue([
      { env: {} },
      { env: { OPENCLAW_PROFILE: "unrelated" } },
    ]);
    f.readState.mockImplementation(async (binding) =>
      binding.env.OPENCLAW_PROFILE === "unrelated"
        ? {
            installed: false,
            running: false,
            loadState: { status: "unknown", detail: "Synthetic unrelated owner is unreadable" },
            command: null,
            env: {},
          }
        : structuredClone(f.state),
    );
    await expect(resolveLiveManagedGatewayDistFence(f.checkout, { env: {} })).resolves.toEqual({
      refuse: false,
    });
  });

  it.each(["PID", "argv", "start time", "executable", "cgroup", "mount view", "loaded command"])(
    "rejects a changed %s during asynchronous inspection",
    async (kind) => {
      const f = await fixture();
      const initial = structuredClone(f.state);
      f.readState.mockResolvedValueOnce(initial).mockImplementation(async () => {
        if (kind === "PID") {
          f.state.runtime!.pid = 9912346;
        }
        if (kind === "argv") {
          f.proc.argv = ["another process"];
        }
        if (kind === "start time") {
          f.proc.ticks++;
        }
        if (kind === "executable") {
          f.proc.exe = "/bin/sh";
        }
        if (kind === "cgroup") {
          f.proc.cgroup = "/another.slice/service";
        }
        if (kind === "mount view") {
          f.proc.view = () => f.checkout;
        }
        if (kind === "loaded command") {
          f.state.command!.programArguments[2] = "another-release";
        }
        return structuredClone(f.state);
      });
      await expect(
        resolveLiveManagedGatewayDistFence(f.checkout, { env: {}, requireVerified: true }),
      ).resolves.toMatchObject({ refuse: true });
    },
  );
});
