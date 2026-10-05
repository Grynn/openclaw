import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import * as bindings from "../../src/daemon/managed-gateway-bindings.js";
import { createImmutableGatewayLauncherFixture } from "../helpers/immutable-gateway-launcher.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const fixture = () => createImmutableGatewayLauncherFixture(dirs.make("openclaw-launcher-fence-"));

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
