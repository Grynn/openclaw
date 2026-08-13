import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortDeferredTurnMaintenanceForLifecycleRestart,
  isContextEngineTurnMaintenanceRunActive,
  registerContextEngineTurnMaintenanceRun,
} from "./context-engine-maintenance-control.js";
import { resetContextEngineTurnMaintenanceRunsForTests } from "./context-engine-maintenance-control.test-support.js";

describe("context-engine maintenance control", () => {
  afterEach(() => {
    resetContextEngineTurnMaintenanceRunsForTests();
  });

  it("tracks and unregisters only the exact run and session owner", () => {
    const unregister = registerContextEngineTurnMaintenanceRun({
      runId: "turn-maint:run-1",
      sessionKey: "agent:main:session-1",
    });

    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:run-1",
        sessionKey: "agent:main:session-1",
      }),
    ).toBe(true);
    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:run-2",
        sessionKey: "agent:main:session-1",
      }),
    ).toBe(false);
    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:run-1",
        sessionKey: "agent:main:session-2",
      }),
    ).toBe(false);
    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:run-1",
        sessionKey: undefined,
      }),
    ).toBe(false);

    unregister?.unregister();
    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:run-1",
        sessionKey: "agent:main:session-1",
      }),
    ).toBe(false);
  });

  it("does not let an older unregister callback clear a replacement registration", () => {
    const unregisterFirst = registerContextEngineTurnMaintenanceRun({
      runId: "turn-maint:replacement",
      sessionKey: "agent:main:session-1",
    });
    const unregisterReplacement = registerContextEngineTurnMaintenanceRun({
      runId: "turn-maint:replacement",
      sessionKey: "agent:main:session-1",
    });

    unregisterFirst?.unregister();
    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:replacement",
        sessionKey: "agent:main:session-1",
      }),
    ).toBe(true);

    unregisterReplacement?.unregister();
    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:replacement",
        sessionKey: "agent:main:session-1",
      }),
    ).toBe(false);
  });

  it("waits for registered lifecycle settlement before retiring the restart barrier", async () => {
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const abort = vi.fn();
    const cancelActiveTask = vi.fn();
    const registration = registerContextEngineTurnMaintenanceRun({
      runId: "turn-maint:drain",
      sessionKey: "agent:main:session-drain",
    });
    registration?.attachLifecycle({ abort, cancelActiveTask, settled });

    let restartSettled = false;
    const restart = abortDeferredTurnMaintenanceForLifecycleRestart().then(() => {
      restartSettled = true;
    });
    await Promise.resolve();

    expect(abort).toHaveBeenCalledOnce();
    expect(cancelActiveTask).toHaveBeenCalledOnce();
    expect(restartSettled).toBe(false);

    release();
    await expect(restart).resolves.toBeUndefined();
    expect(restartSettled).toBe(true);
    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:drain",
        sessionKey: "agent:main:session-drain",
      }),
    ).toBe(false);
  });

  it("keeps timed-out ownership registered so lane reset cannot admit a replacement", async () => {
    const registration = registerContextEngineTurnMaintenanceRun({
      runId: "turn-maint:hung",
      sessionKey: "agent:main:session-hung",
    });
    registration?.attachLifecycle({
      abort: () => {},
      cancelActiveTask: () => {},
      settled: new Promise<void>(() => {}),
    });

    await expect(abortDeferredTurnMaintenanceForLifecycleRestart(0)).resolves.toEqual({
      active: 1,
      drained: false,
    });
    expect(
      isContextEngineTurnMaintenanceRunActive({
        runId: "turn-maint:hung",
        sessionKey: "agent:main:session-hung",
      }),
    ).toBe(true);
  });
});
