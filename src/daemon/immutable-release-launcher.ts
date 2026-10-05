import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { getProcessStartTime } from "../shared/pid-alive.js";
import { inspectSystemdProcessMembershipSync } from "./service-process-membership.js";
import type { GatewayServiceState } from "./service-types.js";

export function isGatewayReleaseLauncher(command: GatewayServiceState["command"]): boolean {
  const launcher = command?.programArguments[0] ?? "";
  return (
    path.basename(launcher) === "launcher" &&
    path.basename(path.dirname(launcher)) === ".openclaw-release"
  );
}

// A private systemd mount namespace can share / while remapping release artifacts.
// Compare the actual process view, including absence on both sides, not just /.
async function processArtifactIdentity(pid: number, file: string): Promise<string | null> {
  const stat = async (candidate: string) =>
    fs.stat(candidate).catch(async (error: unknown) => {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      const entry = await fs.lstat(candidate).catch((failure: unknown) => {
        if (!hasErrnoCode(failure, "ENOENT")) {
          throw failure;
        }
        return null;
      });
      if (entry) {
        throw error;
      } // Dangling links do not establish absence.
      return null;
    });
  for (let candidate = file; ; candidate = path.dirname(candidate)) {
    const [host, serving] = await Promise.all([
      stat(candidate),
      stat(path.join(`/proc/${pid}/root`, candidate)),
    ]);
    if (host || serving) {
      return host && serving && host.dev === serving.dev && host.ino === serving.ino
        ? `${candidate}:${host.dev}:${host.ino}`
        : null;
    }
    if (path.dirname(candidate) === candidate) {
      return null;
    }
  }
}

/** Corroborate this specific exec-style launcher without executing or trusting its text. */
export async function inspectVerifiedGatewayReleaseLauncher<T>(
  params: {
    state: GatewayServiceState;
    readState: () => Promise<GatewayServiceState>;
    outputPaths: readonly string[];
    assertCurrent?: () => void;
  },
  inspect: (command: NonNullable<GatewayServiceState["command"]>) => Promise<T>,
): Promise<{ value: T; identity: string } | null> {
  params.assertCurrent?.();
  const { state } = params;
  const command = state.command;
  const args = command?.programArguments ?? [];
  const launcher = args[0] ?? "";
  const release = path.dirname(path.dirname(launcher));
  const pid = state.runtime?.pid;
  const cgroup = state.runtime?.systemd?.controlGroup;
  if (
    process.platform !== "linux" ||
    !isGatewayReleaseLauncher(command) ||
    !path.isAbsolute(launcher) ||
    path.normalize(launcher) !== launcher ||
    args[1] !== "run-release" ||
    args[2] !== path.basename(release) ||
    args[3] !== "--" ||
    args[4] !== "gateway" ||
    !state.installed ||
    state.loadState.status !== "loaded" ||
    !state.running ||
    state.runtime?.status !== "running" ||
    command?.reloadPending ||
    !pid ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !cgroup ||
    (await fs.realpath(launcher)) !== launcher ||
    !(await fs.lstat(launcher)).isFile()
  ) {
    return null;
  }

  const entry = path.join(release, "dist", "index.js");
  if ((await fs.realpath(entry)) !== entry) {
    return null;
  }
  const node = await fs.realpath(process.execPath);
  const directCommand = { programArguments: [node, entry, ...args.slice(4)] };
  const stateIdentity = (current: GatewayServiceState) =>
    JSON.stringify({
      installed: current.installed,
      loaded: current.loadState.status,
      running: current.running,
      command: current.command,
      status: current.runtime?.status,
      pid: current.runtime?.pid,
      systemd: {
        scope: current.runtime?.systemd?.scope,
        unit: current.runtime?.systemd?.unit,
        managerUid: current.runtime?.systemd?.managerUid,
        controlGroup: current.runtime?.systemd?.controlGroup,
      },
    });
  const expectedState = stateIdentity(state);
  const observe = async () => {
    const started = getProcessStartTime(pid);
    if (started === null || inspectSystemdProcessMembershipSync(pid, cgroup) !== "inside") {
      return null;
    }
    const [argv, exe, identities, processExe, ownExe] = await Promise.all([
      fs.readFile(`/proc/${pid}/cmdline`, "utf8"),
      fs.readlink(`/proc/${pid}/exe`),
      Promise.all(
        [entry, ...params.outputPaths.map((output) => path.join(release, output))].map((file) =>
          processArtifactIdentity(pid, file),
        ),
      ),
      fs.stat(`/proc/${pid}/exe`),
      fs.stat("/proc/self/exe"),
    ]);
    // process.title may erase argv; that is unknown, never permission to build.
    if (
      argv !== `${directCommand.programArguments.join("\0")}\0` ||
      exe !== node ||
      processExe.dev !== ownExe.dev ||
      processExe.ino !== ownExe.ino ||
      identities.some((identity) => identity === null) ||
      getProcessStartTime(pid) !== started ||
      inspectSystemdProcessMembershipSync(pid, cgroup) !== "inside"
    ) {
      return null;
    }
    return JSON.stringify({ started, argv, exe, identities });
  };
  const before = await observe();
  if (!before) {
    return null;
  }
  params.assertCurrent?.();
  const value = await inspect(directCommand);
  params.assertCurrent?.();
  const current = await params.readState();
  params.assertCurrent?.();
  // PID reuse, execve, service replacement, and mount changes all invalidate proof.
  if (stateIdentity(current) !== expectedState || (await observe()) !== before) {
    return null;
  }
  params.assertCurrent?.();
  return { value, identity: JSON.stringify({ state: expectedState, process: before }) };
}
