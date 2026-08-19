import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  readActiveTranscriptEntryAnchor,
  readClosedTranscriptTurn,
  type TranscriptMessageAppendOptions,
  type TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import {
  runWithSessionTranscriptReadFence,
  SessionTranscriptReadFenceError,
} from "../config/sessions/session-transcript-read-fence.js";
import type {
  TranscriptTurnAdmission,
  TranscriptEntryAnchor,
} from "../config/sessions/transcript-entry-anchor.js";
import type { AgentMessage } from "./agent-core.js";
import {
  withProjectedSessionTranscriptWriteLock,
  type InternalSessionTranscriptWriteLockContext,
  type InternalSessionTranscriptWriteLockParams,
} from "./session-transcript-lock-runtime.js";
import {
  publishSessionTranscriptUpdateByIdentity,
  readSessionTranscriptEvents,
  resolveSessionTranscriptIdentity,
  type SessionTranscriptTargetParams,
} from "./session-transcript-runtime.js";

/** Reads the bundled Codex mirror strictly before one admitted user row. */
export async function readCodexSessionTranscriptEventsBeforeAdmission(
  params: SessionTranscriptTargetParams,
  admission: TranscriptTurnAdmission,
) {
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
export function readCodexSessionTranscriptMessagesBetweenAdmissions(
  covered: TranscriptTurnAdmission,
  current: TranscriptTurnAdmission,
): CodexSessionTranscriptAdmissionDeltaResult {
  const sameActiveMessagePosition = covered.activeMessagePosition === current.activeMessagePosition;
  if (
    !admissionsShareTarget(covered, current) ||
    covered.generation !== current.generation ||
    covered.activeMessagePosition > current.activeMessagePosition ||
    (sameActiveMessagePosition && covered.entryId !== current.entryId)
  ) {
    return { kind: "stale" };
  }
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

/** Refreshes an admitted row after a benign transcript rewrite changed its generation. */
export function refreshCodexSessionTranscriptAdmission(
  admission: TranscriptTurnAdmission,
): TranscriptTurnAdmission | undefined {
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
    anchor.activeMessagePosition !== admission.activeMessagePosition
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
  return await withProjectedSessionTranscriptWriteLock(
    params,
    run,
    (context, locked) => ({
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
    }),
    publishSessionTranscriptUpdateByIdentity,
  );
}

function isAgentMessageRecord(value: unknown): value is AgentMessage & Record<string, unknown> {
  return isRecord(value) && typeof value.role === "string" && value.role.trim().length > 0;
}
