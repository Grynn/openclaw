import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  readCodexSessionTranscriptMessagesBetweenAdmissions,
  type CodexSessionTranscriptAdmissionDeltaResult,
} from "openclaw/plugin-sdk/codex-session-transcript-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { z } from "zod";

const CODEX_META_KEY = "__openclaw";

const transcriptTurnAdmissionSchema = z
  .object({
    agentId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    sessionKey: z.string().trim().min(1),
    storePath: z.string().trim().min(1),
    generation: z.string().trim().min(1),
    entryId: z.string().trim().min(1),
    rawSeq: z.number().int().nonnegative(),
    effectiveParentId: z.string().nullable(),
    activeMessagePosition: z.number().int().nonnegative(),
    idempotencyKey: z.string().optional(),
    logicalTurnId: z.string().trim().min(1),
    role: z.literal("user"),
  })
  .strict();

/** Exact OpenClaw transcript inputs already admitted to one native Codex thread. */
export const codexTranscriptCoverageSchema = z
  .object({
    schemaVersion: z.literal(1),
    turnStartAdmission: transcriptTurnAdmissionSchema,
    // Confirmed steering rewrites stamp this run id on every user row Codex
    // consumed after turn/start. Unstamped concurrent arrivals remain pending.
    steerTargetRunId: z.string().trim().min(1),
  })
  .strict();

export type CodexTranscriptCoverage = z.infer<typeof codexTranscriptCoverageSchema>;

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
      (message.role === "user" || message.role === "assistant") &&
      !isCodexMirrorMessage(message) &&
      !(coverage && isConfirmedSteerCoveredByRun(message, coverage)),
  );
}

/** Selects only transcript rows not already admitted to the resumed native thread. */
export async function selectCodexHistoryAfterExactCoverage(params: {
  coverage: CodexTranscriptCoverage;
  currentAdmission: TranscriptTurnAdmission;
}): Promise<ExactCoverageSelectionResult> {
  const delta = readCodexSessionTranscriptMessagesBetweenAdmissions(
    params.coverage.turnStartAdmission,
    params.currentAdmission,
  );
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
