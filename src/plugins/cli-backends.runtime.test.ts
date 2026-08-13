// CLI backend runtime tests keep provider classification on the lightweight registry-state path.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPluginRegistryState = vi.hoisted(() => vi.fn());

vi.mock("./runtime-state.js", () => ({ getPluginRegistryState }));
vi.mock("./active-runtime-registry.js", () => {
  throw new Error("CLI backend reads must not import the plugin loader registry facade");
});

import { resolveRuntimeCliBackends } from "./cli-backends.runtime.js";

describe("runtime CLI backends", () => {
  beforeEach(() => {
    getPluginRegistryState.mockReset();
  });

  it("returns no backends before a runtime registry is active", () => {
    expect(resolveRuntimeCliBackends()).toEqual([]);
  });

  it("projects active CLI backend ownership without importing the loader facade", () => {
    getPluginRegistryState.mockReturnValue({
      activeRegistry: {
        cliBackends: [
          {
            pluginId: "example-plugin",
            builtWithOpenClawVersion: "2026.8.1",
            backend: {
              id: "example-cli",
              config: { command: "example" },
            },
          },
        ],
      },
    });

    expect(resolveRuntimeCliBackends()).toEqual([
      {
        id: "example-cli",
        config: { command: "example" },
        pluginId: "example-plugin",
        builtWithOpenClawVersion: "2026.8.1",
      },
    ]);
  });
});
