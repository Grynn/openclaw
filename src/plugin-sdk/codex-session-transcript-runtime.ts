import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import {
  readSessionTranscriptContextMessages,
  type SessionTranscriptContextVersion,
} from "../config/sessions/session-accessor.sqlite-model-context.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
  withSessionContextAdmission,
} from "../config/sessions/session-transcript-read-fence.js";
import type {
  TranscriptTurnAdmission,
  TranscriptEntryAnchor,
} from "../config/sessions/transcript-entry-anchor.js";
import type { AgentMessage } from "./agent-core.js";
import type {
  InternalSessionTranscriptWriteLockContext,
  InternalSessionTranscriptWriteLockParams,
} from "./session-transcript-lock-runtime.js";
import type { SessionTranscriptTargetParams } from "./session-transcript-runtime.js";

export { resolveSessionTranscriptReadFence as captureCodexSessionTranscriptReadAdmission } from "../config/sessions/session-transcript-read-fence.js";
export { validateSessionTranscriptContextAdmission as validateCodexSessionTranscriptReadAdmission } from "../config/sessions/session-accessor.sqlite-model-context.js";
export { validateSessionTranscriptContextVersion as validateCodexSessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-model-context.js";
export type { SessionTranscriptContextVersion } from "../config/sessions/session-accessor.sqlite-model-context.js";
export { SessionTranscriptReadFenceError };

/** The native evidence consumer remains lazy inside one readonly transcript snapshot. */
export function readCodexSessionContext<T>(
  target: SessionTranscriptRuntimeTarget,
  read: (
    messages: Iterable<AgentMessage>,
    header: unknown,
    version?: SessionTranscriptContextVersion,
  ) => T,
  admission?: TranscriptTurnAdmission,
): T {
  return withSessionContextAdmission(target, admission, () =>
    readSessionTranscriptContextMessages(target, read),
  );
}

/** Reads the bundled Codex mirror strictly before one admitted user row. */
export async function readCodexSessionTranscriptEventsBeforeAdmission(
  params: SessionTranscriptTargetParams,
  admission: TranscriptTurnAdmission,
) {
  const { readSessionTranscriptEvents, resolveSessionTranscriptIdentity } =
    await import("./session-transcript-runtime.js");
  const target = await resolveSessionTranscriptIdentity(params);
  if (
    target.agentId !== admission.agentId ||
    target.sessionId !== admission.sessionId ||
    target.sessionKey !== admission.sessionKey
  ) {
    throw new SessionTranscriptReadFenceError(
      "Current-turn transcript admission belongs to a different transcript target",
    );
  }
  return await runWithSessionTranscriptReadFence(
    admission,
    async () => await readSessionTranscriptEvents(params),
  );
}

export type CodexSessionTranscriptAdmissionDeltaResult =
  | {
      kind: "ok";
      messages: AgentMessage[];
    }
  | {
      kind: "non-descendant" | "projection-unavailable" | "session-rebound" | "stale" | "too-large";
    };

function admissionsShareTarget(
  left: TranscriptTurnAdmission,
  right: TranscriptTurnAdmission,
): boolean {
  return (
    left.agentId === right.agentId &&
    left.sessionId === right.sessionId &&
    left.sessionKey === right.sessionKey &&
    left.storePath === right.storePath
  );
}

/**
 * Reads visible messages strictly after one admitted user row and strictly
 * before the next. The closed-turn primitive validates both anchors and uses
 * the indexed active-message range instead of scanning from transcript start.
 */
export async function readCodexSessionTranscriptMessagesBetweenAdmissions(
  covered: TranscriptTurnAdmission,
  current: TranscriptTurnAdmission,
): Promise<CodexSessionTranscriptAdmissionDeltaResult> {
  const sameActiveMessagePosition = covered.activeMessagePosition === current.activeMessagePosition;
  if (
    !admissionsShareTarget(covered, current) ||
    covered.generation !== current.generation ||
    covered.activeMessagePosition > current.activeMessagePosition ||
    (sameActiveMessagePosition && covered.entryId !== current.entryId)
  ) {
    return { kind: "stale" };
  }
  const { readClosedTranscriptTurn } =
    await import("../config/sessions/session-accessor.transcript-range.js");
  const closedRange = readClosedTranscriptTurn({
    boundary: { admission: covered, terminal: current },
    maxBytes: 64 * 1024 * 1024,
    maxEvents: 10_000,
  });
  if (closedRange.kind !== "ok") {
    return closedRange;
  }
  // The indexed range is inclusive; both validated endpoints are admitted
  // user rows, while continuity projection needs only the rows between them.
  // A classified fallback can reuse the same recorder and therefore the same
  // validated endpoint for both sides; subtracting that one row yields [].
  return { kind: "ok", messages: closedRange.messages.slice(1, -1) };
}

/** Refreshes an admitted row only when a rewrite preserved its exact persisted message payload. */
export async function refreshCodexSessionTranscriptAdmission(
  admission: TranscriptTurnAdmission,
): Promise<TranscriptTurnAdmission | undefined> {
  const { readActiveTranscriptEntryAnchor } =
    await import("../config/sessions/session-accessor.sqlite-transcript-anchor.js");
  const anchor = readActiveTranscriptEntryAnchor({
    agentId: admission.agentId,
    sessionId: admission.sessionId,
    sessionKey: admission.sessionKey,
    storePath: admission.storePath,
    entryId: admission.entryId,
  });
  if (
    !anchor ||
    anchor.agentId !== admission.agentId ||
    anchor.sessionId !== admission.sessionId ||
    anchor.sessionKey !== admission.sessionKey ||
    anchor.storePath !== admission.storePath ||
    anchor.rawSeq !== admission.rawSeq ||
    anchor.effectiveParentId !== admission.effectiveParentId ||
    anchor.activeMessagePosition !== admission.activeMessagePosition ||
    !admission.messageFingerprint ||
    anchor.messageFingerprint !== admission.messageFingerprint
  ) {
    return undefined;
  }
  return {
    ...anchor,
    logicalTurnId: admission.logicalTurnId,
    role: "user",
  };
}

export type CodexSessionTranscriptMirrorWriteLockContext =
  InternalSessionTranscriptWriteLockContext & {
    appendMessageWithMessageSequence: <TMessage>(
      options: Omit<TranscriptMessageAppendOptions<TMessage>, "config">,
    ) => Promise<{
      messageSeq?: number;
      result: TranscriptMessageAppendResult<TMessage> | undefined;
    }>;
    readMessageFacts: (params: { idempotencyKeys: readonly string[] }) => Promise<{
      anchorsByIdempotencyKey: Map<string, TranscriptEntryAnchor>;
      existingIdempotencyKeys: Set<string>;
      messagesByIdempotencyKey: Map<string, AgentMessage>;
    }>;
  };

/** Runs the bundled Codex mirror under the transcript writer lock. */
export async function withCodexSessionTranscriptMirrorWriteLock<T>(
  params: InternalSessionTranscriptWriteLockParams,
  run: (context: CodexSessionTranscriptMirrorWriteLockContext) => Promise<T> | T,
): Promise<T> {
  const { withProjectedSessionTranscriptWriteLock } =
    await import("./session-transcript-lock-runtime.js");
  return await withProjectedSessionTranscriptWriteLock(params, run, (context, locked) => ({
    ...context,
    appendMessageWithMessageSequence: (options) =>
      locked.appendMessageWithMessageSequence({
        ...options,
        ...(params.config !== undefined ? { config: params.config } : {}),
      }),
    readMessageFacts: async (factParams) => {
      const facts = await locked.readMessageFacts(factParams);
      const messagesByIdempotencyKey = new Map<string, AgentMessage>();
      for (const [idempotencyKey, message] of facts.messagesByIdempotencyKey) {
        if (isAgentMessageRecord(message)) {
          messagesByIdempotencyKey.set(idempotencyKey, message);
        }
      }
      return { ...facts, messagesByIdempotencyKey };
    },
  }));
}

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && typeof value.role === "string" && value.role.trim().length > 0;
}
