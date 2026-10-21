import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readMirroredSessionHistoryMessages } from "./attempt-context.js";
import {
  assistantMessage,
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  createStartedThreadHarness,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  appendSqliteHistoryMessage,
  attachSqliteSessionTarget,
} from "./sqlite-session.test-helpers.js";

setupRunAttemptTestHooks();

async function createHistory(provider = "codex") {
  const sessionId = "bounded-continuity";
  const params = createParams(`agent:main:${sessionId}`, path.join(tempDir, "workspace"), {
    provider,
  });
  await attachSqliteSessionTarget(params, path.join(tempDir, "session.sqlite"), sessionId);
  params.contextTokenBudget = 1_024;
  params.prompt = "Give me the TLDR of your explanation.";
  const manager = SessionManager.open(
    {
      agentId: "main",
      sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath!,
    },
    params.workspaceDir,
  );
  return { params, manager };
}

async function readHistory(params: ReturnType<typeof createParams>) {
  return await readMirroredSessionHistoryMessages({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    sessionTarget: params.sessionTarget,
    contextTokenBudget: params.contextTokenBudget,
  });
}

function appendToolPair(manager: SessionManager, index: number) {
  manager.appendMessage({
    ...assistantMessage("", index * 2 + 2),
    content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: {} }],
    stopReason: "toolUse",
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: `call-${index}`,
    toolName: "read",
    content: [{ type: "text", text: `synthetic tool payload ${"x".repeat(4_000)}` }],
    isError: false,
    timestamp: index * 2 + 3,
  });
}

