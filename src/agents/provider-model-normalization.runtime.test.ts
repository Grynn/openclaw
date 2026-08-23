import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("node:module");
  vi.resetModules();
});

describe("provider model normalization runtime", () => {
  it("loads the adjacent JavaScript sidecar and delegates normalization", async () => {
    const normalizeProviderModelIdWithPlugin = vi.fn(() => "canonical-model");
    const requireRuntime = vi.fn((specifier: string) => {
      if (specifier !== "./provider-model-normalization-provider.runtime.js") {
        throw new Error(`unexpected runtime sidecar: ${specifier}`);
      }
      return { normalizeProviderModelIdWithPlugin };
    });
    vi.doMock("node:module", async () => {
      const actual = await vi.importActual<typeof import("node:module")>("node:module");
      return Object.assign({}, actual, {
        createRequire: vi.fn(() => requireRuntime),
      });
    });

    const { normalizeProviderModelIdWithRuntime } =
      await import("./provider-model-normalization.runtime.js");
    const params = {
      provider: "example-provider",
      context: {
        provider: "example-provider",
        modelId: "legacy-model",
      },
    };

    expect(normalizeProviderModelIdWithRuntime(params)).toBe("canonical-model");
    expect(requireRuntime).toHaveBeenCalledTimes(1);
    expect(requireRuntime).toHaveBeenCalledWith(
      "./provider-model-normalization-provider.runtime.js",
    );
    expect(normalizeProviderModelIdWithPlugin).toHaveBeenCalledWith(params);
  });
});
