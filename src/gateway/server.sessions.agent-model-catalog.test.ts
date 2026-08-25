import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSelectedGlobalSessionStore } = setupGatewaySessionsHandlerTestHarness();

const mainModel = { id: "main-only", name: "Main Model", provider: "main-provider" };
const workModel = { id: "work-only", name: "Work Model", provider: "work-provider" };

function createAgentModelCatalogLoader(ownerConfig?: OpenClawConfig) {
  return vi.fn(async (params?: { agentId?: string }) => {
    const agentId = params?.agentId === "work" ? "work" : "main";
    const entries = agentId === "work" ? [workModel] : [mainModel];
    const config = ownerConfig ?? (await getGatewayConfigModule()).getRuntimeConfig();
    return {
      agentDir: `/tmp/${agentId}/agent`,
      agentId,
      catalogComplete: true,
      config,
      entries,
      routeVariants: entries,
      workspaceDir: `/tmp/${agentId}/workspace`,
    };
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

test.each([
  { label: "explicit agent", agentId: "work" },
  { label: "agent-qualified session", agentId: undefined },
])("sessions.patch loads the $label model catalog", async ({ agentId }) => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  const key = "agent:work:dashboard:catalog-owner-patch";
  await writeSessionStore({
    agentId: "work",
    storePath: workStorePath,
    entries: { [key]: sessionStoreEntry("work-catalog-patch") },
  });
  const loadGatewayModelCatalogSnapshot = createAgentModelCatalogLoader();

  const patched = await directSessionReq<{
    entry?: { modelOverride?: string; providerOverride?: string };
  }>(
    "sessions.patch",
    {
      key,
      ...(agentId ? { agentId } : {}),
      model: "work-provider/work-only",
    },
    { context: { loadGatewayModelCatalogSnapshot } },
  );

  expect(patched.ok, patched.error?.message).toBe(true);
  expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({ agentId: "work" });
  expect(patched.payload?.entry).toMatchObject({
    providerOverride: "work-provider",
    modelOverride: "work-only",
  });
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: key, storePath: workStorePath }),
  ).toMatchObject({
    providerOverride: "work-provider",
    modelOverride: "work-only",
  });
});

test.each([
  { label: "explicit agent", agentId: "work" },
  { label: "agent-qualified session", agentId: undefined },
])("sessions.create loads the $label model catalog", async ({ agentId }) => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  const key = `agent:work:dashboard:catalog-owner-create-${agentId ? "explicit" : "key"}`;
  const loadGatewayModelCatalogSnapshot = createAgentModelCatalogLoader();

  const created = await directSessionReq<{
    entry?: { modelOverride?: string; providerOverride?: string };
  }>(
    "sessions.create",
    {
      key,
      ...(agentId ? { agentId } : {}),
      model: "work-provider/work-only",
    },
    { context: { loadGatewayModelCatalogSnapshot } },
  );

  expect(created.ok, created.error?.message).toBe(true);
  expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledWith({ agentId: "work" });
  expect(created.payload?.entry).toMatchObject({
    providerOverride: "work-provider",
    modelOverride: "work-only",
  });
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: key, storePath: workStorePath }),
  ).toMatchObject({
    providerOverride: "work-provider",
    modelOverride: "work-only",
  });
});

async function replacementConfig(): Promise<OpenClawConfig> {
  const current = (await getGatewayConfigModule()).getRuntimeConfig();
  const currentLevel = current.logging?.level;
  return {
    ...current,
    logging: {
      ...current.logging,
      level: currentLevel === "debug" ? "info" : "debug",
    },
  };
}

test("sessions.patch fails retryably before commit when the catalog owner config changed", async () => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  const key = "agent:work:dashboard:catalog-owner-replaced-patch";
  await writeSessionStore({
    agentId: "work",
    storePath: workStorePath,
    entries: { [key]: sessionStoreEntry("work-catalog-replaced-patch") },
  });
  const loadGatewayModelCatalogSnapshot = createAgentModelCatalogLoader(await replacementConfig());

  const patched = await directSessionReq(
    "sessions.patch",
    { key, agentId: "work", model: "work-provider/work-only" },
    { context: { loadGatewayModelCatalogSnapshot } },
  );

  expect(patched.ok).toBe(false);
  expect(patched.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: key, storePath: workStorePath }),
  ).not.toMatchObject({ modelOverride: "work-only" });
});

test("sessions.create fails retryably without materializing a row when catalog config changed", async () => {
  const { workStorePath } = await createSelectedGlobalSessionStore();
  const key = "agent:work:dashboard:catalog-owner-replaced-create";
  const loadGatewayModelCatalogSnapshot = createAgentModelCatalogLoader(await replacementConfig());

  const created = await directSessionReq(
    "sessions.create",
    { key, agentId: "work", model: "work-provider/work-only" },
    { context: { loadGatewayModelCatalogSnapshot } },
  );

  expect(created.ok).toBe(false);
  expect(created.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });
  expect(
    loadSessionEntry({ agentId: "work", sessionKey: key, storePath: workStorePath }),
  ).toBeUndefined();
});
