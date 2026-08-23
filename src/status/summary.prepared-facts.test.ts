import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";

const acpMocks = vi.hoisted(() => ({
  readAcpSessionMeta: vi.fn(),
  readAcpSessionMetaBatch: vi.fn(),
}));
const modelSelectionMocks = vi.hoisted(() => ({
  classifyCliProvider: vi.fn(),
  isCliProvider: vi.fn(),
  prepareCliProviderClassifier: vi.fn(),
}));
const pluginMetadataMocks = vi.hoisted(() => ({
  resolvePluginMetadataSnapshotRuntime: vi.fn(),
}));
const staticCatalogMocks = vi.hoisted(() => ({
  createBundledProviderStaticCatalogContextResolver: vi.fn(),
  createBundledStaticCatalogModelResolver: vi.fn(),
  resolveManifestModel: vi.fn(),
  resolveProviderContext: vi.fn(),
}));
const sessionStoreMocks = vi.hoisted(() => ({
  listSessionEntriesReadOnly: vi.fn(),
  resolveSqliteTargetFromSessionStorePath: vi.fn(),
}));

vi.mock("../acp/runtime/session-meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/runtime/session-meta.js")>()),
  readAcpSessionMeta: acpMocks.readAcpSessionMeta,
  readAcpSessionMetaBatch: acpMocks.readAcpSessionMetaBatch,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  isCliProvider: modelSelectionMocks.isCliProvider,
  prepareCliProviderClassifier: modelSelectionMocks.prepareCliProviderClassifier,
}));

vi.mock("../plugins/plugin-metadata-snapshot.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.runtime.js")>()),
  resolvePluginMetadataSnapshotRuntime: pluginMetadataMocks.resolvePluginMetadataSnapshotRuntime,
}));

vi.mock("../agents/embedded-agent-runner/model.static-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../agents/embedded-agent-runner/model.static-catalog.js")
  >()),
  createBundledProviderStaticCatalogContextResolver:
    staticCatalogMocks.createBundledProviderStaticCatalogContextResolver,
  createBundledStaticCatalogModelResolver:
    staticCatalogMocks.createBundledStaticCatalogModelResolver,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    listSessionEntriesReadOnly: (
      ...args: Parameters<typeof actual.listSessionEntriesReadOnly>
    ): ReturnType<typeof actual.listSessionEntriesReadOnly> =>
      sessionStoreMocks.listSessionEntriesReadOnly(...args) ??
      actual.listSessionEntriesReadOnly(...args),
  };
});

vi.mock("../config/sessions/session-sqlite-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/sessions/session-sqlite-target.js")>();
  return {
    ...actual,
    resolveSqliteTargetFromSessionStorePath: (
      ...args: Parameters<typeof actual.resolveSqliteTargetFromSessionStorePath>
    ): ReturnType<typeof actual.resolveSqliteTargetFromSessionStorePath> =>
      sessionStoreMocks.resolveSqliteTargetFromSessionStorePath(...args) ??
      actual.resolveSqliteTargetFromSessionStorePath(...args),
  };
});

import { getStatusSummary } from "./summary.js";

function createMetadataSnapshot(id: string): PluginMetadataSnapshot {
  return {
    configFingerprint: id,
    manifestRegistry: { plugins: [] },
    plugins: [],
  } as unknown as PluginMetadataSnapshot;
}

function createConfig(stateDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "codex-cli/gpt-5",
        systemAgent: { agentId: "main" },
      },
      list: [{ id: "main", default: true }, { id: "ops" }],
    },
    session: { store: path.join(stateDir, "agents", "{agentId}", "sessions.json") },
  };
}

async function seedSessions(config: OpenClawConfig): Promise<void> {
  for (const [index, agentId] of ["main", "ops"].entries()) {
    const storePath = resolveSessionStorePathCore(config.session?.store, { agentId });
    await upsertSessionEntryCore(
      { agentId, sessionKey: `agent:${agentId}:main`, storePath },
      {
        model: "gpt-5",
        modelProvider: "codex-cli",
        sessionId: `${agentId}-session`,
        updatedAt: 10 + index,
      },
    );
  }
  closeOpenClawAgentDatabasesForTest();
}