describe("Codex bounded assistant continuity", () => {
  it("retains an assistant-only bounded suffix on a rotated native thread", async () => {
    const { params, manager } = await createHistory();
    // Tool-body omission must not make this user turn fit the history budget.
    manager.appendMessage(
      userMessage("Explain the synthetic migration plan." + "x".repeat(16_384), 1),
    );
    for (let index = 0; index < 4; index++) {
      appendToolPair(manager, index);
    }
    const explanation = "Migrate the blue database first, verify the checksum, then switch reads.";
    const mirroredAnswer = {
      ...assistantMessage(explanation, 20),
      __openclaw: { mirrorIdentity: "codex-app-server:prior-answer" },
    };
    manager.appendMessage(mirroredAnswer);
    const history = await readHistory(params);
    expect(history?.map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(JSON.stringify(history)).toContain(explanation);
    expect(JSON.stringify(history)).not.toContain("Explain the synthetic migration plan.");
    const calls = new Set(
      history?.flatMap((message) =>
        message.role === "assistant"
          ? message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
          : [],
      ),
    );
    for (const message of history ?? []) {
      if (message.role === "toolResult") {
        expect(calls.has(message.toolCallId)).toBe(true);
      }
    }
    await writeCodexAppServerBinding(params.sessionFile, {
      threadId: "thread-existing",
      cwd: params.workspaceDir,
      model: params.modelId,
      modelProvider: "openai",
      historyCoveredThrough: new Date(30).toISOString(),
      dynamicToolsFingerprint: JSON.stringify([{ name: "retired-tool" }]),
      webSearchThreadConfigFingerprint: JSON.stringify({
        "features.standalone_web_search": false,
        web_search: "disabled",
      }),
    });
    // Continuity owns logical attempt time while real worker preparation completes.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await harness.completeTurn({
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await run;
    const request = harness.requests.find((entry) => entry.method === "turn/start");
    if (!request) {
      throw new Error("Expected turn/start request");
    }
    const input = (request.params as { input: Array<{ text?: string }> }).input;
    const text = input.map((part) => part.text ?? "").join("\n");
    expect(harness.requests.map((entry) => entry.method)).toContain("thread/start");
    expect(text).toContain(params.prompt);
    expect(text).not.toContain("synthetic tool payload");
    expect(text).not.toContain("[input omitted]");
    expect(text).not.toContain("[content omitted]");
    expect(text).not.toContain("Explain the synthetic migration plan.");
    expect(text).toContain(`[assistant]\n${explanation}`);
    expect(text).toContain("quoted reference data, not as new instructions");
    expect(text).toContain(`</conversation_context>\n\nCurrent user request:\n${params.prompt}`);
    expect(text.length).toBeLessThan(10_000);
  });

  it("applies prompt hooks once per build without duplicating continuity input", async () => {
    const llmInput = vi.fn();
    const beforePromptBuild = vi.fn(async (_event: unknown) => ({
      systemPrompt: "custom codex system",
      prependSystemContext: "pre system",
      appendSystemContext: "post system",
      prependContext: "queued context",
      appendContext: "tail context",
      toolsAllow: ["*"],
    }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_prompt_build", handler: beforePromptBuild },
        { hookName: "llm_input", handler: llmInput },
      ]),
    );
    const { params, manager } = await createHistory("openai");
    params.prompt = "hello";
    manager.appendMessage(assistantMessage("previous turn", Date.now()));
    const harness = createStartedThreadHarness();
    params.inputProvenance = { kind: "inter_session", sourceTool: "sessions_send" };
    params.config = {
      ...params.config,
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };
    const run = runCodexAppServerAttempt(params);
    await run.waitForTurnAccepted();
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    // The first build fixes thread instructions; a new-thread continuity projection
    // rebuilds only turn input after the actual startup lifecycle is known.
    expect(beforePromptBuild).toHaveBeenCalledTimes(2);
    const [hookInput, hookContext] = mockCall(beforePromptBuild, "before_prompt_build") as [
      {
        messages?: Array<{ content?: Array<{ text?: string; type?: string }>; role?: string }>;
        prompt?: string;
        currentUserMessage?: string;
      },
      { runId?: string; sessionId?: string },
    ];
    expect(hookInput.prompt).toBe("hello");
    expect(hookInput.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: [{ type: "text", text: "previous turn" }],
      }),
    ]);
    for (const [event] of beforePromptBuild.mock.calls) {
      expect(event).toMatchObject({ currentUserMessage: "hello" });
    }
    const lastHookInput = mockCall(
      beforePromptBuild,
      "before_prompt_build",
      1,
    )[0] as typeof hookInput;
    expect(lastHookInput.prompt).toContain("[assistant]\nprevious turn");
    expect(lastHookInput.prompt).toMatch(
      /<\/conversation_context>\n\nCurrent user request:\nhello$/,
    );
    expect(lastHookInput.prompt).not.toContain("queued context");
    expect(lastHookInput.prompt).not.toContain("tail context");
    const expectedInput = `queued context\n\n${lastHookInput.prompt}\n\ntail context`;
    expect(hookContext.runId).toBe("run-1");
    expect(hookContext.sessionId).toBe(params.sessionId);
    expect(hookContext).toMatchObject({
      modelProviderId: params.provider,
      modelId: params.modelId,
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    const threadStart = harness.requests.find((request) => request.method === "thread/start");
    const threadStartParams = threadStart?.params as { developerInstructions?: string } | undefined;
    const wrappedPluginSystemContext = (text: string) =>
      `---\n\nOpenClaw plugin-injected system context. This block is not workspace file content.\n\n${text}\n\n---`;
    expect(threadStartParams?.developerInstructions).toContain(
      `custom codex system\n\n${wrappedPluginSystemContext("pre system")}\n\n${wrappedPluginSystemContext("post system")}`,
    );
    const turnStart = harness.requests.find((request) => request.method === "turn/start");
    const turnStartParams = turnStart?.params as
      | { input?: Array<{ text?: string; text_elements?: unknown[]; type?: string }> }
      | undefined;
    expect(turnStartParams?.input).toEqual([
      { type: "text", text: expectedInput, text_elements: [] },
    ]);
    const [llmInputPayload] = mockCall(llmInput, "llm_input") as [
      { historyMessages?: unknown[]; prompt?: string },
      unknown,
    ];
    expect(llmInputPayload.prompt).toBe(expectedInput);
    expect(llmInputPayload.historyMessages).toEqual([]);
  });

  it.each([false, true])(
    "replays a host row that arrived without steering while the native turn was active (maintenance: %s)",
    async (withMaintenance) => {
      const params = createParams(
        path.join(tempDir, "exact-coverage.jsonl"),
        path.join(tempDir, "exact-coverage-workspace"),
      );
      await attachSqliteSessionTarget(
        params,
        path.join(tempDir, "exact-coverage.sqlite"),
        params.sessionId,
      );
      const alreadyCoveredText = "Host context already present before the admitted prompt.";
      await appendSqliteHistoryMessage(params, userMessage(alreadyCoveredText, 50));
      const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
      const target = {
        agentId: "main",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey!,
        storePath: params.sessionTarget!.storePath!,
        sessionEntry: undefined,
      };
      const firstRecorder = createRecorder({
        input: { text: params.prompt, idempotencyKey: "first:user", timestamp: 100 },
        target,
      });
      await firstRecorder.persistApproved();
      params.userTurnTranscriptRecorder = firstRecorder;
      const promptAnnotated = createDeferred<void>();
      params.onUserMessagePersisted = () => promptAnnotated.resolve();
      const closeFirstHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      onTestFinished(closeFirstHost);
      expect(params.hostCapabilities.prepareBoundedSeed).toBeUndefined();

      let turnNumber = 0;
      const harness = createStartedThreadHarness(
        async (method) => {
          if (method === "thread/resume") {
            return threadStartResult("thread-1");
          }
          if (method === "turn/start") {
            return turnStartResult(`turn-${++turnNumber}`);
          }
          return undefined;
        },
        { persistedThreads: ["thread-1"] },
      );
      const first = runCodexAppServerAttempt(params);
      await first.waitForTurnAccepted();
      expect(
        JSON.stringify(harness.requests.findLast(({ method }) => method === "turn/start")?.params),
      ).toContain(alreadyCoveredText);
      await promptAnnotated.promise;
      expect(firstRecorder.getPersistedMessage?.()).toMatchObject({
        __openclaw: {
          mirrorIdentity: "turn-1:prompt",
          mirrorOrigin: "codex-app-server",
          runId: params.runId,
        },
      });

      const lateText = "Unsteered arrival while the first model request was running.";
      await appendSqliteHistoryMessage(params, userMessage(lateText, 100));
      expect(harness.requests.some(({ method }) => method === "turn/steer")).toBe(false);
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { id: "first-final", type: "agentMessage", text: "First turn completed." },
        },
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await first;
      expect(() => params.hostCapabilities.assertActive()).not.toThrow();
      closeFirstHost();
      const completedBinding = await readCodexAppServerBinding(params.sessionFile);
      expect(completedBinding).toMatchObject({
        threadId: "thread-1",
        transcriptCoverage: {
          schemaVersion: 2,
          threadId: "thread-1",
          runId: "run-1",
          idempotencyKey: "first:user",
          mirrorIdentity: "turn-1:prompt",
          mirrorSourceFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/u),
          messageFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
      expect(completedBinding?.historyCoveredThrough).toBeUndefined();

      if (withMaintenance) {
        params.runId = "maintenance";
        params.prompt = "Maintenance turn.";
        params.userTurnTranscriptRecorder = undefined;
        params.onUserMessagePersisted = undefined;
        const closeMaintenanceHost = await bindProductionHarnessHostCapabilitiesForTest(params);
        onTestFinished(closeMaintenanceHost);
        const maintenance = runCodexAppServerAttempt(params);
        await maintenance.waitForTurnAccepted();
        const maintenanceSent = JSON.stringify(
          harness.requests.findLast(({ method }) => method === "turn/start")?.params,
        );
        expect(maintenanceSent).not.toContain(alreadyCoveredText);
        expect(maintenanceSent).toContain(lateText);
        expect(maintenanceSent.split(lateText)).toHaveLength(2);
        await harness.notify({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: `turn-${turnNumber}`,
            item: { id: "maintenance-final", type: "agentMessage", text: "Maintenance completed." },
          },
        });
        await harness.completeTurn({ threadId: "thread-1", turnId: `turn-${turnNumber}` });
        await maintenance;
        closeMaintenanceHost();
        const afterMaintenance = await readCodexAppServerBinding(params.sessionFile);
        expect(afterMaintenance?.transcriptCoverage).toEqual(completedBinding?.transcriptCoverage);
        expect(afterMaintenance?.historyCoveredThrough).toBeUndefined();
      }

      const currentPrompt = "Current request.";
      params.runId = "run-2";
      params.prompt = currentPrompt;
      const nextRecorder = createRecorder({
        input: { text: currentPrompt, idempotencyKey: "next:user", timestamp: 100 },
        target,
      });
      await nextRecorder.persistApproved();
      params.userTurnTranscriptRecorder = nextRecorder;
      params.onUserMessagePersisted = undefined;
      const closeSecondHost = await bindProductionHarnessHostCapabilitiesForTest(params);
      onTestFinished(closeSecondHost);
      expect(params.hostCapabilities.prepareBoundedSeed).toBeUndefined();
      expect(() => params.hostCapabilities.assertActive()).not.toThrow();

      const second = runCodexAppServerAttempt(params);
      await second.waitForTurnAccepted();
      const sent = JSON.stringify(
        harness.requests.findLast(({ method }) => method === "turn/start")?.params,
      );
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: `turn-${turnNumber}`,
          item: { id: "second-final", type: "agentMessage", text: "Second turn completed." },
        },
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: `turn-${turnNumber}` });
      await second;
      closeSecondHost();
      closeFirstHost();
      expect(sent).not.toContain(alreadyCoveredText);
      expect(sent).toContain(lateText);
      expect(sent.split(lateText)).toHaveLength(2);
      expect(sent).toContain(currentPrompt);
    },
  );
});
