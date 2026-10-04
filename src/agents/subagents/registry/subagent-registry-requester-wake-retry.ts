import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import {
  getPendingWakeCommit,
  REQUESTER_SETTLE_WAKE_MAX_BACKOFF_MS,
} from "./subagent-registry-requester-wake-commit.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RequesterSettleWake = NonNullable<SubagentRunRecord["requesterSettleWake"]>;

export type RequesterSettleWakeFailureRetry = {
  wake: RequesterSettleWake;
  nextAttemptAt: number;
  rearmGeneration?: number;
  deadline: number;
};

function requesterSettleWakeRetryDeadline(
  wake: RequesterSettleWake | undefined,
  nextAttemptAt: number,
  hasPendingCommit: boolean,
): number {
  // Older candidates persisted hour-long settlement delays. Bound the timer,
  // not the stored wake: settlement must still compare its original payload.
  return !hasPendingCommit && (wake?.settleFailureCount ?? 0) > 0
    ? Math.min(nextAttemptAt, Date.now() + REQUESTER_SETTLE_WAKE_MAX_BACKOFF_MS)
    : nextAttemptAt;
}

export function retainScheduledRequesterSettleWakeTimer(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  deadline: number,
): boolean {
  const scheduled = context.getRequesterSettleWakeTimer(entry.runId);
  if (!scheduled) {
    return false;
  }
  const rearmGeneration = entry.requesterSettleWake?.rearmGeneration;
  const hasNewerGeneration =
    rearmGeneration !== undefined &&
    (scheduled.rearmGeneration === undefined || rearmGeneration > scheduled.rearmGeneration);
  // A restored owner must not inherit a timer whose callback still captures the old row.
  if (scheduled.entry === entry && !hasNewerGeneration && deadline >= scheduled.deadline) {
    return true;
  }
  clearTimeout(scheduled.timer);
  context.deleteRequesterSettleWakeTimer(entry.runId);
  return false;
}

export function scheduleRequesterSettleWakeRetry(
  context: SubagentLifecycleWakeContext,
  runId: string,
  entry: SubagentRunRecord,
  retry: (entry: SubagentRunRecord, expiredFailureRetry?: RequesterSettleWakeFailureRetry) => void,
): void {
  const pending = getPendingWakeCommit(context, entry);
  const wake = entry.requesterSettleWake;
  const nextAttemptAt = pending?.nextAttemptAt ?? wake?.nextAttemptAt;
  if (nextAttemptAt === undefined || nextAttemptAt <= Date.now()) {
    return;
  }
  const rearmGeneration = wake?.rearmGeneration;
  const deadline = requesterSettleWakeRetryDeadline(wake, nextAttemptAt, Boolean(pending));
  if (retainScheduledRequesterSettleWakeTimer(context, entry, deadline)) {
    return;
  }
  const timer = setTimeout(
    () => {
      if (context.getRequesterSettleWakeTimer(runId)?.timer !== timer) {
        return;
      }
      context.deleteRequesterSettleWakeTimer(runId);
      const current = context.options.runs.get(runId);
      if (current === entry && current.requesterSettleWake) {
        retry(
          current,
          wake && deadline < nextAttemptAt
            ? { wake, nextAttemptAt, rearmGeneration, deadline }
            : undefined,
        );
      }
    },
    Math.max(0, deadline - Date.now()),
  );
  timer.unref?.();
  context.setRequesterSettleWakeTimer(runId, { entry, timer, deadline, rearmGeneration });
}

export function isRequesterSettleWakeFailureRetryDue(
  wake: RequesterSettleWake,
  retry: RequesterSettleWakeFailureRetry | undefined,
  now: number,
): boolean {
  // Only the exact expired timer can shorten its captured failure deadline;
  // replacement wakes and ordinary transport retry budgets stay authoritative.
  return (
    retry?.wake === wake &&
    retry.nextAttemptAt === wake.nextAttemptAt &&
    retry.rearmGeneration === wake.rearmGeneration &&
    retry.deadline <= now
  );
}
