// Codex tests cover attempt context plugin behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  hasCompletedBootstrapTurn,
  persistCompletedBootstrapTurn,
} from "openclaw/plugin-sdk/agent-bootstrap-runtime";
import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import {
  appendSqliteSessionTranscriptEventForTest,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  buildCodexWorkspaceBootstrapContext,
  buildCodexSystemPromptReport,
  readContextEngineThreadBootstrapProjection,
  readMirroredSessionHistoryMessages,
  renderCodexSkillsCollaborationInstructions,
  resolveContextEngineBootstrapProjectionDecision,
} from "./attempt-context.js";
import type { CodexDynamicToolSpec } from "./protocol.js";
import type { CodexAppServerContextEngineBinding } from "./session-binding.js";

const continuationTempDirs = new Set<string>();

afterEach(async () => {
  vi.restoreAllMocks();
  clearMemoryPluginState();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(
    [...continuationTempDirs].map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
  continuationTempDirs.clear();
});

async function createContinuationFixture() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-continuation-bootstrap-"));
  continuationTempDirs.add(tempDir);
  const workspaceDir = path.join(tempDir, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "workspace rules", "utf8");
  const sessionId = randomUUID();
  const sessionKey = `agent:main:${sessionId}`;
  const sessionTarget = {
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: path.join(tempDir, "sessions.json"),
  };
  await persistCompletedBootstrapTurn({ runId: "completed-bootstrap", sessionTarget });
  return { sessionId, sessionKey, sessionTarget, workspaceDir };
}

async function buildContinuationFixtureContext(
  fixture: Awaited<ReturnType<typeof createContinuationFixture>>,
) {
  return await buildCodexWorkspaceBootstrapContext({
    params: {
      runId: "continuation-run",
      sessionId: fixture.sessionId,
      sessionKey: fixture.sessionKey,
      sessionTarget: fixture.sessionTarget,
      trigger: "user",
      isCanonicalWorkspace: true,
      config: {
        agents: {
          defaults: {
            contextInjection: "continuation-skip",
            workspace: fixture.workspaceDir,
          },
        },
      },
    } as EmbeddedRunAttemptParams,
    resolvedWorkspace: fixture.workspaceDir,
    effectiveWorkspace: fixture.workspaceDir,
    sessionKey: fixture.sessionKey,
    sessionAgentId: "main",
    memoryToolNames: [],
    hasBootstrapFileAccess: true,
  });
}

