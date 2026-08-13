import "./context-engine-maintenance-control.js";

type ContextEngineTurnMaintenanceControlTestApi = {
  resetContextEngineTurnMaintenanceRunsForTests(): void;
};

function getTestApi(): ContextEngineTurnMaintenanceControlTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.contextEngineTurnMaintenanceControlTestApi")
  ] as ContextEngineTurnMaintenanceControlTestApi;
}

export function resetContextEngineTurnMaintenanceRunsForTests(): void {
  getTestApi().resetContextEngineTurnMaintenanceRunsForTests();
}
