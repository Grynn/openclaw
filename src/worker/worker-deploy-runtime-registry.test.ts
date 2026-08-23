import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkerDeployRuntimeReady,
  getWorkerDeployFacadeActivationCheck,
  getWorkerDeployPluginMetadataCurrent,
  getWorkerDeployPluginMetadataResolver,
  getWorkerDeployProviderModelNormalization,
  getWorkerDeploySubagentRegistryLoader,
  getWorkerDeployTaskRegistryControlLoader,
  prewarmWorkerDeployRuntime,
  setWorkerDeployRuntime,
} from "./worker-deploy-runtime-registry.js";

type WorkerDeployRuntimeRegistration = Parameters<typeof setWorkerDeployRuntime>[0];

function createRuntimeRegistration(): WorkerDeployRuntimeRegistration {
  return {
    facadeActivationCheck: {
      resolveBundledPluginPublicSurfaceAccess: vi.fn(),
    },
    highlightJs: {},
    json5: {},
    loadSubagentRegistry: vi.fn(async () => ({
      ensureContextEnginesInitialized: vi.fn(),
      resolveContextEngine: vi.fn(),
    })),
    loadTaskRegistryControl: vi.fn(async () => ({
      cancelActiveCronTaskRun: vi.fn(),
      cancelBackgroundExecSession: vi.fn(),
      getAcpSessionManager: vi.fn(),
      isContextEngineTurnMaintenanceRunActive: vi.fn(),
      killSubagentRunAdmin: vi.fn(),
    })),
    pluginMetadataCurrent: {
      getCurrentPluginMetadataSnapshot: vi.fn(),
    },
    pluginMetadataResolver: {
      resolvePluginMetadataSnapshot: vi.fn(),
    },
    providerModelNormalization: {
      normalizeProviderModelIdWithPlugin: vi.fn(),
    },
    resolveSecureTempRoot: vi.fn(),
  } as unknown as WorkerDeployRuntimeRegistration;
}

describe("worker deploy runtime registry", () => {
  beforeEach(() => {
    setWorkerDeployRuntime(createRuntimeRegistration());
  });

  it("publishes and prewarms every composed runtime seam", async () => {
    expect(() => assertWorkerDeployRuntimeReady()).not.toThrow();
    expect(getWorkerDeployFacadeActivationCheck()).toBeDefined();
    expect(getWorkerDeployPluginMetadataCurrent()).toBeDefined();
    expect(getWorkerDeployPluginMetadataResolver()).toBeDefined();
    expect(getWorkerDeployProviderModelNormalization()).toBeDefined();

    const loadSubagentRegistry = getWorkerDeploySubagentRegistryLoader();
    const loadTaskRegistryControl = getWorkerDeployTaskRegistryControlLoader();
    await expect(prewarmWorkerDeployRuntime()).resolves.toBeUndefined();
    expect(loadSubagentRegistry).toHaveBeenCalledOnce();
    expect(loadTaskRegistryControl).toHaveBeenCalledOnce();
  });

  it("fails closed when a composed runtime seam is absent", () => {
    const registration = createRuntimeRegistration();
    registration.highlightJs = undefined as never;
    setWorkerDeployRuntime(registration);

    expect(() => assertWorkerDeployRuntimeReady()).toThrow(
      "Worker deploy runtime composition is incomplete",
    );
  });

  it("fails prewarm when a lazy runtime omits its contract", async () => {
    const registration = createRuntimeRegistration();
    registration.loadSubagentRegistry = vi.fn(async () => ({})) as never;
    setWorkerDeployRuntime(registration);

    await expect(prewarmWorkerDeployRuntime()).rejects.toThrow(
      "Worker deploy lazy runtime composition is incomplete",
    );
  });
});
