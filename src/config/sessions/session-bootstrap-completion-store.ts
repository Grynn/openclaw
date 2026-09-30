import type { AgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";

/** Appends the bootstrap marker through the canonical agent database worker owner. */
export async function appendSessionBootstrapCompletionInWorker(params: {
  runId: string;
  customType: string;
  sessionTarget: AgentRunSessionTarget;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget;
  if (!agentId || !sessionId || !sessionKey || !storePath) {
    return false;
  }
  params.assertCurrent?.();
  const resolved = resolveSqliteTranscriptScope({ agentId, sessionId, sessionKey, storePath });
  const options = toDatabaseOptions(resolved);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const assertCurrent = () => {
    execution.assertCurrent();
    params.assertCurrent?.();
  };
  try {
    return (
      (await runOpenClawAgentWorkerWrite(options, () =>
        execution.runExisting(
          {
            assertCurrent,
            createAdmission(binding) {
              return () => ({
                nativeLocations: binding.nativeLocations,
                admission: createSqliteWorkerOperationAdmission((request, grant) => {
                  binding.authorize(request);
                  assertCurrent();
                  if (!grant()) {
                    throw new Error("Bootstrap completion writer authority expired");
                  }
                }, binding.attachment),
              });
            },
          },
          (worker) =>
            worker.execute({
              type: "session.transcript.bootstrapComplete",
              input: {
                sessionId,
                sessionKey,
                runId: params.runId,
                customType: params.customType,
                ...(params.sessionTarget.expectedLifecycleRevision
                  ? { expectedLifecycleRevision: params.sessionTarget.expectedLifecycleRevision }
                  : {}),
                ...(params.sessionTarget.expectedWriterRunId
                  ? { expectedWriterRunId: params.sessionTarget.expectedWriterRunId }
                  : {}),
              },
            }),
        ),
      )) === true
    );
  } finally {
    await execution.release();
  }
}
