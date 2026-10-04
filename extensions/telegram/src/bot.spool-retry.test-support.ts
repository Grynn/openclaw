import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi, type Mock } from "vitest";
import {
  recordTelegramMessageProcessingResult,
  runWithTelegramUpdateProcessingFrame,
  TelegramSpooledReplayProcessingError,
} from "./bot-processing-outcome.js";

type UpdateTrackerFixture = {
  onUpdateId: Mock<(updateId: number) => void | Promise<void>>;
  run: (ctx: Record<string, unknown>, finalNext: () => Promise<void>) => Promise<void>;
};

/** Uses the parent bot suite's existing setup and teardown, without booting another bot fixture. */
export function registerTelegramSpoolRetryTests({
  setupUpdateOffsetTracker,
  withTelegramSpooledReplayUpdate,
  flushTelegramTestMicrotasks,
}: {
  setupUpdateOffsetTracker: (params: { lastUpdateId: number }) => Promise<UpdateTrackerFixture>;
  withTelegramSpooledReplayUpdate: <T>(update: object, fn: () => Promise<T>) => Promise<T>;
  flushTelegramTestMicrotasks: () => Promise<void>;
}) {
  it("rejects recorded dispatch failures during isolated spool replay", async () => {
    const { onUpdateId, run: runMiddlewareChain } = await setupUpdateOffsetTracker({
      lastUpdateId: 600,
    });

    const update = { update_id: 601 };
    const dispatchError = new Error("dispatch exploded");
    await expect(
      withTelegramSpooledReplayUpdate(update, async () => {
        await runMiddlewareChain({ update }, async () => {
          recordTelegramMessageProcessingResult({
            kind: "failed-retryable",
            error: dispatchError,
          });
        });
      }),
    ).rejects.toMatchObject({
      name: TelegramSpooledReplayProcessingError.name,
      cause: dispatchError,
    });
    await flushTelegramTestMicrotasks();
    expect(onUpdateId).not.toHaveBeenCalled();
  });

  it("keeps a timed-out in-flight spool retry pending until its first handler settles", async () => {
    const { run } = await setupUpdateOffsetTracker({ lastUpdateId: 800 });
    const firstStarted = createDeferred<void>();
    const finishFirst = createDeferred<void>();
    const firstUpdate = { update_id: 801 };
    const first = runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(firstUpdate, () =>
        run({ update: firstUpdate }, async () => {
          firstStarted.resolve();
          await finishFirst.promise;
          throw new Error("owner timed out before adoption");
        }),
      ),
    );
    await firstStarted.promise;

    const retryHandler = vi.fn(async () => {});
    const retryUpdate = { update_id: 801 };
    const overlapping = await runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(retryUpdate, () =>
        run({ update: retryUpdate }, retryHandler),
      ),
    );
    expect(overlapping.result).toMatchObject({ kind: "failed-retryable" });
    expect(retryHandler).not.toHaveBeenCalled();

    finishFirst.resolve();
    await expect(first).rejects.toThrow("owner timed out before adoption");

    const recoveredUpdate = { update_id: 801 };
    const recovered = await runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(recoveredUpdate, () =>
        run({ update: recoveredUpdate }, retryHandler),
      ),
    );
    expect(recovered.result).toEqual({ kind: "completed" });
    expect(retryHandler).toHaveBeenCalledOnce();

    const duplicateUpdate = { update_id: 801 };
    const duplicate = await runWithTelegramUpdateProcessingFrame(() =>
      withTelegramSpooledReplayUpdate(duplicateUpdate, () =>
        run({ update: duplicateUpdate }, retryHandler),
      ),
    );
    expect(duplicate.result).toBeUndefined();
    expect(retryHandler).toHaveBeenCalledOnce();
  });
}