describe("Codex app-server attempt context", () => {
  it("treats missing mirrored session history as empty without hook warning", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-attempt-context-history-"));
    const sessionFile = path.join(dir, "session.jsonl");
    try {
      await expect(
        readMirroredSessionHistoryMessages({
          sessionFile,
          sessionId: "codex-session",
          sessionKey: "codex-session",
        }),
      ).resolves.toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a run context report without deferred Codex dynamic tool schemas", () => {
    const tools = [
      {
        type: "function",
        name: "message",
        description: "Send a message.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
      },
      {
        type: "namespace",
        name: "openclaw",
        description: "",
        tools: [
          {
            type: "function",
            name: "web_search",
            description: "Search the web.",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
            deferLoading: true,
          },
        ],
      },
    ] as CodexDynamicToolSpec[];

    const report = buildCodexSystemPromptReport({
      attempt: {
        sessionId: "session-1",
        provider: "codex",
        modelId: "gpt-5.4-codex",
      } as EmbeddedRunAttemptParams,
      sessionKey: "agent:main:session-1",
      workspaceDir: path.join("tmp", "workspace"),
      developerInstructions: "test developer instructions",
      workspaceBootstrapContext: {
        bootstrapFiles: [],
        contextFiles: [],
        inheritsAgentWorkspace: false,
        promptContextFiles: [],
      },
      skillsPrompt: "",
      tools,
    });

    expect(report.source).toBe("run");
    expect(report.provider).toBe("codex");
    expect(report.model).toBe("gpt-5.4-codex");
    expect(report.systemPrompt.chars).toBeGreaterThan(0);
    expect(report.systemPrompt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.skills.hash).toMatch(/^[a-f0-9]{64}$/u);

    const message = report.tools.entries.find((tool) => tool.name === "message");
    const webSearch = report.tools.entries.find((tool) => tool.name === "web_search");
    expect(message?.schemaChars).toBeGreaterThan(0);
    expect(message?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(message?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaChars).toBe(0);
    expect(webSearch?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(webSearch?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.schemaChars).toBe(message?.schemaChars);
  });

  it("keeps MEMORY.md injected when sandbox effective workspace differs", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-memory-workspace-"));
    const sandboxWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-memory-sandbox-"));
    const memorySummary = "Sandboxed turns need bounded memory fallback.";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memorySummary);

    const context = await buildCodexWorkspaceBootstrapContext({
      params: {
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        config: {
          agents: {
            defaults: {
              workspace: workspaceDir,
            },
          },
        },
      } as EmbeddedRunAttemptParams,
      resolvedWorkspace: workspaceDir,
      effectiveWorkspace: sandboxWorkspaceDir,
      sessionKey: "agent:main:session-1",
      sessionAgentId: "main",
      memoryToolNames: ["memory_search", "memory_get"],
      ringZeroActive: false,
    });

    expect(context.memoryReferenceFiles).toEqual([]);
    expect(context.promptContext).toContain(memorySummary);
    expect(context.memoryToolRouted).toBe(false);
  });

  it("passes agent context to Codex memory collaboration guidance", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-memory-"));
    let observedContext:
      | { agentId?: string; agentSessionKey?: string; sandboxed?: boolean }
      | undefined;
    registerMemoryCapability("memory-core", {
      promptBuilder: (context) => {
        observedContext = context;
        return [
          "## Agent Memory",
          `agent=${context.agentId} session=${context.agentSessionKey}`,
          "",
        ];
      },
    });

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:marketing-agent:session-1",
          config: {
            agents: {
              defaults: { workspace: workspaceDir },
              list: [{ id: "marketing-agent", default: true, workspace: workspaceDir }],
            },
          },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        effectiveWorkspace: workspaceDir,
        sessionKey: "agent:marketing-agent:session-1",
        sessionAgentId: "marketing-agent",
        memoryToolNames: ["memory_search", "memory_get"],
        ringZeroActive: false,
        sandboxed: true,
      });

      expect(context.memoryToolRouted).toBe(true);
      expect(observedContext).toMatchObject({
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:session-1",
        sandboxed: true,
      });
      expect(context.memoryCollaborationInstructions).toContain(
        "agent=marketing-agent session=agent:marketing-agent:session-1",
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("inherits agent workspace instructions when Codex executes in another folder", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-agent-workspace-"));
    const executionDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-execution-workspace-"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Canonical agent instructions");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Canonical agent soul");
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Canonical agent memory");
    await fs.writeFile(path.join(executionDir, "AGENTS.md"), "Execution project instructions");

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:main:session-1",
        sessionAgentId: "main",
        memoryToolNames: ["memory_search", "memory_get"],
        ringZeroActive: false,
      });

      expect(context.threadDeveloperInstructions).toContain("Canonical agent instructions");
      expect(context.threadDeveloperInstructions).toContain(
        "OpenClaw Agent Workspace Instructions",
      );
      expect(context.threadDeveloperInstructions).toContain(path.join(workspaceDir, "AGENTS.md"));
      expect(context.threadDeveloperInstructions).not.toContain("Canonical agent soul");
      expect(context.threadDeveloperInstructions).not.toContain("Execution project instructions");
      expect(context.threadDeveloperInstructions).not.toContain(
        path.join(executionDir, "AGENTS.md"),
      );
      expect(context.turnScopedDeveloperInstructions).toContain("Canonical agent soul");
      expect(context.turnScopedDeveloperInstructions).not.toContain("Canonical agent instructions");
      expect(context.memoryToolRouted).toBe(true);
      expect(context.promptContext).toBeUndefined();
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(executionDir, { recursive: true, force: true });
    }
  });

  it("keeps ambient workspace instructions out of overlapping ring-zero restrictions", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ring-zero-workspace-"));
    const executionDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-ring-zero-execution-"));
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "Ambient workspace instructions");

    try {
      const context = await buildCodexWorkspaceBootstrapContext({
        params: {
          sessionId: "session-1",
          sessionKey: "agent:openclaw:session-1",
          toolsAllow: ["openclaw"],
          pluginHarnessToolPolicyRestricted: true,
          config: { agents: { defaults: { workspace: workspaceDir } } },
        } as EmbeddedRunAttemptParams,
        resolvedWorkspace: workspaceDir,
        executionWorkspace: executionDir,
        effectiveWorkspace: executionDir,
        sessionKey: "agent:openclaw:session-1",
        sessionAgentId: "openclaw",
        memoryToolNames: [],
        ringZeroActive: true,
      });

      expect(context.threadDeveloperInstructions).toBeUndefined();
      expect(context.threadDeveloperInstructionFiles).toEqual([]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(executionDir, { recursive: true, force: true });
    }
  });

  it("injects newly pending BOOTSTRAP.md despite an older completion marker", async () => {
    const fixture = await createContinuationFixture();
    await fs.writeFile(
      path.join(fixture.workspaceDir, "BOOTSTRAP.md"),
      "complete the new onboarding ritual",
      "utf8",
    );

    const context = await buildContinuationFixtureContext(fixture);

    expect(context.contextFiles.map((file) => path.basename(file.path))).toContain("BOOTSTRAP.md");
    expect(context.shouldRecordCompletedBootstrapTurn).toBe(true);
  });

  it("skips ordinary continuation context after a completion marker", async () => {
    const fixture = await createContinuationFixture();

    expect(await hasCompletedBootstrapTurn(fixture.sessionTarget)).toBe(true);
    await expect(buildContinuationFixtureContext(fixture)).resolves.toMatchObject({
      bootstrapFiles: [],
      contextFiles: [],
      shouldRecordCompletedBootstrapTurn: false,
    });
  });

  it.each(["compaction", "reset"] as const)(
    "reinjects context after a %s boundary invalidates the completion marker",
    async (boundaryType) => {
      const fixture = await createContinuationFixture();
      const boundaryId = `${boundaryType}-${randomUUID()}`;
      await appendSqliteSessionTranscriptEventForTest({
        ...fixture.sessionTarget,
        event:
          boundaryType === "compaction"
            ? {
                type: "compaction",
                id: boundaryId,
                parentId: null,
                timestamp: new Date().toISOString(),
                summary: "trimmed",
                firstKeptEntryId: boundaryId,
                tokensBefore: 10,
              }
            : {
                type: "reset",
                id: boundaryId,
                parentId: null,
                timestamp: new Date().toISOString(),
                reason: "new",
                firstKeptEntryId: boundaryId,
              },
      });

      expect(await hasCompletedBootstrapTurn(fixture.sessionTarget)).toBe(false);
      const context = await buildContinuationFixtureContext(fixture);
      expect(context.contextFiles.map((file) => path.basename(file.path))).toContain("AGENTS.md");
      expect(context.shouldRecordCompletedBootstrapTurn).toBe(true);
    },
  );

  it("reads and compares thread-bootstrap context-engine projections", () => {
    const projection = readContextEngineThreadBootstrapProjection({
      mode: "thread_bootstrap",
      epoch: " epoch-1 ",
      fingerprint: " fingerprint-1 ",
    });
    expect(projection).toEqual({
      mode: "thread_bootstrap",
      epoch: "epoch-1",
      fingerprint: "fingerprint-1",
    });

    const expectedBinding = {
      schemaVersion: 1,
      engineId: "lossless",
      policyFingerprint: "policy-v1",
      projection: {
        schemaVersion: 1,
        mode: "thread_bootstrap",
        epoch: "epoch-1",
        fingerprint: "fingerprint-1",
      },
    } satisfies CodexAppServerContextEngineBinding;
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "same-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        projection: projection!,
        dynamicToolsFingerprint: "same-tools",
      }),
    ).toEqual({
      project: false,
      reason: "matching-thread-bootstrap-binding",
    });
    expect(
      resolveContextEngineBootstrapProjectionDecision({
        startupBinding: {
          threadId: "thread-existing",
          dynamicToolsFingerprint: "old-tools",
          contextEngine: expectedBinding,
        } as never,
        expectedBinding,
        projection: projection!,
        dynamicToolsFingerprint: "new-tools",
      }),
    ).toEqual({
      project: true,
      reason: "dynamic-tools-mismatch",
    });
  });

  it("stitches watched-session context into the per-turn OpenClaw prompt context", () => {
    const attempt = { config: {} } as EmbeddedRunAttemptParams;

    expect(
      buildCodexOpenClawPromptContext({
        params: attempt,
        watchedSessionsContext: [
          "## Watched Sessions",
          "- agent:main:telegram:group:beta — Family group",
        ].join("\n"),
      }),
    ).toContain("## Watched Sessions");

    // No ambient watches (and no state) must render nothing, not an empty section.
    expect(
      buildCodexWatchedSessionsContext({
        attempt,
        dynamicTools: [
          {
            type: "function",
            name: "sessions_history",
            description: "history",
            inputSchema: {},
          },
        ],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);

    // Lightweight cron turns keep the runtime context byte-for-byte untouched.
    expect(
      buildCodexWatchedSessionsContext({
        attempt: {
          config: {},
          bootstrapContextMode: "lightweight",
          bootstrapContextRunKind: "cron",
        } as EmbeddedRunAttemptParams,
        dynamicTools: [],
        sessionKey: "agent:codex-test:main",
      }),
    ).toBe(undefined);
  });

  it("omits broad OpenClaw context from exact memory flush turns", () => {
    const attempt = {
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-08-12.md",
    } as EmbeddedRunAttemptParams;

    expect(
      buildCodexOpenClawPromptContext({
        params: attempt,
        workspacePromptContext: "large workspace context",
        watchedSessionsContext: "large watched-session context",
      }),
    ).toBeUndefined();
    expect(
      buildCodexWatchedSessionsContext({
        attempt,
        dynamicTools: [],
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
    expect(
      renderCodexSkillsCollaborationInstructions({
        attempt,
        skillsPrompt: "large skill catalog",
      }),
    ).toBeUndefined();
  });
});
