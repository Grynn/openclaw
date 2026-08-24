/**
 * Schedules and runs deferred context-engine turn maintenance.
 */
import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { publishTranscriptUpdate } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveContextEngineOwnerPluginId } from "../../context-engine/registry.js";
import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
  ContextEngineRuntimeContext,
  ContextEngineRuntimeSettings,
  ContextEngineSessionTarget,
} from "../../context-engine/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  clearCommandLane,
  enqueueCommandInLane,
  GatewayDrainingError,
  isGatewayDraining,
} from "../../process/command-queue.js";
import { CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND } from "../../tasks/context-engine-maintenance-task-contract.js";
import {
  completeTaskRunByRunId,
  createQueuedTaskRun,
  failTaskRunByRunId,
  recordTaskRunProgressByRunId,
  startTaskRunByRunId,
} from "../../tasks/detached-task-runtime.js";
import {
  cancelTaskByIdForOwner,
  findTaskByRunIdForOwner,
  updateTaskNotifyPolicyForOwner,
} from "../../tasks/task-owner-access.js";
import { findActiveSessionTask } from "../session-async-task-status.js";
import { SessionManager } from "../sessions/index.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import {
  isContextEngineTurnMaintenanceRunActive,
  registerContextEngineTurnMaintenanceRun,
} from "./context-engine-maintenance-control.js";
import { log } from "./logger.js";
import { rewriteTranscriptEntriesInSessionManager } from "./transcript-rewrite.js";
import { resolveRuntimeTranscriptReadTarget } from "./transcript-runtime-state.js";

const TURN_MAINTENANCE_LANE_PREFIX = "context-engine-turn-maintenance:";
const TURN_MAINTENANCE_LONG_WAIT_MS = 10_000;
const DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY = Symbol.for(
  "openclaw.contextEngineTurnMaintenanceAbortState",
);
type SessionManagerRewriteLock = <T>(operation: () => Promise<T> | T) => Promise<T>;

type ContextEngineMaintenanceParams = {
  contextEngine?: ContextEngine;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: ContextEngineSessionTarget;
  sessionFile: string;
  reason: "bootstrap" | "compaction" | "turn";
  sessionManager?: Parameters<typeof rewriteTranscriptEntriesInSessionManager>[0]["sessionManager"];
  withSessionManagerRewriteLock?: SessionManagerRewriteLock;
  runtimeContext?: ContextEngineRuntimeContext;
  runtimeSettings?: ContextEngineRuntimeSettings;
  abortSignal?: AbortSignal;
  agentId?: string;
  contextEngineAgentId?: string;
  executionMode?: "foreground" | "background";
  onDeferredMaintenance?: (promise: Promise<void>) => void;
  onDeferredMaintenanceFailure?: (error: unknown) => void;
  config?: OpenClawConfig;
  disposeDeferredContextEngineAfterMaintenance?: boolean;
};

type DeferredTurnMaintenanceScheduleParams = ContextEngineMaintenanceParams & {
  contextEngine: ContextEngine;
  sessionKey: string;
  disposeContextEngineAfterMaintenance?: boolean;
  onScheduleFailure?: (error: unknown) => void;
};

type DeferredTurnMaintenanceRunState = {
  abort: (reason: Error) => void;
  activeParams: DeferredTurnMaintenanceScheduleParams;
  deferredEngineDisposals: Set<ContextEngine>;
  promise: Promise<void>;
  rerunRequested: boolean;
  latestParams: DeferredTurnMaintenanceScheduleParams;
};

const activeDeferredTurnMaintenanceRuns = new Map<string, DeferredTurnMaintenanceRunState>();

type DeferredTurnMaintenanceSignal = "SIGINT" | "SIGTERM";
type DeferredTurnMaintenanceProcessLike = Pick<NodeJS.Process, "on" | "off"> &
  Partial<Pick<NodeJS.Process, "listenerCount" | "kill" | "pid">> & {
    [DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY]?: DeferredTurnMaintenanceAbortState;
  };
type DeferredTurnMaintenanceAbortState = {
  controllers: Set<AbortController>;
  cleanupHandlers: Map<DeferredTurnMaintenanceSignal, () => void>;
};

