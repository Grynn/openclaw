import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  type TranscriptTurnAdmission,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";

const transcriptReadCounts = vi.hoisted(() => ({ exactDelta: 0, fullHistory: 0 }));

vi.mock("./session-history.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-history.js")>();
  return {
    ...actual,
    readCodexMirroredSessionHistoryMessages: async (
      ...args: Parameters<typeof actual.readCodexMirroredSessionHistoryMessages>
    ) => {
      transcriptReadCounts.fullHistory += 1;
      return await actual.readCodexMirroredSessionHistoryMessages(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/codex-session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/codex-session-transcript-runtime")>();
  return {
    ...actual,
    readCodexSessionTranscriptMessagesBetweenAdmissions: (
      ...args: Parameters<typeof actual.readCodexSessionTranscriptMessagesBetweenAdmissions>
    ) => {
      transcriptReadCounts.exactDelta += 1;
      return actual.readCodexSessionTranscriptMessagesBetweenAdmissions(...args);
    },
  };
});

setupRunAttemptTestHooks();

beforeEach(() => {
  transcriptReadCounts.exactDelta = 0;
  transcriptReadCounts.fullHistory = 0;
});

type TerminalKind = "final-message" | "sessions-yield";

async function createSqliteTurn(params: {
  prompt: string;
  runId: string;
  sessionFile: string;
  sessionId: string;
  storePath: string;
  workspaceDir: string;
}): Promise<EmbeddedRunAttemptParams> {
  const sessionKey = `agent:main:${params.sessionId}`;
  await upsertSessionEntry({
    agentId: "main",
    sessionKey,
    storePath: params.storePath,
    entry: {
      sessionFile: params.sessionFile,
      sessionId: params.sessionId,
      updatedAt: Date.now(),
    },
  });
  const attempt = createParams(params.sessionFile, params.workspaceDir, {
    prompt: params.prompt,
    runId: params.runId,
    sessionId: params.sessionId,
    sessionKey,
  });
  attempt.sessionTarget = {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey,
    storePath: params.storePath,
  };
  const persisted = await appendSessionTranscriptMessageByIdentity({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey,
    storePath: params.storePath,
    message: userMessage(params.prompt, Date.now()),
  });
  if (!persisted?.anchor) {
    throw new Error("expected current user transcript admission");
  }
  const admission: TranscriptTurnAdmission = {
    ...persisted.anchor,
    logicalTurnId: `${params.runId}:logical-turn`,
    role: "user",
  };
  const recorder: NonNullable<EmbeddedRunAttemptParams["userTurnTranscriptRecorder"]> = {
    message: persisted.message,
    resolveMessage: async () => persisted.message,
    getPersistedMessage: () => persisted.message,
    getAdmissionReceipt: () => admission,
    markRuntimePersistencePending(_pending) {},
    markRuntimePersisted() {},
    markBlocked() {},
    hasPersisted: () => true,
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistApproved: async () => undefined,
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
  };
  attempt.userTurnTranscriptRecorder = recorder;
  return attempt;
}

function configureLocallyTerminalTool(
  params: EmbeddedRunAttemptParams,
  terminalKind: TerminalKind,
) {
  const name = terminalKind === "final-message" ? "test_final_message" : "test_yield_turn";
  const tool = createRuntimeDynamicTool(name);
  tool.parameters = {
    type: "object",
    properties: {},
    additionalProperties: false,
  };
  tool.execute = vi.fn(async () => {
    const result = {
      content: [{ type: "text" as const, text: `${name} completed` }],
      details: terminalKind === "sessions-yield" ? { status: "yielded" } : {},
    };
    return terminalKind === "final-message" ? { ...result, terminate: true } : result;
  });
  dynamicToolBuildState.openClawCodingToolsFactory = () => [tool];
  params.runtimePlan = createCodexRuntimePlanFixture();
  setCodexTestModelSupportsTools(params, true);
  return name;
}

async function appendConcurrentUserMessage(
  params: EmbeddedRunAttemptParams,
  text: string,
  steerTargetRunId?: string,
): Promise<void> {
  const target = params.sessionTarget;
  if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
    throw new Error("expected complete SQLite session target");
  }
  await appendSessionTranscriptMessageByIdentity({
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    message: {
      ...userMessage(text, Date.now()),
      ...(steerTargetRunId ? { __openclaw: { steerTargetRunId } } : {}),
    },
  });
}

