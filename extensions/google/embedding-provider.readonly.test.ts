// Google tests cover side-effect-free embedding provider diagnostics.
import { expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    apiKey: "provider-key",
    source: "profile:google:default",
    mode: "api-key" as const,
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  };
});

import { createGeminiEmbeddingProvider } from "./embedding-provider.js";

it("keeps status credential resolution read-only", async () => {
  const config = {
    models: {
      providers: {
        google: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          models: [],
        },
      },
    },
  };

  await createGeminiEmbeddingProvider({
    agentDir: "/tmp/google-read-only-agent",
    config: config as never,
    fallback: "none",
    model: "gemini-embedding-001",
    provider: "google",
    readOnly: true,
  });

  expect(resolveApiKeyForProviderMock).toHaveBeenCalledWith({
    agentDir: "/tmp/google-read-only-agent",
    cfg: config,
    provider: "google",
    readOnly: true,
  });
});
