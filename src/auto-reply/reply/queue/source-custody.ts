import { createHash } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import {
  hasRestartRecoverySourceClaim,
  hasRestartRecoveryTerminalRun,
} from "../../../config/sessions/restart-recovery-state.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { removeQueuedItemsByRef } from "../../../utils/queue-helpers.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import type { FollowupRun } from "./types.js";

export function resolveFollowupTranscriptTarget(source: FollowupRun) {
  const sessionKey = normalizeOptionalString(source.run.sessionKey) ?? source.run.sessionId;
  const storePath = resolveSessionStorePathCore(source.run.config.session?.store, {
    agentId: source.run.agentId,
  });
  const sessionEntry = loadSessionEntryReadOnly({
    storePath,
    sessionKey,
    clone: false,
  });
  return {
    sessionId: sessionEntry?.sessionId ?? source.run.sessionId,
    sessionKey,
    sessionEntry,
    storePath,
    agentId: source.run.agentId,
    cwd: source.run.cwd ?? source.run.workspaceDir,
    config: source.run.config,
  };
}

export function isDurablyConsumedQueuedSource(
  source: FollowupRun,
  entry: ReturnType<typeof resolveFollowupTranscriptTarget>["sessionEntry"],
): boolean {
  const sourceTurnIds = [source.sourceTurnId, ...(source.constituentSourceTurnIds ?? [])];
  return sourceTurnIds.some(
    (sourceTurnId) =>
      sourceTurnId !== undefined &&
      (hasRestartRecoveryTerminalRun(entry, sourceTurnId) ||
        hasRestartRecoverySourceClaim(entry, sourceTurnId)),
  );
}

export function partitionDurablyConsumedQueuedSources(items: FollowupRun[]): {
  consumed: FollowupRun[];
  pending: FollowupRun[];
} {
  const source = items.at(-1);
  const entry = source ? resolveFollowupTranscriptTarget(source).sessionEntry : undefined;
  const consumed: FollowupRun[] = [];
  const pending: FollowupRun[] = [];
  for (const item of items) {
    (isDurablyConsumedQueuedSource(item, entry) ? consumed : pending).push(item);
  }
  return { consumed, pending };
}

export function dropDurablyConsumedQueuedItems(queue: {
  items: FollowupRun[];
  inFlight: ReadonlySet<FollowupRun>;
}): void {
  const consumed = queue.items.filter(
    (item) =>
      !queue.inFlight.has(item) &&
      isDurablyConsumedQueuedSource(item, resolveFollowupTranscriptTarget(item).sessionEntry),
  );
  removeQueuedItemsByRef(queue.items, consumed);
  for (const item of consumed) {
    completeFollowupRunLifecycle(item);
  }
}

export function buildAggregateSourceIdentity(params: {
  items: FollowupRun[];
  prefix: "followup-collect" | "followup-overflow";
  scope?: unknown;
}): Pick<FollowupRun, "sourceTurnId" | "constituentSourceTurnIds"> | undefined {
  if (params.items.length === 0 || params.items.some((item) => !item.sourceTurnId)) {
    return undefined;
  }
  if (params.prefix === "followup-collect" && params.items.length === 1) {
    return {
      sourceTurnId: params.items[0]?.sourceTurnId,
      constituentSourceTurnIds: params.items[0]?.constituentSourceTurnIds,
    };
  }
  const constituentSourceTurnIds = Array.from(
    new Set(
      params.items.flatMap((item) =>
        item.constituentSourceTurnIds?.length
          ? item.constituentSourceTurnIds
          : item.sourceTurnId
            ? [item.sourceTurnId]
            : [],
      ),
    ),
  ).toSorted();
  const identityHash = createHash("sha256")
    .update(JSON.stringify([constituentSourceTurnIds, params.scope]))
    .digest("hex");
  return {
    sourceTurnId: `${params.prefix}:${identityHash}`,
    constituentSourceTurnIds,
  };
}