function unregisterDeferredTurnMaintenanceAbortSignalHandlers(
  processLike: DeferredTurnMaintenanceProcessLike,
  state: DeferredTurnMaintenanceAbortState,
): void {
  for (const [signal, handler] of state.cleanupHandlers) {
    processLike.off(signal, handler);
  }
  state.cleanupHandlers.clear();
}

async function disposeDeferredMaintenanceContextEngine(
  contextEngine: ContextEngine,
): Promise<void> {
  try {
    await contextEngine.dispose?.();
  } catch (err) {
    log.warn("context engine dispose failed after deferred maintenance", {
      errorMessage: formatErrorMessage(err),
    });
  }
}

function createDeferredTurnMaintenanceAbortSignal(params?: {
  processLike?: DeferredTurnMaintenanceProcessLike;
}): {
  abort: (reason: Error) => void;
  abortSignal: AbortSignal;
  dispose: () => void;
} {
  const processLike = (params?.processLike ?? process) as DeferredTurnMaintenanceProcessLike;
  const state = (processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY] ??= {
    controllers: new Set<AbortController>(),
    cleanupHandlers: new Map<DeferredTurnMaintenanceSignal, () => void>(),
  });
  const handleTerminationSignal = (signalName: DeferredTurnMaintenanceSignal) => {
    const shouldReraise = processLike.listenerCount?.(signalName) === 1;
    for (const activeController of state.controllers) {
      if (!activeController.signal.aborted) {
        activeController.abort(
          new Error(`received ${signalName} while waiting for deferred maintenance`),
        );
      }
    }
    state.controllers.clear();
    unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
    if (shouldReraise && typeof processLike.kill === "function") {
      try {
        processLike.kill(processLike.pid ?? process.pid, signalName);
      } catch {
        // Ignore shutdown-path failures.
      }
    }
  };
  if (state.cleanupHandlers.size === 0) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = () => handleTerminationSignal(signal);
      state.cleanupHandlers.set(signal, handler);
      processLike.on(signal, handler);
    }
  }

  const controller = new AbortController();
  state.controllers.add(controller);
  return {
    abort: (reason) => controller.abort(reason),
    abortSignal: controller.signal,
    dispose: () => {
      state.controllers.delete(controller);
      if (state.controllers.size === 0) {
        unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
      }
    },
  };
}

function resetDeferredTurnMaintenanceStateForTest(): void {
  activeDeferredTurnMaintenanceRuns.clear();
  const processLike = process as DeferredTurnMaintenanceProcessLike;
  const state = processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
  if (!state) {
    return;
  }
  state.controllers.clear();
  unregisterDeferredTurnMaintenanceAbortSignalHandlers(processLike, state);
  delete processLike[DEFERRED_TURN_MAINTENANCE_ABORT_STATE_KEY];
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.contextEngineMaintenanceTestApi")
  ] = {
    createDeferredTurnMaintenanceAbortSignal,
    resetDeferredTurnMaintenanceStateForTest,
  };
}

export async function waitForDeferredTurnMaintenanceForSession(sessionKey?: string): Promise<void> {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey) {
    return;
  }
  await activeDeferredTurnMaintenanceRuns.get(normalizedSessionKey)?.promise;
}

