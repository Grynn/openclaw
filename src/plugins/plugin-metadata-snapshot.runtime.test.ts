import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:module");
  vi.doUnmock("../shared/global-singleton.js");
  vi.resetModules();
});

describe("plugin metadata snapshot runtime", () => {
  it("cold-loads both adjacent JavaScript readers and delegates through an empty slot", async () => {
    const currentSnapshot = { marker: "current" };
    const resolvedSnapshot = { marker: "resolved" };
    const getCurrentPluginMetadataSnapshot = vi.fn(() => currentSnapshot);
    const resolvePluginMetadataSnapshot = vi.fn(() => resolvedSnapshot);
    const requireRuntime = vi.fn((specifier: string) => {
      if (specifier === "./current-plugin-metadata-snapshot.js") {
        return { getCurrentPluginMetadataSnapshot };
      }
      if (specifier === "./plugin-metadata-snapshot.js") {
        return { resolvePluginMetadataSnapshot };
      }
      throw new Error(`unexpected runtime sidecar: ${specifier}`);
    });
    vi.doMock("node:module", async () => {
      const actual = await vi.importActual<typeof import("node:module")>("node:module");
      return Object.assign({}, actual, {
        createRequire: vi.fn(() => requireRuntime),
      });
    });
    vi.doMock("../shared/global-singleton.js", async () => {
      const actual = await vi.importActual<typeof import("../shared/global-singleton.js")>(
        "../shared/global-singleton.js",
      );
      return {
        ...actual,
        resolveGlobalSingleton: vi.fn(() => ({})),
      };
    });

    const { getCurrentPluginMetadataSnapshotRuntime, resolvePluginMetadataSnapshotRuntime } =
      await import("./plugin-metadata-snapshot.runtime.js");
    const currentParams = { workspaceDir: "/current-workspace" };
    const resolveParams = { workspaceDir: "/resolved-workspace" };

    expect(getCurrentPluginMetadataSnapshotRuntime(currentParams)).toBe(currentSnapshot);
    expect(resolvePluginMetadataSnapshotRuntime(resolveParams)).toBe(resolvedSnapshot);
    expect(requireRuntime.mock.calls.map(([specifier]) => specifier)).toEqual([
      "./current-plugin-metadata-snapshot.js",
      "./plugin-metadata-snapshot.js",
    ]);
    expect(getCurrentPluginMetadataSnapshot).toHaveBeenCalledWith(currentParams);
    expect(resolvePluginMetadataSnapshot).toHaveBeenCalledWith(resolveParams);
  });
});
