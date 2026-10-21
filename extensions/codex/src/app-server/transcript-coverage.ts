import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isCodexDurableCustomMessage } from "./context-engine-projection.js";
import type { CodexTranscriptCoverage } from "./session-binding-record.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import {
  fingerprintCodexMirrorSourceMessage,
  readCodexMirrorSourceFingerprint,
} from "./transcript-mirror-attestation.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

const CODEX_MIRROR_IDEMPOTENCY_PREFIX = "codex-app-server:";
const CODEX_APP_SERVER_MIRROR_ORIGIN = "codex-app-server";

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
    metadata?.mirrorOrigin !== CODEX_APP_SERVER_MIRROR_ORIGIN ||
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

/** Completed-turn coverage patch from the attempt's admission receipts and startup binding. */
export function codexAttemptCoveragePatch(attempt: {
  resources: {
    prompt: { context: { transcriptReadFence?: TranscriptTurnAdmission | undefined } };
    state: { thread: { threadId: string } };
  };
  connection: {
    params: {
      runId: string;
      userTurnTranscriptRecorder?:
        | {
            getAdmissionReceipt(): TranscriptTurnAdmission | undefined;
            getPersistedMessage?(): AgentMessage | undefined;
          }
        | undefined;
    };
    mutable: { startupBinding?: CodexAppServerThreadBinding | undefined };
  };
  activeTurnId: string;
}): ReturnType<typeof buildCodexCompletedCoveragePatch> {
  const { params, mutable } = attempt.connection;
  const recorder = params.userTurnTranscriptRecorder;
  const threadId = attempt.resources.state.thread.threadId;
  const coverage = buildCodexTranscriptCoverage({
    admissionBeforeAnnotation: attempt.resources.prompt.context.transcriptReadFence,
    admissionAfterAnnotation: recorder?.getAdmissionReceipt(),
    persistedMessage: recorder?.getPersistedMessage?.(),
    threadId,
    turnId: attempt.activeTurnId,
    runId: params.runId,
  });
  return buildCodexCompletedCoveragePatch({
    hasRecorder: recorder !== undefined,
    coverage,
    startupBinding: mutable.startupBinding,
    threadId,
    completedAt: new Date().toISOString(),
  });
}

function isProjectableHostMessage(message: AgentMessage): boolean {
  return (
    message.role === "user" || message.role === "assistant" || isCodexDurableCustomMessage(message)
  );
}

function isNativeMirror(message: AgentMessage, threadId: string): boolean {
  // Origin alone does not imply coverage: temporary threads and host-admitted
  // user rows belong in the unseen delta. Only this native thread's mirrors are.
  const nativeThreadPrefix = `${CODEX_MIRROR_IDEMPOTENCY_PREFIX}${threadId}:`;
  return (
    readMessageIdempotencyKey(message)?.startsWith(nativeThreadPrefix) === true ||
    readMirrorIdentity(message)?.startsWith(nativeThreadPrefix) === true
  );
}

function projectHostMessages(
  messages: readonly AgentMessage[],
  threadId: string,
  confirmedSteerRunId?: string,
): AgentMessage[] {
  return messages.filter((message) => {
    if (!isProjectableHostMessage(message) || isNativeMirror(message, threadId)) {
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
    metadata?.mirrorOrigin === CODEX_APP_SERVER_MIRROR_ORIGIN &&
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
          messages: projectHostMessages(
            params.messages.slice(anchors[0]! + 1),
            params.binding.threadId,
            coverage.runId,
          ),
        };
      }
    }
    // A missing, duplicate, edited, or cross-thread anchor must replay rather
    // than claim that any host row has already reached the native thread.
    return {
      mode: "conservative",
      messages: projectHostMessages(params.messages, params.binding.threadId),
    };
  }

  const cutoff = Date.parse(params.binding.historyCoveredThrough ?? "");
  return {
    mode: "legacy",
    messages: projectHostMessages(params.messages, params.binding.threadId).filter((message) => {
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
