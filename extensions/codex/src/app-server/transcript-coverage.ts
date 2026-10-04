import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexSessionTranscriptAdmissionDeltaResult } from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isCodexDurableCustomMessage } from "./context-engine-projection.js";
import type {
  CodexAppServerThreadBinding,
  CodexTranscriptCoverage,
} from "./session-binding-record.js";

const CODEX_META_KEY = "__openclaw";

/** Advance exact coverage only from the admitted input, never from completion time. */
export async function buildCompletedCodexTranscriptCoveragePatch(params: {
  turnStartAdmission?: TranscriptTurnAdmission;
  latestAdmission?: TranscriptTurnAdmission;
  previousExactCoverage?: CodexTranscriptCoverage;
  runId: string;
  signal?: AbortSignal;
}): Promise<Pick<CodexAppServerThreadBinding, "transcriptCoverage" | "historyCoveredThrough">> {
  const { turnStartAdmission, latestAdmission } = params;
  if (!turnStartAdmission) {
    // A maintenance turn without a recorder cannot certify later user arrivals.
    // Keep the last exact receipt; timestamp compatibility is only for legacy hosts.
    return params.previousExactCoverage
      ? {}
      : { transcriptCoverage: undefined, historyCoveredThrough: new Date().toISOString() };
  }
  if (
    !latestAdmission ||
    latestAdmission.agentId !== turnStartAdmission.agentId ||
    latestAdmission.sessionId !== turnStartAdmission.sessionId ||
    latestAdmission.sessionKey !== turnStartAdmission.sessionKey ||
    latestAdmission.storePath !== turnStartAdmission.storePath ||
    latestAdmission.entryId !== turnStartAdmission.entryId ||
    latestAdmission.rawSeq !== turnStartAdmission.rawSeq ||
    latestAdmission.effectiveParentId !== turnStartAdmission.effectiveParentId ||
    latestAdmission.activeMessagePosition !== turnStartAdmission.activeMessagePosition ||
    latestAdmission.idempotencyKey !== turnStartAdmission.idempotencyKey ||
    latestAdmission.logicalTurnId !== turnStartAdmission.logicalTurnId ||
    latestAdmission.role !== turnStartAdmission.role
  ) {
    throw new Error("Codex turn-start transcript admission changed ownership before coverage");
  }
  const { refreshCodexHistoryAdmissionInWorker } =
    await import("../../session-history-worker-runtime.js");
  const refreshed = await refreshCodexHistoryAdmissionInWorker(latestAdmission, params.signal);
  if (!refreshed) {
    throw new Error(
      `Codex turn-start transcript admission is no longer active: ${latestAdmission.entryId}`,
    );
  }
  return {
    transcriptCoverage: {
      schemaVersion: 1,
      turnStartAdmission: refreshed,
      steerTargetRunId: params.runId,
    },
    historyCoveredThrough: undefined,
  };
}

type ExactCoverageSelectionResult =
  | { kind: "ok"; messages: AgentMessage[] }
  | Exclude<CodexSessionTranscriptAdmissionDeltaResult, { kind: "ok" }>;

function readOpenClawMetadata(message: AgentMessage): object | undefined {
  const meta = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  return meta;
}

function isCodexMirrorMessage(message: AgentMessage): boolean {
  const meta = readOpenClawMetadata(message);
  const mirrorIdentity = meta && "mirrorIdentity" in meta ? meta.mirrorIdentity : undefined;
  const mirrorOrigin = meta && "mirrorOrigin" in meta ? meta.mirrorOrigin : undefined;
  return (
    ("idempotencyKey" in message &&
      typeof message.idempotencyKey === "string" &&
      message.idempotencyKey.startsWith("codex-app-server:")) ||
    mirrorOrigin === "codex-app-server" ||
    (typeof mirrorIdentity === "string" && mirrorIdentity.startsWith("codex-app-server:"))
  );
}

function isConfirmedSteerCoveredByRun(
  message: AgentMessage,
  coverage: CodexTranscriptCoverage,
): boolean {
  const meta = readOpenClawMetadata(message);
  return (
    message.role === "user" &&
    meta !== undefined &&
    "steerTargetRunId" in meta &&
    meta.steerTargetRunId === coverage.steerTargetRunId
  );
}

function selectProjectableMessages(
  messages: readonly AgentMessage[],
  coverage?: CodexTranscriptCoverage,
): AgentMessage[] {
  return messages.filter(
    (message) =>
      // Durable notes are part of resume continuity even though they carry no role.
      (message.role === "user" ||
        message.role === "assistant" ||
        isCodexDurableCustomMessage(message)) &&
      !isCodexMirrorMessage(message) &&
      !(coverage && isConfirmedSteerCoveredByRun(message, coverage)),
  );
}

/** Selects only transcript rows not already admitted to the resumed native thread. */
export async function selectCodexHistoryAfterExactCoverage(params: {
  coverage: CodexTranscriptCoverage;
  currentAdmission: TranscriptTurnAdmission;
  signal?: AbortSignal;
}): Promise<ExactCoverageSelectionResult> {
  const { readCodexHistoryAdmissionDeltaInWorker, refreshCodexHistoryAdmissionInWorker } =
    await import("../../session-history-worker-runtime.js");
  const readDelta = async (covered: TranscriptTurnAdmission, current: TranscriptTurnAdmission) => {
    try {
      return await readCodexHistoryAdmissionDeltaInWorker(covered, current, params.signal);
    } catch {
      params.signal?.throwIfAborted();
      return { kind: "projection-unavailable" } as const;
    }
  };
  let delta = await readDelta(params.coverage.turnStartAdmission, params.currentAdmission);
  if (delta.kind === "stale") {
    // Transcript rewrites change the projection generation even when both
    // admitted user rows remain unchanged. Re-anchor those rows only when the
    // refresh primitive also proves their exact persisted payloads; endpoint
    // edits, rebounds, and branch changes fail into the conservative replay.
    try {
      const refreshedCovered = await refreshCodexHistoryAdmissionInWorker(
        params.coverage.turnStartAdmission,
        params.signal,
      );
      const refreshedCurrent = await refreshCodexHistoryAdmissionInWorker(
        params.currentAdmission,
        params.signal,
      );
      if (refreshedCovered && refreshedCurrent) {
        delta = await readDelta(refreshedCovered, refreshedCurrent);
      }
    } catch {
      params.signal?.throwIfAborted();
      return { kind: "projection-unavailable" };
    }
  }
  if (delta.kind !== "ok") {
    return delta;
  }
  return {
    kind: "ok",
    messages: selectProjectableMessages(delta.messages, params.coverage),
  };
}

/** Legacy timestamp selection retained only for bindings without an exact admission anchor. */
export function selectCodexHistoryAfterLegacyTimestamp(
  messages: readonly AgentMessage[],
  historyCoveredThrough: string | undefined,
): AgentMessage[] {
  const cutoff = Date.parse(historyCoveredThrough ?? "");
  return selectProjectableMessages(messages).filter((message) => {
    const timestamp =
      typeof message.timestamp === "number"
        ? message.timestamp
        : typeof message.timestamp === "string"
          ? Date.parse(message.timestamp)
          : Number.NaN;
    return Number.isFinite(timestamp) && timestamp > (Number.isFinite(cutoff) ? cutoff : 0);
  });
}

/** Conservative fallback: replay visible non-mirror context rather than hide an arrival. */
export function selectCodexHistoryAfterInvalidExactCoverage(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  return selectProjectableMessages(messages);
}
