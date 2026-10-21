import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isCodexDurableCustomMessage } from "./context-engine-projection.js";
import type { CodexAppServerThreadBinding, CodexTranscriptCoverage } from "./session-binding.js";
import {
  fingerprintCodexMirrorSourceMessage,
  hasCodexMirrorOrigin,
  readCodexMirrorSourceFingerprint,
} from "./transcript-mirror-attestation.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

const CODEX_MIRROR_IDEMPOTENCY_PREFIX = "codex-app-server:";

function readMessageIdempotencyKey(message: AgentMessage): string | undefined {
  if (!("idempotencyKey" in message)) {
    return undefined;
  }
  const value = message.idempotencyKey;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readMessageMetadata(message: AgentMessage): Record<string, unknown> | undefined {
  return asOptionalRecord(Reflect.get(message, "__openclaw"));
}

function hasStableAdmissionOwner(
  before: TranscriptTurnAdmission,
  after: TranscriptTurnAdmission,
): boolean {
  return (
    before.agentId === after.agentId &&
    before.sessionId === after.sessionId &&
    before.sessionKey === after.sessionKey &&
    before.storePath === after.storePath &&
    before.entryId === after.entryId &&
    before.rawSeq === after.rawSeq &&
    before.effectiveParentId === after.effectiveParentId &&
    before.activeMessagePosition === after.activeMessagePosition &&
    before.idempotencyKey === after.idempotencyKey &&
    before.logicalTurnId === after.logicalTurnId &&
    before.role === after.role
  );
}

export function fingerprintCodexTranscriptCoverageMessage(
  message: Extract<AgentMessage, { role: "user" }>,
): string {
  return sha256Hex(JSON.stringify({ role: message.role, content: message.content }));
}

/**
 * Attests the exact persisted host prompt accepted by a completed native turn.
 * Annotation may rotate the transcript generation, but it must retain the same
 * admitted row and producer-owned correlation facts.
 */
export function buildCodexTranscriptCoverage(params: {
  admissionBeforeAnnotation: TranscriptTurnAdmission | undefined;
  admissionAfterAnnotation: TranscriptTurnAdmission | undefined;
  persistedMessage: AgentMessage | undefined;
  threadId: string;
  turnId: string;
  runId: string;
}): CodexTranscriptCoverage | undefined {
  const before = params.admissionBeforeAnnotation;
  const after = params.admissionAfterAnnotation;
  const message = params.persistedMessage;
  if (!before || !after || !message || message.role !== "user") {
    return undefined;
  }
  if (!hasStableAdmissionOwner(before, after)) {
    return undefined;
  }
  const idempotencyKey = readMessageIdempotencyKey(message);
  if (!idempotencyKey || idempotencyKey !== after.idempotencyKey) {
    return undefined;
  }
  const metadata = readMessageMetadata(message);
  const mirrorIdentity = readMirrorIdentity(message);
  const mirrorSourceFingerprint = readCodexMirrorSourceFingerprint(message);
  if (
    metadata?.runId !== params.runId ||
    metadata?.mirrorOrigin !== "codex-app-server" ||
    mirrorIdentity !== `${params.turnId}:prompt` ||
    !mirrorSourceFingerprint ||
    !/^[a-f0-9]{32}$/u.test(mirrorSourceFingerprint) ||
    fingerprintCodexMirrorSourceMessage(message) !== mirrorSourceFingerprint
  ) {
    return undefined;
  }
  return {
    schemaVersion: 2,
    threadId: params.threadId,
    runId: params.runId,
    idempotencyKey,
    mirrorIdentity,
    mirrorSourceFingerprint,
    messageFingerprint: fingerprintCodexTranscriptCoverageMessage(message),
  };
}

export function buildCodexCompletedCoveragePatch(params: {
  hasRecorder: boolean;
  coverage: CodexTranscriptCoverage | undefined;
  startupBinding: CodexAppServerThreadBinding | undefined;
  threadId: string;
  completedAt: string;
}): Partial<Pick<CodexAppServerThreadBinding, "historyCoveredThrough" | "transcriptCoverage">> {
  if (!params.hasRecorder) {
    // Recorder-free maintenance still needs post-anchor host context, but it
    // cannot mint a new exact receipt. Advancing a completion clock could omit
    // rows that arrived after its read, so prefer bounded duplicate replay until
    // the next admitted prompt advances the same-thread exact anchor.
    return params.startupBinding?.threadId === params.threadId &&
      params.startupBinding.transcriptCoverage
      ? {}
      : { historyCoveredThrough: params.completedAt, transcriptCoverage: undefined };
  }
  if (params.coverage) {
    return { historyCoveredThrough: undefined, transcriptCoverage: params.coverage };
  }
  if (params.startupBinding?.threadId === params.threadId) {
    // The prompt was accepted but its annotation could not be attested. Keep an
    // older same-thread exact anchor and replay forward from it conservatively.
    return { historyCoveredThrough: undefined };
  }
  return { historyCoveredThrough: undefined, transcriptCoverage: undefined };
}

function isProjectableHostMessage(message: AgentMessage): boolean {
  return (
    message.role === "user" || message.role === "assistant" || isCodexDurableCustomMessage(message)
  );
}

function isNativeMirror(message: AgentMessage): boolean {
  const idempotencyKey = readMessageIdempotencyKey(message);
  return (
    idempotencyKey?.startsWith(CODEX_MIRROR_IDEMPOTENCY_PREFIX) === true ||
    hasCodexMirrorOrigin(message) ||
    readMirrorIdentity(message)?.startsWith(CODEX_MIRROR_IDEMPOTENCY_PREFIX) === true
  );
}

function projectHostMessages(
  messages: readonly AgentMessage[],
  confirmedSteerRunId?: string,
): AgentMessage[] {
  return messages.filter((message) => {
    if (!isProjectableHostMessage(message) || isNativeMirror(message)) {
      return false;
    }
    return !(
      confirmedSteerRunId &&
      message.role === "user" &&
      readMessageMetadata(message)?.steerTargetRunId === confirmedSteerRunId
    );
  });
}

function matchesCoverageAnchor(message: AgentMessage, coverage: CodexTranscriptCoverage): boolean {
  const metadata = readMessageMetadata(message);
  return (
    message.role === "user" &&
    readMessageIdempotencyKey(message) === coverage.idempotencyKey &&
    metadata?.runId === coverage.runId &&
    hasCodexMirrorOrigin(message) &&
    readMirrorIdentity(message) === coverage.mirrorIdentity &&
    readCodexMirrorSourceFingerprint(message) === coverage.mirrorSourceFingerprint &&
    fingerprintCodexTranscriptCoverageMessage(message) === coverage.messageFingerprint
  );
}

export type CodexTranscriptCoverageSelection = {
  mode: "exact" | "legacy" | "conservative";
  messages: AgentMessage[];
};

/** Selects only host rows not already represented on a resumed native thread. */
export function selectCodexUncoveredTranscriptMessages(params: {
  messages: readonly AgentMessage[];
  binding: CodexAppServerThreadBinding;
}): CodexTranscriptCoverageSelection {
  const coverage = params.binding.transcriptCoverage;
  if (coverage) {
    if (coverage.threadId === params.binding.threadId) {
      const anchors = params.messages.flatMap((message, index) =>
        matchesCoverageAnchor(message, coverage) ? [index] : [],
      );
      if (anchors.length === 1) {
        return {
          mode: "exact",
          messages: projectHostMessages(params.messages.slice(anchors[0]! + 1), coverage.runId),
        };
      }
    }
    // A missing, duplicate, edited, or cross-thread anchor must replay rather
    // than claim that any host row has already reached the native thread.
    return { mode: "conservative", messages: projectHostMessages(params.messages) };
  }

  const cutoff = Date.parse(params.binding.historyCoveredThrough ?? "");
  return {
    mode: "legacy",
    messages: projectHostMessages(params.messages).filter((message) => {
      const timestamp =
        typeof message.timestamp === "number"
          ? message.timestamp
          : typeof message.timestamp === "string"
            ? Date.parse(message.timestamp)
            : Number.NaN;
      return Number.isFinite(timestamp) && timestamp > (Number.isFinite(cutoff) ? cutoff : 0);
    }),
  };
}
