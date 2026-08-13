/** Shared deadline and terminal-state handling for exact cron run waits. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sleep } from "../utils/sleep.js";

type CronRunTerminalStatus = "ok" | "error" | "skipped";
export type CronRunTerminalEntry = Record<string, unknown> & { status: CronRunTerminalStatus };

const CRON_RUN_WAIT_SUMMARY_MAX_CHARS = 4_000;
const CRON_RUN_WAIT_DETAIL_MAX_CHARS = 2_000;
const CRON_RUN_WAIT_ID_MAX_CHARS = 512;

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.length <= maxChars ? value : `${truncateUtf16Safe(value, maxChars - 1)}…`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function projectCronRunUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage = Object.fromEntries(
    [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
    ].flatMap((key) => {
      const count = finiteNumber(value[key]);
      return count === undefined ? [] : [[key, count]];
    }),
  );
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Keeps a completion result useful to the model without returning an unbounded ledger row. */
export function projectCronRunTerminalEntry(entry: CronRunTerminalEntry) {
  const diagnostics = isRecord(entry.diagnostics) ? entry.diagnostics : undefined;
  const diagnosticEntries = Array.isArray(diagnostics?.entries) ? diagnostics.entries : [];
  const lastDiagnostic = diagnosticEntries.findLast(isRecord);
  const diagnosticSummary = boundedText(
    diagnostics?.summary ?? lastDiagnostic?.message,
    CRON_RUN_WAIT_DETAIL_MAX_CHARS,
  );
  const failureNotification = isRecord(entry.failureNotificationDelivery)
    ? entry.failureNotificationDelivery
    : undefined;
  const usage = projectCronRunUsage(entry.usage);
  return {
    status: entry.status,
    ...(boundedText(entry.runId, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { runId: boundedText(entry.runId, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(boundedText(entry.jobId, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { jobId: boundedText(entry.jobId, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(boundedText(entry.jobName, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { jobName: boundedText(entry.jobName, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(finiteNumber(entry.ts) !== undefined ? { ts: finiteNumber(entry.ts) } : {}),
    ...(finiteNumber(entry.runAtMs) !== undefined ? { runAtMs: finiteNumber(entry.runAtMs) } : {}),
    ...(finiteNumber(entry.durationMs) !== undefined
      ? { durationMs: finiteNumber(entry.durationMs) }
      : {}),
    ...(finiteNumber(entry.nextRunAtMs) !== undefined
      ? { nextRunAtMs: finiteNumber(entry.nextRunAtMs) }
      : {}),
    ...(typeof entry.triggerFired === "boolean" ? { triggerFired: entry.triggerFired } : {}),
    ...(boundedText(entry.summary, CRON_RUN_WAIT_SUMMARY_MAX_CHARS) !== undefined
      ? { summary: boundedText(entry.summary, CRON_RUN_WAIT_SUMMARY_MAX_CHARS) }
      : {}),
    ...(boundedText(entry.error, CRON_RUN_WAIT_DETAIL_MAX_CHARS) !== undefined
      ? { error: boundedText(entry.error, CRON_RUN_WAIT_DETAIL_MAX_CHARS) }
      : {}),
    ...(boundedText(entry.errorReason, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { errorReason: boundedText(entry.errorReason, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(diagnosticSummary !== undefined ? { diagnostics: { summary: diagnosticSummary } } : {}),
    ...(typeof entry.delivered === "boolean" ? { delivered: entry.delivered } : {}),
    ...(boundedText(entry.deliveryStatus, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { deliveryStatus: boundedText(entry.deliveryStatus, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(boundedText(entry.deliveryError, CRON_RUN_WAIT_DETAIL_MAX_CHARS) !== undefined
      ? { deliveryError: boundedText(entry.deliveryError, CRON_RUN_WAIT_DETAIL_MAX_CHARS) }
      : {}),
    ...(failureNotification
      ? {
          failureNotificationDelivery: {
            ...(typeof failureNotification.delivered === "boolean"
              ? { delivered: failureNotification.delivered }
              : {}),
            ...(boundedText(failureNotification.status, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
              ? { status: boundedText(failureNotification.status, CRON_RUN_WAIT_ID_MAX_CHARS) }
              : {}),
            ...(boundedText(failureNotification.error, CRON_RUN_WAIT_DETAIL_MAX_CHARS) !== undefined
              ? { error: boundedText(failureNotification.error, CRON_RUN_WAIT_DETAIL_MAX_CHARS) }
              : {}),
          },
        }
      : {}),
    ...(boundedText(entry.sessionId, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { sessionId: boundedText(entry.sessionId, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(boundedText(entry.sessionKey, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { sessionKey: boundedText(entry.sessionKey, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(boundedText(entry.model, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { model: boundedText(entry.model, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(boundedText(entry.provider, CRON_RUN_WAIT_ID_MAX_CHARS) !== undefined
      ? { provider: boundedText(entry.provider, CRON_RUN_WAIT_ID_MAX_CHARS) }
      : {}),
    ...(usage ? { usage } : {}),
  };
}

function readCronRunTerminalEntry(page: unknown): CronRunTerminalEntry | undefined {
  if (!isRecord(page) || !Array.isArray(page.entries)) {
    return undefined;
  }
  const entry = page.entries[0];
  if (
    !isRecord(entry) ||
    (entry.status !== "ok" && entry.status !== "error" && entry.status !== "skipped")
  ) {
    return undefined;
  }
  return entry as CronRunTerminalEntry;
}

export async function waitForCronRunTerminalEntry(params: {
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
  readPage: (remainingMs: number) => Promise<unknown>;
}): Promise<CronRunTerminalEntry | undefined> {
  const startedAt = Date.now();
  let hasPolled = false;
  for (;;) {
    params.signal?.throwIfAborted();
    const elapsedBeforePollMs = Math.max(0, Date.now() - startedAt);
    if (hasPolled && elapsedBeforePollMs >= params.timeoutMs) {
      return undefined;
    }
    // A zero-duration wait still receives one authoritative ledger read.
    const remainingMs = Math.max(1, params.timeoutMs - elapsedBeforePollMs);
    hasPolled = true;
    const terminalEntry = readCronRunTerminalEntry(await params.readPage(remainingMs));
    params.signal?.throwIfAborted();
    if (terminalEntry) {
      return terminalEntry;
    }
    const remainingAfterPollMs = params.timeoutMs - Math.max(0, Date.now() - startedAt);
    if (remainingAfterPollMs <= 0) {
      return undefined;
    }
    await sleep(Math.min(params.pollIntervalMs, remainingAfterPollMs), params.signal);
  }
}
