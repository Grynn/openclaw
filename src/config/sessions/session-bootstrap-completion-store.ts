import type { AgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Reads the latest control through the existing read-only history worker. */
export async function readSessionBootstrapCompletionInWorker(params: {
  customType: string;
  sessionTarget: AgentRunSessionTarget;
}): Promise<boolean> {
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget;
  if (!agentId || !sessionId || !sessionKey || !storePath) {
    return false;
  }
  const env = captureSessionTranscriptStorageEnvironment(process.env);
  const state = captureOpenClawStateWorkerContext({ env });
  const assertCurrent = () => {
    state.maintenanceScope?.assertAdmission();
    state.admission.assertCurrent();
  };
  const target = await prepareSqliteTranscriptReadScope({
    agentId,
    sessionId,
    sessionKey,
    storePath,
    env,
  });
  assertCurrent();
  const options = toDatabaseOptions(target);
  target.path = resolveOpenClawAgentSqlitePath(options);
  return await withSessionHistoryWorkerDatabase(options, async (owner) => {
    assertCurrent();
    owner.assertCurrent();
    const result = await owner.readBootstrapControl({ target, customType: params.customType });
    assertCurrent();
    owner.assertCurrent();
    return result === "custom";
  });
}

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
