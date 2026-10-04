import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, expect, it, vi } from "vitest";
import * as historyWorker from "../../session-history-worker-runtime.js";
import {
  buildCompletedCodexTranscriptCoveragePatch,
  selectCodexHistoryAfterExactCoverage,
  selectCodexHistoryAfterInvalidExactCoverage,
} from "./transcript-coverage.js";

const admission: TranscriptTurnAdmission = {
  agentId: "main",
  sessionId: "session",
  sessionKey: "agent:main:session",
  storePath: "/fixture/state.sqlite",
  generation: "before-rewrite",
  entryId: "covered",
  rawSeq: 1,
  effectiveParentId: null,
  activeMessagePosition: 0,
  logicalTurnId: "turn-1",
  role: "user",
  messageFingerprint: "a".repeat(64),
};
const current: TranscriptTurnAdmission = {
  ...admission,
  entryId: "current",
  rawSeq: 9,
  effectiveParentId: "last",
  activeMessagePosition: 7,
  logicalTurnId: "turn-2",
};
const coverage = {
  schemaVersion: 1 as const,
  turnStartAdmission: admission,
  steerTargetRunId: "native-run-1",
};
const message = (text: string, metadata?: object): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: 1,
  ...(metadata ? { __openclaw: metadata } : {}),
});

afterEach(() => vi.restoreAllMocks());

it("retains exact coverage across recorder-free turns without downgrading to a timestamp", async () => {
  await expect(
    buildCompletedCodexTranscriptCoveragePatch({
      previousExactCoverage: coverage,
      runId: "maintenance",
    }),
  ).resolves.toEqual({});
  const legacy = await buildCompletedCodexTranscriptCoveragePatch({ runId: "legacy-turn" });
  expect(Number.isFinite(Date.parse(legacy.historyCoveredThrough ?? ""))).toBe(true);
  expect(legacy.transcriptCoverage).toBeUndefined();
});

it("rejects a changed turn owner before refreshing completed coverage", async () => {
  const refresh = vi.spyOn(historyWorker, "refreshCodexHistoryAdmissionInWorker");
  await expect(
    buildCompletedCodexTranscriptCoveragePatch({
      turnStartAdmission: admission,
      latestAdmission: current,
      runId: "run",
    }),
  ).rejects.toThrow("changed ownership");
  expect(refresh).not.toHaveBeenCalled();
});

it("excludes only native mirrors and steers confirmed into the covered run", async () => {
  const pending = message("not admitted to native thread");
  const laterSteer = message("belongs to another native run", { steerTargetRunId: "native-run-2" });
  const confirmedSteer = message("already received", { steerTargetRunId: "native-run-1" });
  const mirror = message("native mirror", { mirrorOrigin: "codex-app-server" });
  const delta = vi
    .spyOn(historyWorker, "readCodexHistoryAdmissionDeltaInWorker")
    .mockResolvedValue({
      kind: "ok",
      messages: [pending, laterSteer, confirmedSteer, mirror],
    });
  await expect(
    selectCodexHistoryAfterExactCoverage({ coverage, currentAdmission: current }),
  ).resolves.toEqual({
    kind: "ok",
    messages: [pending, laterSteer],
  });
  expect(delta).toHaveBeenCalledWith(admission, current, undefined);
  // A stale admission cannot claim even a confirmed steer was seen by this thread.
  expect(selectCodexHistoryAfterInvalidExactCoverage([pending, confirmedSteer, mirror])).toEqual([
    pending,
    confirmedSteer,
  ]);
});

it("uses exact refreshed endpoints after a payload-preserving rewrite", async () => {
  const delta = vi
    .spyOn(historyWorker, "readCodexHistoryAdmissionDeltaInWorker")
    .mockResolvedValueOnce({ kind: "stale" })
    .mockResolvedValueOnce({ kind: "ok", messages: [] });
  const refreshedCovered = { ...admission, generation: "after-rewrite" };
  const refreshedCurrent = { ...current, generation: "after-rewrite" };
  vi.spyOn(historyWorker, "refreshCodexHistoryAdmissionInWorker")
    .mockResolvedValueOnce(refreshedCovered)
    .mockResolvedValueOnce(refreshedCurrent);
  await expect(
    selectCodexHistoryAfterExactCoverage({ coverage, currentAdmission: current }),
  ).resolves.toEqual({ kind: "ok", messages: [] });
  expect(delta).toHaveBeenLastCalledWith(refreshedCovered, refreshedCurrent, undefined);
});

it.each([false, true])(
  "keeps refresh failures conservative without swallowing cancellation (aborted: %s)",
  async (aborted) => {
    const controller = new AbortController();
    vi.spyOn(historyWorker, "readCodexHistoryAdmissionDeltaInWorker").mockResolvedValue({
      kind: "stale",
    });
    vi.spyOn(historyWorker, "refreshCodexHistoryAdmissionInWorker").mockImplementation(async () => {
      if (aborted) {
        controller.abort(new Error("owner ended"));
      }
      throw new Error("history worker unavailable");
    });
    const result = selectCodexHistoryAfterExactCoverage({
      coverage,
      currentAdmission: current,
      signal: controller.signal,
    });
    if (aborted) {
      await expect(result).rejects.toThrow("owner ended");
    } else {
      await expect(result).resolves.toEqual({ kind: "projection-unavailable" });
    }
  },
);