function buildTurnMaintenanceTaskDescriptor(params: {
  sessionKey: string;
  runId?: string;
  notifyPolicy?: "silent" | "done_only" | "state_changes";
  deliveryStatus?: "not_applicable" | "pending";
}) {
  const runId =
    params.runId ??
    `turn-maint:${params.sessionKey}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;
  return createQueuedTaskRun({
    runtime: "acp",
    taskKind: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
    sourceId: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
    requesterSessionKey: params.sessionKey,
    ownerKey: params.sessionKey,
    scopeKind: "session",
    runId,
    label: "Context engine turn maintenance",
    task: "Deferred context-engine maintenance after turn.",
    notifyPolicy: params.notifyPolicy ?? "silent",
    // Fast maintenance stays silent and must not create a one-task flow.
    // Long-running and failed workers promote it to pending before notifying.
    deliveryStatus: params.deliveryStatus ?? "not_applicable",
    preferMetadata: true,
  });
}

/**
 * Attach runtime-owned transcript rewrite helpers to an existing
 * context-engine runtime context payload.
 */
function buildContextEngineMaintenanceRuntimeContext(
  params: Omit<ContextEngineMaintenanceParams, "reason"> & {
    allowDeferredCompactionExecution?: boolean;
    purpose?: string;
    contextEnginePluginId?: string;
  },
): ContextEngineRuntimeContext {
  return {
    ...params.runtimeContext,
    ...resolveContextEngineCapabilities({
      config: params.config,
      sessionKey: params.sessionKey,
      explicitAgentId: params.contextEngineAgentId,
      authProfileId: normalizeOptionalString(params.runtimeContext?.authProfileId),
      contextEnginePluginId: params.contextEnginePluginId,
      purpose: params.purpose ?? "context-engine.maintenance",
    }),
    ...(params.sessionTarget ? { sessionTarget: params.sessionTarget } : {}),
    ...(params.allowDeferredCompactionExecution ? { allowDeferredCompactionExecution: true } : {}),
    rewriteTranscriptEntries: async (request) => {
      const runtimeAgentId = params.sessionTarget?.agentId ?? params.agentId;
      const runtimeSessionKey = normalizeOptionalString(
        params.sessionTarget?.sessionKey ?? params.sessionKey,
      );
      if (!runtimeSessionKey) {
        throw new Error("Context-engine transcript rewrite requires a session key");
      }
      const runtimeStorePath =
        params.sessionTarget?.storePath ??
        (runtimeAgentId
          ? resolveSessionStorePathCore(params.config?.session?.store, { agentId: runtimeAgentId })
          : undefined);
      let runtimeTarget: Awaited<ReturnType<typeof resolveRuntimeTranscriptReadTarget>> | undefined;
      let sessionManager = params.sessionManager;
      if (!sessionManager) {
        runtimeTarget = await resolveRuntimeTranscriptReadTarget({
          sessionId: params.sessionTarget?.sessionId ?? params.sessionId,
          sessionKey: runtimeSessionKey,
          sessionFile: params.sessionFile,
          ...(runtimeAgentId ? { agentId: runtimeAgentId } : {}),
          ...(runtimeStorePath ? { storePath: runtimeStorePath } : {}),
        });
        sessionManager = SessionManager.open(runtimeTarget);
      }
      const rewriteSessionManagerEntries = () =>
        rewriteTranscriptEntriesInSessionManager({
          sessionManager,
          replacements: request.replacements,
        });
      const result = params.withSessionManagerRewriteLock
        ? await params.withSessionManagerRewriteLock(rewriteSessionManagerEntries)
        : await rewriteSessionManagerEntries();
      if (result.changed && runtimeTarget) {
        await publishTranscriptUpdate(runtimeTarget);
      }
      return result;
    },
  };
}

async function executeContextEngineMaintenance(
  params: ContextEngineMaintenanceParams & {
    contextEngine: ContextEngine;
    executionMode: "foreground" | "background";
  },
): Promise<ContextEngineMaintenanceResult | undefined> {
  if (typeof params.contextEngine.maintain !== "function") {
    return undefined;
  }
  const result = await params.contextEngine.maintain({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionTarget: params.sessionTarget,
    sessionFile: params.sessionFile,
    runtimeSettings: params.runtimeSettings,
    abortSignal: params.abortSignal,
    runtimeContext: buildContextEngineMaintenanceRuntimeContext({
      ...params,
      sessionManager: params.executionMode === "background" ? undefined : params.sessionManager,
      withSessionManagerRewriteLock:
        params.executionMode === "background" ? undefined : params.withSessionManagerRewriteLock,
      allowDeferredCompactionExecution: params.executionMode === "background",
      purpose: `context-engine.${params.reason}.maintenance`,
      contextEnginePluginId: resolveContextEngineOwnerPluginId(params.contextEngine),
    }),
  });
  if (result.changed) {
    log.info(
      `[context-engine] maintenance(${params.reason}) changed transcript ` +
        `rewrittenEntries=${result.rewrittenEntries} bytesFreed=${result.bytesFreed} ` +
        `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"}`,
    );
  }
  return result;
}

