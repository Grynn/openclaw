// Verifies status probes never provision the managed llama.cpp embedding runtime.
import type {
  EmbeddingProviderAdapter,
  EmbeddingProviderCreateOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureModel: vi.fn(async () => "/tmp/model.gguf"),
  prepareServer: vi.fn(async () => undefined),
  inspectRuntime: vi.fn(async () => ({ state: "stopped" as const })),
  genericCreate: vi.fn<EmbeddingProviderAdapter["create"]>(async () => ({ provider: null })),
  genericEmbed: vi.fn(async () => [1, 0]),
  genericEmbedBatch: vi.fn(async (inputs: unknown[]) => inputs.map(() => [1, 0])),
}));

vi.mock("./managed-server.js", () => ({
  ensureLlamaCppModel: mocks.ensureModel,
  prepareManagedLlamaServer: mocks.prepareServer,
  inspectLlamaServerRuntime: mocks.inspectRuntime,
}));

vi.mock("./llama-server-install.js", () => ({
  selectLlamaServerAsset: () => ({ backend: "cpu" }),
}));

vi.mock("openclaw/plugin-sdk/embedding-providers", () => ({
  getEmbeddingProvider: () => ({ create: mocks.genericCreate }),
}));

import { llamaCppEmbeddingProviderAdapter } from "./embedding-provider.js";

describe("llama.cpp embedding provider", () => {
  beforeEach(() => {
    mocks.ensureModel.mockClear();
    mocks.prepareServer.mockClear();
    mocks.inspectRuntime.mockClear();
    mocks.genericCreate.mockClear();
    mocks.genericEmbed.mockClear();
    mocks.genericEmbedBatch.mockClear();
  });

  it("does not download a model or prepare a server for a read-only status probe", async () => {
    const options = {
      config: {
        models: {
          providers: {
            "llama-cpp": {
              api: "openai-completions",
              apiKey: "llama-cpp-local",
              baseUrl: "http://127.0.0.1:19432/v1",
              localService: {
                command: "/already/installed/llama-server",
                args: [],
                healthUrl: "http://127.0.0.1:19432/health",
              },
              models: [],
            },
          },
        },
      },
      model: "",
      readOnly: true,
    } as EmbeddingProviderCreateOptions & { readOnly: true };

    await expect(llamaCppEmbeddingProviderAdapter.create(options)).resolves.toEqual({
      provider: null,
    });

    expect(mocks.ensureModel).not.toHaveBeenCalled();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
    expect(mocks.genericCreate).toHaveBeenCalledOnce();
  });

  it("marks read-only status as configuration-only without invoking inference", async () => {
    mocks.genericCreate.mockResolvedValueOnce({
      provider: {
        id: "openai-compatible",
        model: "text-embedding",
        embed: mocks.genericEmbed,
        embedBatch: mocks.genericEmbedBatch,
      },
    });
    const options = {
      config: {
        models: {
          providers: {
            "llama-cpp": {
              api: "openai-completions",
              apiKey: "llama-cpp-local",
              baseUrl: "http://127.0.0.1:19432/v1",
              localService: {
                command: "/already/installed/llama-server",
                args: [],
                healthUrl: "http://127.0.0.1:19432/health",
              },
              models: [],
            },
          },
        },
      },
      model: "",
      readOnly: true,
    } as EmbeddingProviderCreateOptions & { readOnly: true };

    const result = await llamaCppEmbeddingProviderAdapter.create(options);

    expect(result.runtime?.readOnlyProbe).toBe("configuration-only");
    expect(mocks.genericEmbed).not.toHaveBeenCalled();
    expect(mocks.genericEmbedBatch).not.toHaveBeenCalled();
    expect(mocks.ensureModel).not.toHaveBeenCalled();
    expect(mocks.prepareServer).not.toHaveBeenCalled();
  });
});