async function runCompletedNativeTurn(
  params: EmbeddedRunAttemptParams,
  harness: ReturnType<typeof createStartedThreadHarness>,
) {
  const priorTurnStartCount = harness.requests.filter(
    (request) => request.method === "turn/start",
  ).length;
  const run = runCodexAppServerAttempt(params);
  await vi.waitFor(
    () => {
      expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(
        priorTurnStartCount + 1,
      );
    },
    { interval: 1, timeout: 5_000 },
  );
  await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
  return await run;
}

describe("Codex native transcript coverage", () => {
  it("uses one indexed delta and no full history read for an ordinary exact resume", async () => {
    const sessionId = "coverage-completed-common-path";
    const sessionFile = `agent:main:${sessionId}`;
    const storePath = path.join(tempDir, `${sessionId}.sqlite`);
    const workspaceDir = path.join(tempDir, `${sessionId}-workspace`);
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      if (method === "thread/resume") {
        return threadStartResult(
          (requestParams as { threadId?: string })?.threadId ?? "thread-existing",
        );
      }
      return undefined;
    });

    const firstParams = await createSqliteTurn({
      prompt: "ordinary completed request",
      runId: "run-completed-common-path",
      sessionFile,
      sessionId,
      storePath,
      workspaceDir,
    });
    await runCompletedNativeTurn(firstParams, harness);
    expect(transcriptReadCounts.fullHistory).toBe(1);

    const coveredBinding = await readCodexAppServerBinding(sessionFile);
    expect(coveredBinding?.transcriptCoverage).toBeDefined();
    transcriptReadCounts.exactDelta = 0;
    transcriptReadCounts.fullHistory = 0;

    const secondParams = await createSqliteTurn({
      prompt: "ordinary exact resume",
      runId: "run-completed-common-path:resume",
      sessionFile,
      sessionId,
      storePath,
      workspaceDir,
    });
    await runCompletedNativeTurn(secondParams, harness);

    expect(transcriptReadCounts.exactDelta).toBe(1);
    expect(transcriptReadCounts.fullHistory).toBe(0);
    expect(harness.requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
  });

  it("uses an empty exact delta when a classified fallback reuses the same recorder", async () => {
    const sessionId = "coverage-classified-same-recorder-fallback";
    const sessionFile = `agent:main:${sessionId}`;
    const storePath = path.join(tempDir, `${sessionId}.sqlite`);
    const workspaceDir = path.join(tempDir, `${sessionId}-workspace`);
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      if (method === "thread/resume") {
        return threadStartResult(
          (requestParams as { threadId?: string })?.threadId ?? "thread-existing",
        );
      }
      return undefined;
    });
    const params = await createSqliteTurn({
      prompt: "classify this request before retrying it",
      runId: "run-classified-same-recorder-fallback",
      sessionFile,
      sessionId,
      storePath,
      workspaceDir,
    });

    const classified = await runCompletedNativeTurn(params, harness);
    expect(classified.agentHarnessResultClassification).toBe("empty");
    const coveredBinding = await readCodexAppServerBinding(sessionFile);
    expect(coveredBinding?.transcriptCoverage?.turnStartAdmission.entryId).toBe(
      params.userTurnTranscriptRecorder?.getAdmissionReceipt()?.entryId,
    );
    transcriptReadCounts.exactDelta = 0;
    transcriptReadCounts.fullHistory = 0;

    await runCompletedNativeTurn(params, harness);

    expect(transcriptReadCounts.exactDelta).toBe(1);
    expect(transcriptReadCounts.fullHistory).toBe(0);
    expect(harness.requests.filter((request) => request.method === "thread/start")).toHaveLength(1);
  });

  it("conservatively replays a concurrent arrival after a turn with no admission receipt", async () => {
    const sessionId = "coverage-no-admission-concurrent-arrival";
    const sessionFile = `agent:main:${sessionId}`;
    const storePath = path.join(tempDir, `${sessionId}.sqlite`);
    const workspaceDir = path.join(tempDir, `${sessionId}-workspace`);
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      if (method === "thread/resume") {
        return threadStartResult(
          (requestParams as { threadId?: string })?.threadId ?? "thread-existing",
        );
      }
      return undefined;
    });
    const firstParams = await createSqliteTurn({
      prompt: "request without an admission receipt",
      runId: "run-no-admission-concurrent-arrival",
      sessionFile,
      sessionId,
      storePath,
      workspaceDir,
    });
    const recorder = firstParams.userTurnTranscriptRecorder;
    if (!recorder) {
      throw new Error("expected transcript recorder");
    }
    firstParams.userTurnTranscriptRecorder = {
      ...recorder,
      getAdmissionReceipt: () => undefined,
    };
    const firstRun = runCodexAppServerAttempt(firstParams);
    await harness.waitForMethod("turn/start");
    await appendConcurrentUserMessage(firstParams, "arrived before no-admission finalization");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await firstRun;

    const uncoveredBinding = await readCodexAppServerBinding(sessionFile);
    expect(uncoveredBinding?.transcriptCoverage).toBeUndefined();
    expect(uncoveredBinding?.historyCoveredThrough).toBeUndefined();
    transcriptReadCounts.exactDelta = 0;
    transcriptReadCounts.fullHistory = 0;

    const secondParams = await createSqliteTurn({
      prompt: "resume after the unanchored turn",
      runId: "run-no-admission-concurrent-arrival:resume",
      sessionFile,
      sessionId,
      storePath,
      workspaceDir,
    });
    await runCompletedNativeTurn(secondParams, harness);

    expect(transcriptReadCounts.exactDelta).toBe(0);
    expect(transcriptReadCounts.fullHistory).toBe(1);
    const turnStart = harness.requests.findLast((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText).toContain("arrived before no-admission finalization");
  });

  it("falls back to one full history read when the exact admission anchor is stale", async () => {
    const sessionId = "coverage-stale-anchor-fallback";
    const sessionFile = `agent:main:${sessionId}`;
    const storePath = path.join(tempDir, `${sessionId}.sqlite`);
    const workspaceDir = path.join(tempDir, `${sessionId}-workspace`);
    const harness = createStartedThreadHarness(async (method, requestParams) => {
      if (method === "thread/resume") {
        return threadStartResult(
          (requestParams as { threadId?: string })?.threadId ?? "thread-existing",
        );
      }
      return undefined;
    });

    const firstParams = await createSqliteTurn({
      prompt: "request before stale coverage",
      runId: "run-stale-anchor-fallback",
      sessionFile,
      sessionId,
      storePath,
      workspaceDir,
    });
    await runCompletedNativeTurn(firstParams, harness);
    const coveredBinding = await readCodexAppServerBinding(sessionFile);
    if (!coveredBinding?.transcriptCoverage) {
      throw new Error("expected exact transcript coverage");
    }
    await writeCodexAppServerBinding(sessionFile, {
      ...coveredBinding,
      transcriptCoverage: {
        ...coveredBinding.transcriptCoverage,
        turnStartAdmission: {
          ...coveredBinding.transcriptCoverage.turnStartAdmission,
          generation: `${coveredBinding.transcriptCoverage.turnStartAdmission.generation}:stale`,
        },
      },
    });
    transcriptReadCounts.exactDelta = 0;
    transcriptReadCounts.fullHistory = 0;

    const secondParams = await createSqliteTurn({
      prompt: "resume after stale coverage",
      runId: "run-stale-anchor-fallback:resume",
      sessionFile,
      sessionId,
      storePath,
      workspaceDir,
    });
    await runCompletedNativeTurn(secondParams, harness);

    expect(transcriptReadCounts.exactDelta).toBe(1);
    expect(transcriptReadCounts.fullHistory).toBe(1);
    const turnStart = harness.requests.findLast((request) => request.method === "turn/start");
    const inputText =
      (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
      "";
    expect(inputText).toContain("request before stale coverage");
    expect(inputText).toContain("resume after stale coverage");
  });

  it.each([
    { lifecycle: "fresh", terminalKind: "final-message" },
    { lifecycle: "rotated", terminalKind: "sessions-yield" },
  ] as const)(
    "does not replay a locally terminal $terminalKind turn after a $lifecycle thread start",
    async ({ lifecycle, terminalKind }) => {
      const sessionId = `coverage-${lifecycle}-${terminalKind}`;
      const sessionFile = `agent:main:${sessionId}`;
      const storePath = path.join(tempDir, `${sessionId}.sqlite`);
      const workspaceDir = path.join(tempDir, `${sessionId}-workspace`);
      if (lifecycle === "rotated") {
        await writeCodexAppServerBinding(sessionFile, {
          threadId: "thread-stale",
          cwd: workspaceDir,
          model: "gpt-5.4-codex",
          modelProvider: "openai",
          dynamicToolsFingerprint: "[]",
          historyCoveredThrough: new Date(0).toISOString(),
        });
      }

      const firstRunId = `run-${lifecycle}-${terminalKind}`;
      const firstPrompt = `first ${lifecycle} ${terminalKind} request`;
      const firstParams = await createSqliteTurn({
        prompt: firstPrompt,
        runId: firstRunId,
        sessionFile,
        sessionId,
        storePath,
        workspaceDir,
      });
      const terminalTool = configureLocallyTerminalTool(firstParams, terminalKind);
      const firstHarness = createStartedThreadHarness(async (method, requestParams) => {
        if (method === "thread/resume") {
          return threadStartResult(
            (requestParams as { threadId?: string })?.threadId ?? "thread-existing",
          );
        }
        return undefined;
      });
      const firstRun = runCodexAppServerAttempt(firstParams);
      await firstHarness.waitForMethod("turn/start");

      await appendConcurrentUserMessage(firstParams, "arrived while the native turn was active");
      await appendConcurrentUserMessage(
        firstParams,
        "confirmed steering already consumed by this turn",
        firstRunId,
      );
      const toolResponse = await firstHarness.handleServerRequest({
        id: `terminal-${terminalKind}`,
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: `call-${terminalKind}`,
          namespace: null,
          tool: terminalTool,
          arguments: {},
        },
      });
      if ((toolResponse as { success?: unknown } | undefined)?.success !== true) {
        throw new Error(`terminal tool failed: ${JSON.stringify(toolResponse)}`);
      }
      expect(toolResponse).toMatchObject({ success: true });
      await firstHarness.waitForMethod("turn/interrupt", 5_000);
      await firstRun;

      const coveredBinding = await readCodexAppServerBinding(sessionFile);
      expect(coveredBinding).toMatchObject({
        threadId: "thread-1",
        transcriptCoverage: {
          schemaVersion: 1,
          steerTargetRunId: firstRunId,
          turnStartAdmission: { role: "user" },
        },
      });
      expect(coveredBinding?.historyCoveredThrough).toBeUndefined();
      if (!coveredBinding) {
        throw new Error("expected covered Codex binding");
      }
      // Tool-catalog compatibility is orthogonal to this regression. Leave the
      // exact coverage marker intact while allowing the next attempt to cold-resume
      // regardless of the synthetic terminal tool's test-only fingerprint.
      await writeCodexAppServerBinding(sessionFile, {
        ...coveredBinding,
        dynamicToolsContainDeferred: undefined,
        dynamicToolsFingerprint: undefined,
      });
      transcriptReadCounts.exactDelta = 0;
      transcriptReadCounts.fullHistory = 0;

      const secondPrompt = "continue after the local terminal handoff";
      const secondParams = await createSqliteTurn({
        prompt: secondPrompt,
        runId: `${firstRunId}:resume`,
        sessionFile,
        sessionId,
        storePath,
        workspaceDir,
      });
      secondParams.runtimePlan = createCodexRuntimePlanFixture();
      setCodexTestModelSupportsTools(secondParams, true);
      const priorTurnStartCount = firstHarness.requests.filter(
        (request) => request.method === "turn/start",
      ).length;
      const secondRun = runCodexAppServerAttempt(secondParams);
      await vi.waitFor(
        () => {
          expect(
            firstHarness.requests.filter((request) => request.method === "turn/start"),
          ).toHaveLength(priorTurnStartCount + 1);
        },
        { interval: 1, timeout: 5_000 },
      );
      const turnStart = firstHarness.requests.findLast(
        (request) => request.method === "turn/start",
      );
      expect(
        firstHarness.requests.filter((request) => request.method === "thread/start"),
      ).toHaveLength(1);
      const inputText =
        (turnStart?.params as { input?: Array<{ text?: string }> } | undefined)?.input?.[0]?.text ??
        "";

      expect(inputText).not.toContain(firstPrompt);
      expect(inputText).toContain("arrived while the native turn was active");
      expect(inputText).not.toContain("confirmed steering already consumed by this turn");
      expect(inputText).toContain(secondPrompt);
      expect(transcriptReadCounts.exactDelta).toBe(1);
      expect(transcriptReadCounts.fullHistory).toBe(0);

      await firstHarness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await secondRun;
    },
  );
});
