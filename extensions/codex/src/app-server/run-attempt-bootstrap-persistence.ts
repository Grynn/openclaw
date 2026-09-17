import { persistCompletedBootstrapTurn } from "openclaw/plugin-sdk/agent-bootstrap-runtime";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";

/** Records continuation state only after a clean turn has reached durable transcript storage. */
export async function persistCodexCompletedBootstrapTurnAfterMirror(params: {
  attemptSucceeded: boolean;
  compactionCount?: number;
  mirroredMessageCount: number;
  runId: string;
  sessionTarget?: Parameters<typeof persistCompletedBootstrapTurn>[0]["sessionTarget"];
  shouldRecordCompletedBootstrapTurn: boolean;
}): Promise<boolean> {
  if (
    !params.shouldRecordCompletedBootstrapTurn ||
    !params.attemptSucceeded ||
    (params.compactionCount ?? 0) !== 0 ||
    params.mirroredMessageCount <= 0
  ) {
    return false;
  }
  try {
    return await persistCompletedBootstrapTurn({
      runId: params.runId,
      ...(params.sessionTarget ? { sessionTarget: params.sessionTarget } : {}),
    });
  } catch (error) {
    embeddedAgentLog.warn("failed to persist codex completed bootstrap marker", {
      error,
      runId: params.runId,
    });
    return false;
  }
}
