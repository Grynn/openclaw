import fs from "node:fs/promises";
import path from "node:path";
import type { LoadedLaunchAgentState } from "../../src/daemon/launchd-runtime.ts";
import type { ManagedGatewayBinding } from "../../src/daemon/managed-gateway-bindings.ts";
import type { GatewayServiceState } from "../../src/daemon/service-types.ts";
import { hasErrnoCode } from "../../src/infra/errno.ts";
import { hasCommandProcessCleanupError } from "../../src/process/exec-result.ts";

type LiveGatewayDistFenceResult = { refuse: true; message: string } | { refuse: false };
function formatRefuseMessage(params: {
  owners: readonly string[];
  showUpdateHint: boolean;
  entrypoint?: string;
  unit?: string;
}): string {
  const owners = [...new Set(params.owners)].join(", ");
  const entry = params.entrypoint ? ` (${params.entrypoint})` : "";
  const unit = params.unit ? ` unit ${params.unit}` : "";
  return (
    `[openclaw] Refusing to rebuild artifacts while a managed Gateway (${owners}) is still using overlapping build outputs${unit}${entry}. ` +
    "From an external terminal, stop every listed Gateway through its original native service or Startup owner, " +
    "run `pnpm build` in this checkout, then after a successful build start those same services." +
    (params.showUpdateHint
      ? " `openclaw update` can apply an available update; an already-current result does not rebuild stale dist."
      : "")
  );
}

async function tryRealpath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    // Missing output keeps its physical parent; dangling links never prove separation.
    const entry = await fs.lstat(resolved).catch((failure: unknown) => {
      if (!hasErrnoCode(failure, "ENOENT")) {
        throw failure;
      }
      return null;
    });
    const parent = path.dirname(resolved);
    if (entry || parent === resolved) {
      throw error;
    }
    return path.join(await tryRealpath(parent), path.basename(resolved));
  }
}

async function loadFenceRuntime() {
  try {
    const [layout, bindings, pathGuards, serviceRuntime, membership, identity] = await Promise.all([
      import("../../src/daemon/service-layout.ts"),
      import("../../src/daemon/managed-gateway-bindings.ts"),
      import("../../src/infra/path-guards.ts"),
      import("../../src/daemon/service-runtime.ts"),
      import("../../src/daemon/service-process-membership.ts"),
      import("../../src/shared/pid-alive.ts"),
    ]);
    return {
      summarizeGatewayServiceLayout: layout.summarizeGatewayServiceLayout,
      resolveServiceEntrypoint: layout.resolveServiceEntrypoint,
      readManagedGatewayBindingState: bindings.readManagedGatewayBindingState,
      describeManagedGatewayBinding: bindings.describeManagedGatewayBinding,
      isPathInside: pathGuards.isPathInside,
      isGatewayServiceStateLive: serviceRuntime.isGatewayServiceStateLive,
      inspectSystemdProcessMembershipSync: membership.inspectSystemdProcessMembershipSync,
      getProcessStartTime: identity.getProcessStartTime,
    };
  } catch {
    return null;
  }
}

