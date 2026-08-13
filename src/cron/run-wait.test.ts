// Cron run wait tests cover deadline handling and bounded terminal projection.
import { describe, expect, it, vi } from "vitest";
import { projectCronRunTerminalEntry, waitForCronRunTerminalEntry } from "./run-wait.js";

describe("cron run wait", () => {
  it("projects one terminal row into a bounded model-facing result", () => {
    const projected = projectCronRunTerminalEntry({
      status: "error",
      runId: "manual:job-1:1",
      jobId: "job-1",
      ts: 100,
      runAtMs: 80,
      durationMs: 20,
      summary: "s".repeat(20_000),
      error: "e".repeat(20_000),
      diagnostics: {
        summary: "d".repeat(20_000),
        entries: [{ message: "unreturned diagnostic entry" }],
      },
      delivered: false,
      deliveryStatus: "not-delivered",
      deliveryError: "x".repeat(20_000),
      usage: { input_tokens: 10, output_tokens: 5, ignored: 99 },
      ignoredPayload: "z".repeat(20_000),
    });

    expect(projected).toMatchObject({
      status: "error",
      runId: "manual:job-1:1",
      jobId: "job-1",
      ts: 100,
      runAtMs: 80,
      durationMs: 20,
      delivered: false,
      deliveryStatus: "not-delivered",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(projected.summary).toHaveLength(4_000);
    expect(projected.error).toHaveLength(2_000);
    expect(projected.diagnostics?.summary).toHaveLength(2_000);
    expect(projected.deliveryError).toHaveLength(2_000);
    expect(projected).not.toHaveProperty("diagnostics.entries");
    expect(projected).not.toHaveProperty("ignoredPayload");
    expect(projected.usage).not.toHaveProperty("ignored");
    expect(JSON.stringify(projected).length).toBeLessThan(11_000);
  });

  it("uses one authoritative read for a zero remaining deadline", async () => {
    const readPage = vi.fn(async () => ({ entries: [] }));

    await expect(
      waitForCronRunTerminalEntry({ timeoutMs: 0, pollIntervalMs: 2_000, readPage }),
    ).resolves.toBeUndefined();
    expect(readPage).toHaveBeenCalledOnce();
    expect(readPage).toHaveBeenCalledWith(1);
  });
});
