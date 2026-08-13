// Shared identity for deferred context-engine turn-maintenance task rows.
export const CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND = "context_engine_turn_maintenance";

export function isContextEngineTurnMaintenanceTask(task: {
  runtime: string;
  taskKind?: string;
  sourceId?: string;
}): boolean {
  return (
    task.runtime === "acp" &&
    task.taskKind === CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND &&
    task.sourceId === CONTEXT_ENGINE_TURN_MAINTENANCE_TASK_KIND
  );
}
