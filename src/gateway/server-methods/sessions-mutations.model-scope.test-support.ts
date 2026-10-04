import { expect, it, vi, type Mock } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import * as acpMetadata from "../../acp/runtime/session-meta-readonly.js";
import { upsertAcpSessionMeta } from "../../acp/runtime/session-meta-write.js";
import { isSubagentSessionFromEntry } from "../../agents/subagents/spawn/subagent-depth-policy.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  getOpenIncognitoAgentDatabase,
} from "../../state/openclaw-agent-db-lifecycle.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createGatewaySession } from "../session-create-service.js";
import * as lifecyclePreparation from "../session-lifecycle-preparation.js";
import { withAgentSessionModelPatchOrigin } from "../session-model-patch-origin.js";
import * as patchHooks from "../session-patch-hooks.js";
import * as sessionEvents from "./session-change-event.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

type ScopeTestRequest = {
  client: GatewayClient & { invalidated: boolean };
  context: GatewayRequestContext;
};

export function registerSessionModelScopeTests(support: {
  getConfig: () => OpenClawConfig;
  getPersistedConfig: () => OpenClawConfig | undefined;
  configMutation: Mock;
  catalogSnapshot: () => Awaited<
    ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>
  >;
  patchSession: (params: Record<string, unknown>) => Promise<Parameters<RespondFn>>;
  createRequest: () => ScopeTestRequest;
  patchManySessions: (
    params: Record<string, unknown>,
    request?: ScopeTestRequest,
  ) => Promise<Parameters<RespondFn>>;
}): void {
  const { catalogSnapshot, patchSession } = support;
  for (const method of ["patch", "patchMany"] as const) {
    it.each([
      {
        name: "parent-only delegated ACP without depth",
        entry: { parentSessionKey: "agent:main:main" },
        hasMeta: true,
        delegated: true,
      },
      {
        name: "parent-only delegated ACP with zero depth",
        entry: { spawnDepth: 0, parentSessionKey: "agent:main:main" },
        hasMeta: true,
        delegated: true,
      },
      {
        name: "independent ACP with canonical metadata",
        entry: { spawnDepth: 0 },
        hasMeta: true,
        delegated: false,
      },
      {
        name: "navigation parent without ACP metadata",
        entry: { spawnDepth: 0, parentSessionKey: "agent:main:main" },
        hasMeta: false,
        delegated: false,
      },
    ] as const)(
      `uses canonical stored ACP lineage for $name through ${method}`,
      async (scenario) => {
        const cfg = support.getConfig();
        cfg.agents!.defaults!.modelSelectionScope = "global";
        const key = `agent:main:acp:stored-${method}-${scenario.name.replaceAll(" ", "-")}`;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          { sessionId: key, updatedAt: 1, ...scenario.entry },
        );
        if (scenario.hasMeta) {
          // Modern spawn stamps depth/lineage too; the canonical persisted
          // metadata contract also retains parent-only ACP entries.
          await upsertAcpSessionMeta({
            cfg,
            agentId: "main",
            sessionKey: key,
            skipMaintenance: true,
            mutate: () => ({
              backend: "fixture-acp",
              agent: "main",
              runtimeSessionName: key,
              mode: "persistent",
              state: "idle",
              lastActivityAt: 1,
            }),
          });
        }
        const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
        expect(entry).toBeDefined();
        expect(entry).not.toHaveProperty("acp");
        const [meta] = await acpMetadata.readAcpSessionMetaForEntries({
          cfg,
          entries: [{ agentId: "main", sessionKey: key, entry }],
        });
        if (scenario.hasMeta) {
          expect(meta).toMatchObject({ backend: "fixture-acp", runtimeSessionName: key });
        } else {
          expect(meta).toBeNull();
        }
        expect(isSubagentSessionFromEntry(key, entry)).toBe(false);
        expect(isSubagentSessionFromEntry(key, entry, meta)).toBe(scenario.delegated);

        const model = "openai/gpt-5.6-sol";
        const response =
          method === "patch"
            ? await patchSession({ key, model })
            : await support.patchManySessions({ targets: [{ key }], patch: { model } });
        expect(response[0]).toBe(true);
        if (method === "patchMany") {
          expect(response[1]).toMatchObject({ outcomes: [{ ok: true, key }] });
        }
        expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
          providerOverride: "openai",
          modelOverride: "gpt-5.6-sol",
        });
        if (scenario.delegated) {
          expect(support.configMutation).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() =>
            expect(support.getPersistedConfig()?.agents?.defaults?.model).toBe(model),
          );
          expect(support.configMutation).toHaveBeenCalledOnce();
        }
      },
    );
  }

  const mixedCases = (["durable", "incognito"] as const).flatMap((storage) =>
    (
      [
        "unchanged",
        "revoked caller",
        "revoked while acquiring facts",
        "rotated created root",
        "failed metadata",
      ] as const
    ).map((change) => ({ storage, change })),
  );
  it.each([
    ...mixedCases,
    { storage: "incognito" as const, change: "replaced RAM namespace" as const },
  ])(
    "keeps committed mixed-batch effects ordered with $storage creation: $change",
    async ({ storage, change }) => {
      const cfg = support.getConfig();
      cfg.agents!.defaults!.modelSelectionScope = "global";
      const keys = ["linked", "existing", "created"].map(
        (kind) =>
          `agent:main:dashboard:${storage === "incognito" && kind === "created" ? "incognito-" : ""}metadata-${storage}-${kind}-${change.toLowerCase().replaceAll(" ", "-")}`,
      );
      for (const [index, key] of keys.slice(0, 2).entries()) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          {
            sessionId: key,
            updatedAt: 1,
            spawnDepth: 0,
            ...(index === 0 ? { parentSessionKey: "agent:main:main" } : {}),
          },
        );
      }
      expect(loadSessionEntry({ agentId: "main", sessionKey: keys[2]! })).toBeUndefined();
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const pauseOnFacts = change === "revoked while acquiring facts";
      if (pauseOnFacts) {
        const prepare = lifecyclePreparation.prepareGatewaySessionLifecycleTargets;
        vi.spyOn(lifecyclePreparation, "prepareGatewaySessionLifecycleTargets").mockImplementation(
          (params) => {
            const custody = prepare(params);
            if (params.targets.length !== 1 || !params.targets[0]?.entry?.sessionId) {
              return custody;
            }
            return {
              ...custody,
              preparations: custody.preparations.map(async (preparing) => {
                const facts = await preparing;
                entered.resolve();
                await resume.promise;
                return facts;
              }),
            };
          },
        );
      }
      const read = acpMetadata.readAcpSessionMetaForEntries;
      const reader = vi
        .spyOn(acpMetadata, "readAcpSessionMetaForEntries")
        .mockImplementation(async (params, options) => {
          const metadata = await read(params, options);
          if (options?.current && !pauseOnFacts) {
            entered.resolve();
            await resume.promise;
            if (change === "failed metadata") {
              throw new Error("synthetic ACP metadata worker failure");
            }
          }
          return metadata;
        });
      const hooks = vi.spyOn(patchHooks, "triggerSessionPatchHook");
      const events = vi.spyOn(sessionEvents, "emitSessionsChanged");
      const request = support.createRequest();
      const pending = support.patchManySessions(
        { targets: keys.map((key) => ({ key })), patch: { model: "openai/gpt-5.6-sol" } },
        request,
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "ACP preparation was not reached",
        );
        for (const key of keys) {
          expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
            providerOverride: "openai",
            modelOverride: "gpt-5.6-sol",
          });
        }
        expect(support.configMutation).not.toHaveBeenCalled();
        if (change === "revoked caller" || pauseOnFacts) {
          request.client.invalidated = true;
        } else if (change === "rotated created root") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: keys[2]! },
            { sessionId: "replacement-created-lifecycle", updatedAt: 2 },
          );
        } else if (change === "replaced RAM namespace") {
          const scope = { agentId: "main", sessionKey: keys[2]! };
          const entry = loadSessionEntry(scope)!;
          const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
          const original = getOpenIncognitoAgentDatabase("main", storePath);
          expect(original).toBeDefined();
          await closeOpenClawAgentDatabaseByPathAsync(storePath, "main");
          await upsertSessionEntryCore(scope, entry);
          expect(getOpenIncognitoAgentDatabase("main", storePath)).not.toBe(original);
          expect(loadSessionEntry(scope)?.sessionId).toBe(entry.sessionId);
        }
      } finally {
        resume.resolve();
        await pending.catch(() => {});
      }
      const response = await pending;
      expect(response[0]).toBe(true);
      expect(response[1]).toMatchObject({ outcomes: keys.map((key) => ({ key, ok: true })) });
      expect(reader).toHaveBeenCalledTimes(pauseOnFacts ? 0 : 1);
      if (!pauseOnFacts) {
        expect(reader.mock.calls[0]?.[0].entries.map((entry) => entry.sessionKey)).toEqual([
          keys[0],
        ]);
      }
      expect(hooks.mock.calls.map(([params]) => params.sessionKey)).toEqual(keys);
      expect(events.mock.calls.map(([, event]) => event.sessionKey)).toEqual(keys);
      expect(support.configMutation).toHaveBeenCalledTimes(
        change === "unchanged" ? 3 : change === "revoked caller" || pauseOnFacts ? 0 : 2,
      );
      if (change === "rotated created root") {
        expect(loadSessionEntry({ agentId: "main", sessionKey: keys[2]! })?.sessionId).toBe(
          "replacement-created-lifecycle",
        );
      }
    },
  );

  it.each([
    { name: "ordinary global root", scope: "global", linked: false, persists: true },
    { name: "session-only linked selection", scope: "session", linked: true, persists: false },
  ] as const)("does not query ACP metadata for $name", async (scenario) => {
    const cfg = support.getConfig();
    cfg.agents!.defaults!.modelSelectionScope = scenario.scope;
    const key = `agent:main:dashboard:metadata-unneeded-${scenario.scope}`;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      {
        sessionId: key,
        updatedAt: 1,
        spawnDepth: 0,
        ...(scenario.linked ? { parentSessionKey: "agent:main:main" } : {}),
      },
    );
    const reader = vi.spyOn(acpMetadata, "readAcpSessionMetaForEntries");
    expect(
      (
        await support.patchManySessions({
          targets: [{ key }],
          patch: { model: "openai/gpt-5.6-sol" },
        })
      )[0],
    ).toBe(true);
    expect(reader).not.toHaveBeenCalled();
    expect(support.configMutation).toHaveBeenCalledTimes(scenario.persists ? 1 : 0);
  });

  it.each([
    { name: "agent-origin", key: "agent:main:dm:agent-model", origin: true, metadata: {} },
    { name: "subagent key", key: "agent:main:subagent:child-model", metadata: {} },
    { name: "spawn depth", key: "agent:main:dm:spawn-depth", metadata: { spawnDepth: 1 } },
    {
      name: "spawned-by metadata",
      key: "agent:main:dm:spawned-by",
      metadata: { spawnedBy: "agent:main:main" },
    },
    {
      name: "delegated ACP",
      key: "agent:main:acp:child-model",
      metadata: { spawnDepth: 1, spawnedBy: "agent:main:main" },
    },
  ] as const)("keeps $name model patches in their session under global scope", async (scenario) => {
    const cfg = support.getConfig();
    cfg.agents!.defaults!.modelSelectionScope = "global";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: scenario.key },
      { sessionId: `session-${scenario.name}`, updatedAt: 1, ...scenario.metadata },
    );

    const patch = () => patchSession({ key: scenario.key, model: "openai/gpt-5.6-sol" });
    const response =
      "origin" in scenario ? await withAgentSessionModelPatchOrigin(patch) : await patch();

    expect(response[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey: scenario.key })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
    });
    expect(support.configMutation).not.toHaveBeenCalled();
  });

  it.each(["agent", "global"] as const)(
    "preserves configured %s writes for a created dashboard root with a navigation parent",
    async (scope) => {
      const cfg = support.getConfig();
      cfg.agents!.defaults!.modelSelectionScope = scope;
      const sessionKey = `agent:main:dashboard:sticky-root-${scope}`;
      const result = await createGatewaySession({
        cfg,
        key: sessionKey,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
        loadGatewayModelCatalogSnapshot: async () => catalogSnapshot(),
      });
      expect(result).toMatchObject({
        ok: true,
        entry: { spawnDepth: 0, parentSessionKey: "agent:main:main" },
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey })?.spawnedBy).toBeUndefined();

      expect((await patchSession({ key: sessionKey, model: "openai/gpt-5.6-sol" }))[0]).toBe(true);
      expect(loadSessionEntry({ agentId: "main", sessionKey })).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      await vi.waitFor(() => expect(support.getPersistedConfig()).toBeDefined());
      expect(support.configMutation).toHaveBeenCalledOnce();
      expect(
        scope === "global"
          ? support.getPersistedConfig()?.agents?.defaults?.model
          : support.getPersistedConfig()?.agents?.entries?.main?.model,
      ).toBe("openai/gpt-5.6-sol");
    },
  );

  it.each([
    {
      name: "legacy navigation parent",
      key: "agent:main:dashboard:legacy-root",
      metadata: { parentSessionKey: "agent:main:main" },
    },
    { name: "independent ACP", key: "agent:main:acp:operator-root", metadata: { spawnDepth: 0 } },
    {
      name: "parent-linked independent ACP",
      key: "agent:main:acp:parented-root",
      metadata: { spawnDepth: 0, parentSessionKey: "agent:main:main" },
    },
  ] as const)("preserves configured global writes for $name", async (scenario) => {
    const cfg = support.getConfig();
    cfg.agents!.defaults!.modelSelectionScope = "global";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: scenario.key },
      { sessionId: `session-${scenario.name}`, updatedAt: 1, ...scenario.metadata },
    );

    expect((await patchSession({ key: scenario.key, model: "openai/gpt-5.6-sol" }))[0]).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey: scenario.key })).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
    });
    await vi.waitFor(() =>
      expect(support.getPersistedConfig()?.agents?.defaults?.model).toBe("openai/gpt-5.6-sol"),
    );
    expect(support.configMutation).toHaveBeenCalledOnce();
  });
}