async function runDeferredTurnMaintenanceWorker(
  params: DeferredTurnMaintenanceScheduleParams & {
    schedulerAbortSignal: AbortSignal;
    runId: string;
  },
): Promise<void> {
  let surfacedUserNotice = false;
  let longRunningTimer: ReturnType<typeof setTimeout> | undefined;
  const shutdownAbort = createDeferredTurnMaintenanceAbortSignal();
  const abortSignal = AbortSignal.any([params.schedulerAbortSignal, shutdownAbort.abortSignal]);
  const taskRun = { runId: params.runId, runtime: "acp" as const, sessionKey: params.sessionKey };
  const makeTaskVisible = (notifyPolicy: "done_only" | "state_changes") =>
    buildTurnMaintenanceTaskDescriptor({
      sessionKey: params.sessionKey,
      runId: params.runId,
      notifyPolicy,
      deliveryStatus: "pending",
    });

  try {
    abortSignal.throwIfAborted();
    const runningAt = Date.now();
    startTaskRunByRunId({
      ...taskRun,
      startedAt: runningAt,
      lastEventAt: runningAt,
      progressSummary: "Running deferred maintenance.",
      eventSummary: "Starting deferred maintenance.",
    });
    longRunningTimer = setTimeout(() => {
      try {
        makeTaskVisible("state_changes");
        surfacedUserNotice = true;
        const summary = "Deferred maintenance is still running.";
        recordTaskRunProgressByRunId({
          ...taskRun,
          lastEventAt: Date.now(),
          progressSummary: summary,
          eventSummary: summary,
        });
      } catch (error) {
        log.warn(`failed to surface deferred maintenance progress: ${String(error)}`);
      }
    }, TURN_MAINTENANCE_LONG_WAIT_MS);

    const result = await executeContextEngineMaintenance({
      ...params,
      abortSignal,
      executionMode: "background",
    });
    const endedAt = Date.now();
    completeTaskRunByRunId({
      ...taskRun,
      endedAt,
      lastEventAt: endedAt,
      progressSummary: result?.changed
        ? "Deferred maintenance completed with transcript changes."
        : "Deferred maintenance completed.",
      terminalSummary: result?.changed
        ? `Rewrote ${result.rewrittenEntries} transcript entr${result.rewrittenEntries === 1 ? "y" : "ies"} and freed ${result.bytesFreed} bytes.`
        : "No transcript changes were needed.",
    });
  } catch (err) {
    if (abortSignal.aborted) {
      const task = findTaskByRunIdForOwner({
        runId: params.runId,
        callerOwnerKey: params.sessionKey,
        callerAgentId: params.agentId,
        config: params.config,
      });
      if (task && (task.status === "queued" || task.status === "running")) {
        cancelTaskByIdForOwner({
          taskId: task.taskId,
          callerOwnerKey: params.sessionKey,
          callerAgentId: params.agentId,
          config: params.config,
          endedAt: Date.now(),
          terminalSummary: "Deferred maintenance cancelled during shutdown.",
        });
      }
      return;
    }
    const endedAt = Date.now();
    const reason = formatErrorMessage(err);
    if (!surfacedUserNotice) {
      makeTaskVisible("done_only");
    }
    failTaskRunByRunId({
      ...taskRun,
      endedAt,
      lastEventAt: endedAt,
      error: reason,
      progressSummary: "Deferred maintenance failed.",
      terminalSummary: reason,
    });
    log.warn(`deferred context engine maintenance failed: ${reason}`);
  } finally {
    if (longRunningTimer) {
      clearTimeout(longRunningTimer);
    }
    shutdownAbort.dispose();
    if (params.disposeContextEngineAfterMaintenance) {
      await disposeDeferredMaintenanceContextEngine(params.contextEngine);
    }
  }
}