beforeEach(() => {
  for (const mock of Object.values(acpMocks)) {
    mock.mockReset();
  }
  for (const mock of Object.values(modelSelectionMocks)) {
    mock.mockReset();
  }
  for (const mock of Object.values(pluginMetadataMocks)) {
    mock.mockReset();
  }
  for (const mock of Object.values(staticCatalogMocks)) {
    mock.mockReset();
  }
  for (const mock of Object.values(sessionStoreMocks)) {
    mock.mockReset();
  }
  acpMocks.readAcpSessionMetaBatch.mockReturnValue(new Map());
  modelSelectionMocks.classifyCliProvider.mockReturnValue(true);
  modelSelectionMocks.prepareCliProviderClassifier.mockReturnValue(
    modelSelectionMocks.classifyCliProvider,
  );
  staticCatalogMocks.createBundledStaticCatalogModelResolver.mockReturnValue(
    staticCatalogMocks.resolveManifestModel,
  );
  staticCatalogMocks.createBundledProviderStaticCatalogContextResolver.mockReturnValue(
    staticCatalogMocks.resolveProviderContext,
  );
  staticCatalogMocks.resolveProviderContext.mockResolvedValue(undefined);
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("getStatusSummary prepared facts", () => {
  it("prepares one metadata generation and one session-runtime batch per summary", async () => {
    await withStateDirEnv("openclaw-status-prepared-facts-", async ({ stateDir }) => {
      const config = createConfig(stateDir);
      const metadataSnapshot = createMetadataSnapshot("generation-a");
      pluginMetadataMocks.resolvePluginMetadataSnapshotRuntime.mockReturnValue(metadataSnapshot);
      await seedSessions(config);

      const summary = await getStatusSummary({
        config,
        hostDesktopStatus: { enabled: false, port: 5900, state: "disabled" },
        includeChannelSummary: false,
      });

      expect(summary.sessions.count).toBe(2);
      expect(pluginMetadataMocks.resolvePluginMetadataSnapshotRuntime).toHaveBeenCalledTimes(1);
      expect(staticCatalogMocks.createBundledStaticCatalogModelResolver).toHaveBeenCalledOnce();
      expect(staticCatalogMocks.createBundledStaticCatalogModelResolver).toHaveBeenCalledWith({
        cfg: config,
        includeRuntimeDiscovery: true,
        metadataSnapshot,
      });
      expect(
        staticCatalogMocks.createBundledProviderStaticCatalogContextResolver,
      ).toHaveBeenCalledOnce();
      expect(
        staticCatalogMocks.createBundledProviderStaticCatalogContextResolver,
      ).toHaveBeenCalledWith({ cfg: config, metadataSnapshot });
      expect(modelSelectionMocks.prepareCliProviderClassifier).toHaveBeenCalledOnce();
      expect(modelSelectionMocks.prepareCliProviderClassifier).toHaveBeenCalledWith(config);
      expect(acpMocks.readAcpSessionMetaBatch).toHaveBeenCalledOnce();
      expect(acpMocks.readAcpSessionMetaBatch).toHaveBeenCalledWith({
        cfg: config,
        entries: expect.arrayContaining([
          expect.objectContaining({ agentId: "main" }),
          expect.objectContaining({ agentId: "ops" }),
        ]),
        repairLegacyRows: false,
      });
      expect(acpMocks.readAcpSessionMetaBatch.mock.calls[0]?.[0].entries).toHaveLength(2);
      expect(modelSelectionMocks.classifyCliProvider).toHaveBeenCalled();
      expect(modelSelectionMocks.isCliProvider).not.toHaveBeenCalled();
      expect(acpMocks.readAcpSessionMeta).not.toHaveBeenCalled();
    });
  });

  it("uses a replacement metadata generation on the next standalone summary", async () => {
    await withStateDirEnv("openclaw-status-metadata-generation-", async ({ stateDir }) => {
      const config = createConfig(stateDir);
      const firstSnapshot = createMetadataSnapshot("generation-a");
      const replacementSnapshot = createMetadataSnapshot("generation-b");
      pluginMetadataMocks.resolvePluginMetadataSnapshotRuntime
        .mockReturnValueOnce(firstSnapshot)
        .mockReturnValueOnce(replacementSnapshot);

      for (const expectedSnapshot of [firstSnapshot, replacementSnapshot]) {
        await getStatusSummary({
          config,
          hostDesktopStatus: { enabled: false, port: 5900, state: "disabled" },
          includeChannelSummary: false,
        });
        expect(staticCatalogMocks.createBundledStaticCatalogModelResolver).toHaveBeenLastCalledWith(
          {
            cfg: config,
            includeRuntimeDiscovery: true,
            metadataSnapshot: expectedSnapshot,
          },
        );
      }

      expect(pluginMetadataMocks.resolvePluginMetadataSnapshotRuntime).toHaveBeenCalledTimes(2);
      expect(staticCatalogMocks.createBundledStaticCatalogModelResolver).toHaveBeenCalledTimes(2);
      expect(
        staticCatalogMocks.createBundledProviderStaticCatalogContextResolver,
      ).toHaveBeenCalledTimes(2);
    });
  });

  it("uses the fixed-store owner and model for a bare aggregate ACP session", async () => {
    await withStateDirEnv("openclaw-status-bare-acp-owner-", async ({ stateDir }) => {
      const sharedStorePath = path.join(stateDir, "shared-sessions.json");
      const sharedDatabasePath = path.join(stateDir, "shared-openclaw-agent.sqlite");
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "codex-cli/gpt-5",
            sessionStore: { agentId: "ops" },
            systemAgent: { agentId: "main" },
          },
          list: [
            { id: "main", default: true },
            { id: "ops", model: "anthropic/claude-sonnet-4-6" },
          ],
        },
        session: { store: sharedStorePath },
      };
      const metadataSnapshot = createMetadataSnapshot("generation-shared");
      pluginMetadataMocks.resolvePluginMetadataSnapshotRuntime.mockReturnValue(metadataSnapshot);
      let aggregateEntry: object | undefined;
      sessionStoreMocks.listSessionEntriesReadOnly.mockImplementation(
        (scope?: { agentId?: string }) => {
          const entry = {
            sessionId: `bare-${scope?.agentId ?? "aggregate"}`,
            updatedAt: 50,
          };
          if (!scope?.agentId) {
            aggregateEntry = entry;
          }
          return [{ entry, sessionKey: "acp:legacy" }];
        },
      );
      sessionStoreMocks.resolveSqliteTargetFromSessionStorePath.mockImplementation(
        (_storePath: string, options?: { agentId?: string }) => ({
          agentId: options?.agentId ?? "ops",
          ownerSource: "persisted",
          path: sharedDatabasePath,
          unsuffixedOwnerAgentId: "ops",
        }),
      );
      acpMocks.readAcpSessionMetaBatch.mockImplementation(
        (params: { entries: Array<{ agentId?: string; entry: object; sessionKey: string }> }) => {
          const result = new Map<object, object | undefined>();
          for (const item of params.entries) {
            if (
              item.entry === aggregateEntry &&
              item.agentId === "ops" &&
              item.sessionKey === "acp:legacy"
            ) {
              result.set(item.entry, {
                agent: "codex",
                backend: "acpx",
                lastActivityAt: 50,
                mode: "persistent",
                runtimeSessionName: "legacy-acp",
                state: "idle",
              });
            }
          }
          return result;
        },
      );

      const summary = await getStatusSummary({
        config,
        hostDesktopStatus: { enabled: false, port: 5900, state: "disabled" },
        includeChannelSummary: false,
      });

      expect(summary.sessions.count).toBe(1);
      expect(summary.sessions.recent).toEqual([
        expect.objectContaining({
          agentId: "ops",
          configuredModel: "anthropic/claude-sonnet-4-6",
          key: "acp:legacy",
          runtime: "acpx",
          selectedModel: "anthropic/claude-sonnet-4-6",
        }),
      ]);
      expect(acpMocks.readAcpSessionMetaBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({
              agentId: "ops",
              entry: aggregateEntry,
              sessionKey: "acp:legacy",
            }),
          ]),
        }),
      );
    });
  });
});
