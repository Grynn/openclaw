import {
  readCodexSessionTranscriptMessagesBetweenAdmissions,
  refreshCodexSessionTranscriptAdmission,
  validateCodexSessionTranscriptReadAdmission,
  type CodexSessionTranscriptAdmissionDeltaResult,
  type SessionTranscriptContextVersion,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import type { CodexHistoryReadResult } from "./src/app-server/history-rejection.js";
import type { JsonValue } from "./src/app-server/protocol.js";
import {
  readCodexNativeHistory,
  type ResolvedCodexHistoryTarget,
} from "./src/app-server/session-history-read.js";
import {
  projectVerifiedSettledCodexMessages,
  type SettledTurnMessages,
} from "./src/app-server/settled-turn-evidence.js";

type CodexSettledHistoryWorkerInput = {
  kind: "settled";
  target: ResolvedCodexHistoryTarget;
  sessionId: string;
  admission?: TranscriptTurnAdmission;
  evidence: SettledTurnMessages;
};
export type CodexHistoryWorkerInput =
  | CodexSettledHistoryWorkerInput
  | { kind: "admission-delta"; covered: TranscriptTurnAdmission; current: TranscriptTurnAdmission }
  | { kind: "admission-refresh"; admission: TranscriptTurnAdmission };
export type CodexHistoryWorkerResult =
  | {
      kind: "settled";
      result: CodexHistoryReadResult<JsonValue[]>;
      version?: SessionTranscriptContextVersion;
    }
  | { kind: "admission-delta"; delta: CodexSessionTranscriptAdmissionDeltaResult }
  | { kind: "admission-refresh"; admission?: TranscriptTurnAdmission };

export async function runCodexHistoryWorkerInput(
  input: unknown,
): Promise<CodexHistoryWorkerResult> {
  // SAFETY: The paired runtime constructs this request; the SQLite snapshot validates admission.
  const request = input as CodexHistoryWorkerInput;
  if (request.kind === "admission-refresh") {
    return {
      kind: "admission-refresh",
      admission: await refreshCodexSessionTranscriptAdmission(request.admission),
    };
  }
  if (request.kind === "admission-delta") {
    const delta = await readCodexSessionTranscriptMessagesBetweenAdmissions(
      request.covered,
      request.current,
    );
    if (delta.kind === "ok") {
      try {
        validateCodexSessionTranscriptReadAdmission(request.current, request.current);
        validateCodexSessionTranscriptReadAdmission(request.covered, request.covered);
      } catch {
        return { kind: "admission-delta", delta: { kind: "stale" } };
      }
    }
    return {
      kind: "admission-delta",
      delta,
    };
  }
  let version: SessionTranscriptContextVersion | undefined;
  const onSnapshot = (value: SessionTranscriptContextVersion | undefined) => {
    version = value;
  };
  const result = await readCodexNativeHistory(
    request.target,
    request.sessionId,
    (messages) => projectVerifiedSettledCodexMessages(messages, request.evidence),
    request.admission,
    onSnapshot,
  );
  return { kind: "settled", result, version };
}

serveWorkerTasks(runCodexHistoryWorkerInput);