function scheduleDeferredTurnMaintenance(
  params: DeferredTurnMaintenanceScheduleParams,
): Promise<void> | undefined {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  if (isGatewayDraining()) {
    params.onScheduleFailure?.(new GatewayDrainingError());
    return undefined;
  }

  const activeRun = activeDeferredTurnMaintenanceRuns.get(sessionKey);
  if (activeRun) {
    const supersededParams = activeRun.rerunRequested ? activeRun.latestParams : undefined;
    activeRun.rerunRequested = true;
    activeRun.latestParams = { ...params, sessionKey };
    activeRun.deferredEngineDisposals.delete(params.contextEngine);
    if (
      supersededParams?.disposeContextEngineAfterMaintenance &&
      supersededParams.contextEngine !== params.contextEngine
    ) {
      const activeEngineWillBeDisposed =
        supersededParams.contextEngine === activeRun.activeParams.contextEngine &&
        activeRun.activeParams.disposeContextEngineAfterMaintenance;
      if (!activeEngineWillBeDisposed) {
        activeRun.deferredEngineDisposals.add(supersededParams.contextEngine);
      }
    }
    return activeRun.promise;
  }

  const existingTask = findActiveSessionTask({
    sessionKey,
    runtime: "acp",
    taskKind: CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND,
  });
  if (
    existingTask &&
    isContextEngineTurnMaintenanceRunActive({
      runId: existingTask.runId,
      sessionKey,
    })
  ) {
    log.warn("[context-engine] deferred turn maintenance is active without scheduler state", {
      taskId: existingTask.taskId,
      runId: existingTask.runId,
      sessionKey,
    });
    return undefined;
  }
  if (existingTask) {
    updateTaskNotifyPolicyForOwner({
      taskId: existingTask.taskId,
      callerOwnerKey: sessionKey,
      callerAgentId: params.agentId,
      config: params.config,
      notifyPolicy: "silent",
    });
    cancelTaskByIdForOwner({
      taskId: existingTask.taskId,
      callerOwnerKey: sessionKey,
      callerAgentId: params.agentId,
      config: params.config,
      endedAt: Date.now(),
      terminalSummary: "Superseded after its maintenance owner stopped.",
    });
  }
  const runId = `turn-maint:${sessionKey}:${Date.now().toString(36)}:${randomUUID().slice(0, 8)}`;
  // Publish process-local ownership before the durable row. Although task
  // creation and registration are synchronous today, this ordering also makes
  // observer callbacks and future async persistence unable to see an ownerless
  // task that is about to run.
  const activeRunRegistration = registerContextEngineTurnMaintenanceRun({ runId, sessionKey });
  if (!activeRunRegistration) {
    log.warn("[context-engine] failed to register deferred turn maintenance owner", {
      runId,
      sessionKey,
    });
    return undefined;
  }
  let task: ReturnType<typeof buildTurnMaintenanceTaskDescriptor>;
  try {
    task = buildTurnMaintenanceTaskDescriptor({
      sessionKey,
      runId,
    });
  } catch (error) {
    activeRunRegistration.unregister();
    params.onScheduleFailure?.(error);
    log.warn("[context-engine] failed to create deferred turn maintenance task", {
      errorMessage: formatErrorMessage(error),
      runId,
      sessionKey,
    });
    return undefined;
  }
  if (!task) {
    activeRunRegistration.unregister();
    log.warn("[context-engine] failed to create deferred turn maintenance task", {
      sessionKey,
    });
    return undefined;
  }
  const lane = `${TURN_MAINTENANCE_LANE_PREFIX}${sessionKey}`;
  log.info(
    `[context-engine] deferred turn maintenance queued ` +
      `taskId=${task.taskId} sessionKey=${sessionKey} lane=${lane}`,
  );

  const cancelTaskIfActive = (terminalSummary: string) => {
    const currentTask = findTaskByRunIdForOwner({
      runId,
      callerOwnerKey: sessionKey,
    });
    if (
      currentTask?.taskId !== task.taskId ||
      (currentTask.status !== "queued" && currentTask.status !== "running")
    ) {
      return;
    }
    cancelTaskByIdForOwner({
      taskId: currentTask.taskId,
      callerOwnerKey: sessionKey,
      endedAt: Date.now(),
      terminalSummary,
    });
  };
  const cancelFailedTask = (error: unknown) => {
    const errorMessage = formatErrorMessage(error);
    log.warn(`failed to schedule deferred context engine maintenance: ${errorMessage}`);
    cancelTaskIfActive(`Deferred maintenance could not be scheduled: ${errorMessage}`);
  };
  const schedulerAbort = createDeferredTurnMaintenanceAbortSignal();
  let workerStarted = false;
  let runPromise: Promise<void>;
  try {
    runPromise = enqueueCommandInLane(lane, () => {
      workerStarted = true;
      return runDeferredTurnMaintenanceWorker({
        ...params,
        sessionKey,
        runId: task.runId!,
        schedulerAbortSignal: schedulerAbort.abortSignal,
      });
    });
  } catch (err) {
    activeRunRegistration.unregister();
    schedulerAbort.dispose();
    cancelFailedTask(err);
    return undefined;
  }
  const cleanupDeferredTurnMaintenance = async () => {
    const current = activeDeferredTurnMaintenanceRuns.get(sessionKey);
    const shutdownTriggered = schedulerAbort.abortSignal.aborted;
    const rerunParams = state.rerunRequested && !shutdownTriggered ? state.latestParams : undefined;
    const discardedRerunParams =
      state.rerunRequested && shutdownTriggered ? state.latestParams : undefined;
    if (!workerStarted && state.activeParams.disposeContextEngineAfterMaintenance) {
      state.deferredEngineDisposals.add(state.activeParams.contextEngine);
    }
    if (discardedRerunParams?.disposeContextEngineAfterMaintenance) {
      const activeEngineWasDisposedByWorker =
        workerStarted &&
        discardedRerunParams.contextEngine === state.activeParams.contextEngine &&
        state.activeParams.disposeContextEngineAfterMaintenance;
      if (!activeEngineWasDisposedByWorker) {
        state.deferredEngineDisposals.add(discardedRerunParams.contextEngine);
      }
    }
    if (rerunParams) {
      state.deferredEngineDisposals.delete(rerunParams.contextEngine);
    }
    await Promise.all(
      Array.from(state.deferredEngineDisposals, (contextEngine) =>
        disposeDeferredMaintenanceContextEngine(contextEngine),
      ),
    );
    schedulerAbort.dispose();
    if (current === state) {
      activeDeferredTurnMaintenanceRuns.delete(sessionKey);
    }
    activeRunRegistration.unregister();
    if (rerunParams) {
      await scheduleDeferredTurnMaintenance(rerunParams);
    }
  };
  const trackedPromise = runPromise
    .catch((err: unknown) => {
      if (!schedulerAbort.abortSignal.aborted) {
        params.onScheduleFailure?.(err);
        cancelFailedTask(err);
      }
    })
    .then(cleanupDeferredTurnMaintenance, async (error: unknown) => {
      await cleanupDeferredTurnMaintenance();
      throw error;
    });
  const state: DeferredTurnMaintenanceRunState = {
    abort: (reason) => {
      schedulerAbort.abort(reason);
      clearCommandLane(lane);
    },
    activeParams: { ...params, sessionKey },
    deferredEngineDisposals: new Set(),
    promise: trackedPromise,
    rerunRequested: false,
    latestParams: { ...params, sessionKey },
  };
  activeDeferredTurnMaintenanceRuns.set(sessionKey, state);
  activeRunRegistration.attachLifecycle({
    abort: state.abort,
    cancelActiveTask: () =>
      cancelTaskIfActive("Deferred maintenance cancelled during gateway restart."),
    settled: trackedPromise,
  });
  void trackedPromise;
  return trackedPromise;
}

