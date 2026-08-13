// Runtime control seam for cancelling runtime-owned work from task APIs.
export { getAcpSessionManager } from "../acp/control-plane/manager.js";
export { cancelBackgroundExecSession } from "../agents/bash-process-control.js";
export { isContextEngineTurnMaintenanceRunActive } from "../agents/embedded-agent-runner/context-engine-maintenance-control.js";
export { killSubagentRunAdmin } from "../agents/subagents/registry/subagent-control.js";
export { cancelActiveCronTaskRun } from "../cron/service/active-run-cancellation.js";
