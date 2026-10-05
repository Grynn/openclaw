import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImmutableGatewayLauncherFixture } from "../../../test/helpers/immutable-gateway-launcher.js";
import * as bindings from "../../daemon/managed-gateway-bindings.js";
import * as services from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as gatewayLocks from "../../infra/gateway-lock.js";
import * as portProbe from "../../infra/ports-probe.js";
import { withServiceHome } from "./update-command-service-home.test-support.js";
import { withGatewayRuntimeArtifactPublication } from "./update-command-service-publication.js";

afterEach(() => vi.restoreAllMocks());

async function fixture(
  owner: "invoking" | "sibling",
  run: (
    fixture: Awaited<ReturnType<typeof createImmutableGatewayLauncherFixture>> & {
      env: NodeJS.ProcessEnv;
    },
  ) => Promise<void>,
) {
  mockSystemAccountHome();
  await withServiceHome(async (home) => {
    const f = await createImmutableGatewayLauncherFixture(home);
    const env = { ...process.env };
    f.state.env = env;
    f.state.runtime!.systemd!.managerUid = 2001;
    const invoking = path.join(home, "invoking");
    await fs.mkdir(path.join(invoking, "dist"), { recursive: true });
    await fs.writeFile(path.join(invoking, "package.json"), '{"name":"openclaw"}');
    await fs.writeFile(path.join(invoking, "dist", "index.js"), "export {};\n");
    const service = createMockGatewayService({
      readCommand: vi.fn(async () =>
        owner === "invoking"
          ? structuredClone(f.state.command)
          : {
              programArguments: [
                process.execPath,
                path.join(invoking, "dist", "index.js"),
                "gateway",
              ],
            },
      ),
      readRuntime: vi.fn(async () =>
        owner === "invoking"
          ? structuredClone(f.state.runtime!)
          : {
              status: "stopped" as const,
              systemd: { managerUid: 2001 },
            },
      ),
      isLoaded: vi.fn(async () => true),
      isEnabled: vi.fn(async () => true),
    });
    vi.spyOn(services, "resolveGatewayService").mockReturnValue(service);
    vi.mocked(bindings.discoverManagedGatewayBindings).mockResolvedValue(
      owner === "sibling" ? [{ env: { ...env, OPENCLAW_PROFILE: "sibling" } }] : [],
    );
    vi.spyOn(gatewayLocks, "readActiveGatewayLockIdentity").mockResolvedValue(undefined);
    vi.spyOn(portProbe, "probePortUsage").mockResolvedValue("free");
    await run({ ...f, env });
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  });
}

describe.skipIf(process.platform !== "linux")("immutable launcher runtime publication", () => {
  it.each(["invoking", "sibling"] as const)(
    "publishes separate output while the verified %s launcher keeps running",
    (owner) =>
      fixture(owner, async (f) => {
        const artifact = path.join(f.checkout, "published.txt");
        await withGatewayRuntimeArtifactPublication(
          {
            root: f.checkout,
            env: f.env,
            timeoutMs: 200,
            assertCurrent() {},
            outputPaths: ["dist"],
          },
          async (assertCurrent) => {
            await assertCurrent();
            await fs.writeFile(artifact, "published");
          },
        );
        expect(await fs.readFile(artifact, "utf8")).toBe("published");
      }),
  );

  it.each([
    { owner: "invoking", change: "output alias" },
    { owner: "sibling", change: "output alias" },
    { owner: "invoking", change: "unknown process" },
    { owner: "sibling", change: "unknown process" },
  ] as const)("refuses $owner publication with $change", ({ owner, change }) =>
    fixture(owner, async (f) => {
      if (change === "output alias") {
        await fs.symlink(path.join(f.release, "dist"), path.join(f.checkout, "dist"));
      } else {
        f.proc.inaccessible = true;
      }
      const publish = vi.fn();
      await expect(
        withGatewayRuntimeArtifactPublication(
          {
            root: f.checkout,
            env: f.env,
            timeoutMs: 200,
            assertCurrent() {},
            outputPaths: ["dist"],
          },
          publish,
        ),
      ).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
      expect(publish).not.toHaveBeenCalled();
    }),
  );

  it.each(["start time", "argv", "mount view", "loaded command"])(
    "revokes an admitted publication when %s changes before its effect",
    (change) =>
      fixture("invoking", async (f) => {
        const effect = vi.fn();
        let entered = false;
        await expect(
          withGatewayRuntimeArtifactPublication(
            {
              root: f.checkout,
              env: f.env,
              timeoutMs: 200,
              assertCurrent() {},
              outputPaths: ["dist"],
            },
            async (assertCurrent) => {
              entered = true;
              if (change === "start time") {
                f.proc.ticks++;
              }
              if (change === "argv") {
                f.proc.argv = ["replacement"];
              }
              if (change === "mount view") {
                f.proc.view = () => f.checkout;
              }
              if (change === "loaded command") {
                f.state.command!.programArguments[2] = "replacement";
              }
              await assertCurrent();
              effect();
            },
          ),
        ).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
        expect(entered).toBe(true);
        expect(effect).not.toHaveBeenCalled();
      }),
  );
});