/**
 * Run optional context-engine transcript maintenance and normalize the result.
 */
export async function runContextEngineMaintenance(
  params: ContextEngineMaintenanceParams,
): Promise<ContextEngineMaintenanceResult | undefined> {
  const contextEngine = params.contextEngine;
  if (typeof contextEngine?.maintain !== "function") {
    return undefined;
  }

  const executionMode = params.executionMode ?? "foreground";
  const shouldDefer =
    params.reason === "turn" &&
    executionMode !== "background" &&
    contextEngine.info.turnMaintenanceMode === "background";

  if (shouldDefer) {
    try {
      const sessionKey = normalizeOptionalString(params.sessionKey);
      if (!sessionKey) {
        params.onDeferredMaintenanceFailure?.(
          new Error("Deferred context-engine maintenance requires a session key"),
        );
        return undefined;
      }
      const deferred = scheduleDeferredTurnMaintenance({
        ...params,
        contextEngine,
        sessionKey,
        disposeContextEngineAfterMaintenance: params.disposeDeferredContextEngineAfterMaintenance,
        onScheduleFailure: params.onDeferredMaintenanceFailure,
      });
      if (deferred) {
        params.onDeferredMaintenance?.(deferred);
      }
    } catch (err) {
      log.warn(`failed to schedule deferred context engine maintenance: ${String(err)}`);
    }
    return undefined;
  }

  try {
    return await executeContextEngineMaintenance({ ...params, contextEngine, executionMode });
  } catch (err) {
    log.warn(`context engine maintain failed (${params.reason}): ${String(err)}`);
    return undefined;
  }
}
