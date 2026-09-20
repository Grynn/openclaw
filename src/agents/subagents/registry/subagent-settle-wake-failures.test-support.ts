// Settle-wake settlement-failure coverage for the subagent registry lifecycle.
// Split out of subagent-registry-lifecycle.test.ts, which is a grandfathered
// oversized file; the controller scaffolding is injected by the caller.
import { describe, expect, it, vi } from "vitest";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type RequesterSettleWakeParams = Parameters<
  SubagentLifecycleOptions["maybeWakeRequesterAfterAllChildrenSettled"]
>[0];

export function registerSettleWakeFailures({
  createRunEntry,
  createLifecycleController,
  waitForLifecycleState,
}: {
  createRunEntry: (
    overrides: Partial<SubagentRunRecord> & { endedAt?: number },
  ) => SubagentRunRecord;
  createLifecycleController: (
    options: { entry: SubagentRunRecord } & Partial<SubagentLifecycleOptions>,
  ) => SubagentLifecycleController;
  waitForLifecycleState: (assertion: () => void) => Promise<unknown>;
}): void {
  describe("requester settle wake settlement failures", () => {
    it("bounds a wake whose completion owner can never settle", async () => {
      // Production wedge (2026-09-18): the run outlived its task row, so every
      // settlement attempt threw "subagent completion owner changed before
      // settlement", nothing persisted, and the sweeper re-ran the identical
      // rejection once a minute forever.
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        delivery: { status: "pending" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["run-1"],
        },
      });
      const persist = vi.fn();
      const warn = vi.fn();
      const settleWake = vi.fn(async (wakeParams: RequesterSettleWakeParams) => {
        wakeParams.completeBatch([entry], entry.requesterSettleWake?.rearmGeneration, {
          delivered: false,
          path: "none",
          error: "requester settle wake deferred too many times",
        });
        return false;
      });
      const controller = createLifecycleController({
        entry,
        persist,
        warn,
        resolveSubagentTask: () => ({ lookup: "unavailable" }),
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      for (const expectedFailureCount of [1, 2]) {
        entry.requesterSettleWake = { ...entry.requesterSettleWake!, nextAttemptAt: undefined };
        controller.resumeRequesterSettleWake(entry.runId, entry);
        await waitForLifecycleState(() =>
          expect(entry.requesterSettleWake?.settleFailureCount).toBe(expectedFailureCount),
        );
        // Each failure must buy a real backoff instead of an immediate re-run.
        expect(entry.requesterSettleWake?.nextAttemptAt).toBeGreaterThan(Date.now());
      }

      entry.requesterSettleWake = { ...entry.requesterSettleWake!, nextAttemptAt: undefined };
      controller.resumeRequesterSettleWake(entry.runId, entry);
      await waitForLifecycleState(() => expect(entry.requesterSettleWake).toBeUndefined());

      expect(settleWake).toHaveBeenCalledTimes(3);
      expect(persist).toHaveBeenCalledWith(entry.runId);
      expect(warn).toHaveBeenCalledWith(
        // The rejection text must reach the message; warn metadata is not rendered.
        expect.stringContaining(
          "requester settle wake abandoned after 3 settlement failures: subagent completion owner changed before settlement",
        ),
        expect.objectContaining({ failureCount: 3 }),
      );
      controller.clearScheduledResumeTimers();
    });

    it("keeps settling a wake whose owner is still available", async () => {
      const entry = createRunEntry({
        endedAt: 4_000,
        expectsCompletionMessage: true,
        delivery: { status: "delivered" },
        requesterSettleWake: { status: "pending", attemptCount: 0, batchRunIds: ["run-1"] },
      });
      const warn = vi.fn();
      const settleWake = vi.fn(async (wakeParams: RequesterSettleWakeParams) => {
        wakeParams.completeBatch([entry], entry.requesterSettleWake?.rearmGeneration);
        return true;
      });
      const controller = createLifecycleController({
        entry,
        warn,
        maybeWakeRequesterAfterAllChildrenSettled: settleWake,
      });

      controller.resumeRequesterSettleWake(entry.runId, entry);
      await waitForLifecycleState(() => expect(entry.requesterSettleWake).toBeUndefined());
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining("requester settle wake abandoned"),
        expect.anything(),
      );
      controller.clearScheduledResumeTimers();
    });
  });
}