function isReleaseLauncher(command: GatewayServiceState["command"]): boolean {
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
async function releaseLauncherOverlapsPhysicalCheckout(
  checkoutRoot: string,
  binding: ManagedGatewayBinding,
  state: GatewayServiceState,
  runtime: NonNullable<Awaited<ReturnType<typeof loadFenceRuntime>>>,
  options: { requireVerified?: boolean; outputPaths?: readonly string[] },
): Promise<boolean | null> {
  const command = state.command;
  const args = command?.programArguments ?? [];
  const launcher = args[0] ?? "";
  const release = path.dirname(path.dirname(launcher));
  const pid = state.runtime?.pid;
  const cgroup = state.runtime?.systemd?.controlGroup;
  if (
    process.platform !== "linux" ||
    !isReleaseLauncher(command) ||
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
    const started = runtime.getProcessStartTime(pid);
    if (started === null || runtime.inspectSystemdProcessMembershipSync(pid, cgroup) !== "inside") {
      return null;
    }
    const [argv, exe, identities, sameRuntime] = await Promise.all([
      fs.readFile(`/proc/${pid}/cmdline`, "utf8"),
      fs.readlink(`/proc/${pid}/exe`),
      Promise.all(
        [
          entry,
          ...(options.outputPaths ?? ["dist"]).map((output) => path.join(release, output)),
        ].map((file) => processArtifactIdentity(pid, file)),
      ),
      samePathIdentity(`/proc/${pid}/exe`, "/proc/self/exe", new Map()),
    ]);
    // process.title may erase argv; that is unknown, never permission to build.
    if (
      argv !== `${directCommand.programArguments.join("\0")}\0` ||
      exe !== node ||
      !sameRuntime ||
      identities.some((identity) => identity === null) ||
      runtime.getProcessStartTime(pid) !== started ||
      runtime.inspectSystemdProcessMembershipSync(pid, cgroup) !== "inside"
    ) {
      return null;
    }
    return JSON.stringify({ started, argv, exe, identities });
  };
  const before = await observe();
  if (!before) {
    return null;
  }
  const overlaps = await gatewayServiceCommandOverlapsPhysicalCheckout(
    checkoutRoot,
    directCommand,
    options,
  );
  const current = await runtime.readManagedGatewayBindingState(binding);
  // PID reuse, execve, service replacement, and mount changes all invalidate proof.
  if (stateIdentity(current) !== expectedState || (await observe()) !== before) {
    return null;
  }
  return overlaps;
}

async function samePathIdentity(
  left: string,
  right: string,
  statCache: Map<string, Promise<Awaited<ReturnType<typeof fs.stat>> | null>>,
): Promise<boolean> {
  if (left === right) {
    return true;
  }
  const stat = (file: string) => {
    let pending = statCache.get(file);
    if (!pending) {
      pending = fs.stat(file).catch((error: unknown) => {
        if (!hasErrnoCode(error, "ENOENT")) {
          throw error;
        }
        return null;
      });
      statCache.set(file, pending);
    }
    return pending;
  };
  const [leftStat, rightStat] = await Promise.all([left, right].map(stat));
  return Boolean(
    leftStat && rightStat && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino,
  );
}

/**
 * True when a written output root physically overlaps the serving Gateway
 * artifacts. Logical current/releases ownership is not enough.
 */
export async function gatewayServiceCommandOverlapsPhysicalCheckout(
  checkoutRoot: string,
  command: GatewayServiceState["command"],
  options: { requireVerified?: boolean; outputPaths?: readonly string[] } = {},
): Promise<boolean | null> {
  // Its release id is an operand, not a relative Gateway entrypoint. Only a
  // corroborated live process can resolve this wrapper's artifact ownership.
  if (isReleaseLauncher(command)) {
    return null;
  }
  const runtime = await loadFenceRuntime();
  if (!runtime) {
    return null;
  }
  const layout = await runtime.summarizeGatewayServiceLayout(command);
  const servingRoot = layout?.packageRootReal ?? layout?.packageRoot;
  const servingEntry = layout?.entrypointReal ?? layout?.entrypoint;
  if (
    !servingRoot ||
    !servingEntry ||
    (!path.isAbsolute(servingEntry) && !path.win32.isAbsolute(servingEntry))
  ) {
    return null;
  }

  const servingEntryReal = await tryRealpath(servingEntry);
  const outputPaths = options.outputPaths ?? ["dist"];
  const servingOutputs = await Promise.all(
    outputPaths.map((output) => tryRealpath(path.join(servingRoot, output))),
  );
  const statCache = new Map<string, Promise<Awaited<ReturnType<typeof fs.stat>> | null>>();
  // A source entry outside generated outputs does not hold their imports open.
  // The packaged launcher imports generated outputs from its package root.
  if (
    !servingOutputs.some((output) => runtime.isPathInside(output, servingEntryReal)) &&
    servingEntryReal !== path.join(servingRoot, "openclaw.mjs")
  ) {
    return false;
  }
  for (const output of outputPaths) {
    const checkoutOutput = await tryRealpath(path.join(checkoutRoot, output));
    if (!options.requireVerified) {
      const existing = await fs.stat(checkoutOutput).catch(() => null);
      if (!existing?.isDirectory()) {
        continue;
      }
    }
    if (runtime.isPathInside(checkoutOutput, servingEntryReal)) {
      return true;
    }
    for (const servingOutput of servingOutputs) {
      if (
        runtime.isPathInside(checkoutOutput, servingOutput) ||
        runtime.isPathInside(servingOutput, checkoutOutput) ||
        (await samePathIdentity(checkoutOutput, servingOutput, statCache))
      ) {
        return true;
      }
    }
  }
  return false;
}

async function resolveFenceBindings(
  env: NodeJS.ProcessEnv,
  requireComplete?: boolean,
): Promise<readonly ManagedGatewayBinding[] | null> {
  try {
    const inspect = await import("../../src/daemon/managed-gateway-bindings.ts");
    return await inspect.discoverManagedGatewayBindings(env, {
      requireComplete,
      includeInvoking: true,
    });
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return null;
  }
}

/**
 * Returns a refuse decision when a managed Gateway ExecStart resolves into
 * `checkoutRoot` and the service still holds a live process.
 */
export async function resolveLiveManagedGatewayDistFence(
  checkoutRoot: string,
  options: {
    env?: NodeJS.ProcessEnv;
    requireVerified?: boolean;
    outputPaths?: readonly string[];
  } = {},
): Promise<LiveGatewayDistFenceResult> {
  const env = options.env ?? process.env;
  const unknown = {
    refuse: true,
    message:
      "[openclaw] Cannot verify that test preparation is separate from managed Gateway artifacts. Use the existing isolated test runner; no checkout artifacts were rebuilt.",
  } as const;
  const bindings = await resolveFenceBindings(env, options.requireVerified);
  if (!bindings) {
    return options.requireVerified ? unknown : { refuse: false };
  }

  const root = path.resolve(checkoutRoot);
  const holds: Array<{
    owner: string;
    binding: ManagedGatewayBinding;
    state: LoadedLaunchAgentState;
  }> = [];
  let unverified = false;
  let unverifiedLauncher = false;
  for (const binding of bindings) {
    let launcher = false;
    try {
      const runtime = await loadFenceRuntime();
      if (!runtime) {
        unverified = true;
        continue;
      }
      if (options.requireVerified && process.platform === "linux") {
        // Artifact separation needs the loaded command, not protected service credentials.
        // An unavailable location never grants permission; the full owner may still prove absence.
        const { readSystemdServiceCommandLocation } =
          await import("../../src/daemon/systemd-service-files.ts");
        const location = await readSystemdServiceCommandLocation(
          binding.env,
          binding.systemdReadTarget,
        ).catch((error: unknown) => {
          if (hasCommandProcessCleanupError(error)) {
            throw error;
          }
          return undefined;
        });
        if (
          location?.kind === "not-loaded" ||
          (location?.kind === "command" &&
            (await gatewayServiceCommandOverlapsPhysicalCheckout(
              root,
              location.command,
              options,
            )) === false)
        ) {
          continue;
        }
      }
      // A discovered sibling keeps its own selectors, rather than ambient profile overrides.
      const state = await runtime.readManagedGatewayBindingState(binding);
      launcher = isReleaseLauncher(state.command);
      const matches = launcher
        ? await releaseLauncherOverlapsPhysicalCheckout(root, binding, state, runtime, options)
        : await gatewayServiceCommandOverlapsPhysicalCheckout(root, state.command, options);
      if (matches === false) {
        continue;
      }
      if (matches === null) {
        // Best-effort discovery must not fail open on this recognized launcher.
        unverifiedLauncher ||= launcher;
        // Native readers can prove absence without setting the optional missingUnit hint.
        unverified ||= Boolean(
          state.command ||
          state.installed ||
          state.loadState.status !== "not-loaded" ||
          state.runtime?.status !== "stopped" ||
          runtime.isGatewayServiceStateLive(state),
        );
        continue;
      }
      if (!runtime.isGatewayServiceStateLive(state)) {
        unverified ||= state.runtime?.status !== "stopped" || state.loadState.status === "unknown";
        continue;
      }
      holds.push({ owner: runtime.describeManagedGatewayBinding(binding, state), binding, state });
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      unverifiedLauncher ||= launcher;
      unverified = true;
    }
  }
  if (holds.length === 0) {
    return (options.requireVerified || unverifiedLauncher) && unverified
      ? unknown
      : { refuse: false };
  }

  const runtime = await loadFenceRuntime();
  let entrypoint: string | undefined;
  let unit: string | undefined;
  for (const hold of holds) {
    if (!entrypoint && hold.state.command && runtime) {
      entrypoint = isReleaseLauncher(hold.state.command)
        ? hold.state.command.programArguments[0]
        : runtime.resolveServiceEntrypoint(hold.state.command);
    }
    if (!unit && hold.state.runtime?.systemd?.unit) {
      unit = hold.state.runtime.systemd.unit;
    }
  }

  return {
    refuse: true,
    message: formatRefuseMessage({
      owners: holds.map((hold) => hold.owner),
      showUpdateHint: !holds.some(
        (hold) => hold.binding.windowsStartupEntry || hold.state.launchAgent,
      ),
      ...(entrypoint ? { entrypoint } : {}),
      ...(unit ? { unit } : {}),
    }),
  };
}
