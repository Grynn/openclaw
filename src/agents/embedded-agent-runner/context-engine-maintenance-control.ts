// Process-local ownership for scheduled context-engine turn maintenance.
// Durable task rows survive a process restart; registrations intentionally do not.
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

type ActiveContextEngineTurnMaintenanceRun = {
  lifecycle?: ContextEngineTurnMaintenanceLifecycle;
  registration: symbol;
  sessionKey: string;
};

type ContextEngineTurnMaintenanceLifecycle = {
  abort: (reason: Error) => void;
  cancelActiveTask: () => void;
  settled: Promise<void>;
};

type ContextEngineTurnMaintenanceRegistration = {
  attachLifecycle: (lifecycle: ContextEngineTurnMaintenanceLifecycle) => boolean;
  unregister: () => void;
};

const ACTIVE_CONTEXT_ENGINE_TURN_MAINTENANCE_RUNS_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceActiveRuns",
);
const CONTEXT_ENGINE_MAINTENANCE_RESTART_DRAIN_TIMEOUT_MS = 10_000;
const activeRunsByRunId = resolveGlobalSingleton(
  ACTIVE_CONTEXT_ENGINE_TURN_MAINTENANCE_RUNS_KEY,
  () => new Map<string, ActiveContextEngineTurnMaintenanceRun>(),
  (runs) => runs.clear(),
);

export function registerContextEngineTurnMaintenanceRun(params: {
  runId: string;
  sessionKey: string;
}): ContextEngineTurnMaintenanceRegistration | undefined {
  const runId = params.runId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!runId || !sessionKey) {
    return undefined;
  }
  const registration = Symbol(runId);
  activeRunsByRunId.set(runId, { registration, sessionKey });
  return {
    attachLifecycle: (lifecycle) => {
      const active = activeRunsByRunId.get(runId);
      if (active?.registration !== registration) {
        return false;
      }
      active.lifecycle = lifecycle;
      return true;
    },
    unregister: () => {
      if (activeRunsByRunId.get(runId)?.registration === registration) {
        activeRunsByRunId.delete(runId);
      }
    },
  };
}

export function isContextEngineTurnMaintenanceRunActive(params: {
  runId: string | undefined;
  sessionKey: string | undefined;
}): boolean {
  const runId = params.runId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (!runId || !sessionKey) {
    return false;
  }
  const active = activeRunsByRunId.get(runId);
  return active?.sessionKey === sessionKey;
}

/** Abort and drain deferred workers before an in-process gateway lifecycle is replaced. */
export async function abortDeferredTurnMaintenanceForLifecycleRestart(
  timeoutMs = CONTEXT_ENGINE_MAINTENANCE_RESTART_DRAIN_TIMEOUT_MS,
): Promise<{ active: number; drained: boolean }> {
  const reason = new Error("Gateway restarting during deferred maintenance");
  const ownershipSnapshot = Array.from(activeRunsByRunId.entries());
  const lifecycleSnapshot = ownershipSnapshot
    .map(([, active]) => active.lifecycle)
    .filter(
      (lifecycle): lifecycle is ContextEngineTurnMaintenanceLifecycle => lifecycle !== undefined,
    );
  for (const lifecycle of lifecycleSnapshot) {
    try {
      lifecycle.abort(reason);
    } catch {
      // Continue aborting the rest of the retired lifecycle.
    }
    try {
      lifecycle.cancelActiveTask();
    } catch {
      // Durable task cleanup is best-effort; settlement still gates lane reset.
    }
  }
  if (ownershipSnapshot.length === 0) {
    return { active: 0, drained: true };
  }
  const pending = new Set(lifecycleSnapshot);
  const settled = Promise.allSettled(
    lifecycleSnapshot.map((lifecycle) =>
      lifecycle.settled.finally(() => {
        pending.delete(lifecycle);
      }),
    ),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const allOwnersHaveLifecycle = lifecycleSnapshot.length === ownershipSnapshot.length;
  const drained = await Promise.race([
    allOwnersHaveLifecycle ? settled.then(() => true) : new Promise<true>(() => {}),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  if (!drained) {
    return {
      active: pending.size + (ownershipSnapshot.length - lifecycleSnapshot.length),
      drained: false,
    };
  }
  for (const [runId, active] of ownershipSnapshot) {
    if (activeRunsByRunId.get(runId)?.registration === active.registration) {
      activeRunsByRunId.delete(runId);
    }
  }
  return { active: 0, drained: true };
}

function resetContextEngineTurnMaintenanceRunsForTests(): void {
  activeRunsByRunId.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.contextEngineTurnMaintenanceControlTestApi")
  ] = {
    resetContextEngineTurnMaintenanceRunsForTests,
  };
}
