import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  refreshCodexSessionTranscriptAdmission,
  type CodexSessionTranscriptAdmissionDeltaResult,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isCodexDurableCustomMessage } from "./context-engine-projection.js";
import type { CodexTranscriptCoverage } from "./session-binding-record.js";

const CODEX_META_KEY = "__openclaw";

type ExactCoverageSelectionResult =
  | { kind: "ok"; messages: AgentMessage[] }
  | Exclude<CodexSessionTranscriptAdmissionDeltaResult, { kind: "ok" }>;

function readOpenClawMetadata(message: AgentMessage): Record<string, unknown> | undefined {
  const meta = CODEX_META_KEY in message ? message[CODEX_META_KEY] : undefined;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : undefined;
}

function isCodexMirrorMessage(message: AgentMessage): boolean {
  const meta = readOpenClawMetadata(message);
  const mirrorIdentity = meta?.mirrorIdentity;
  const mirrorOrigin = meta?.mirrorOrigin;
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
  return (
    message.role === "user" &&
    readOpenClawMetadata(message)?.steerTargetRunId === coverage.steerTargetRunId
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
  const { readCodexHistoryAdmissionDeltaInWorker } =
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
    const refreshedCovered = await refreshCodexSessionTranscriptAdmission(
      params.coverage.turnStartAdmission,
    );
    const refreshedCurrent = await refreshCodexSessionTranscriptAdmission(params.currentAdmission);
    if (refreshedCovered && refreshedCurrent) {
      delta = await readDelta(refreshedCovered, refreshedCurrent);
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
