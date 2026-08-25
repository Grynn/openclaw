import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import { projectSessionMutationModelCatalog } from "./session-model-catalog.js";

function config(level: "debug" | "info"): OpenClawConfig {
  return {
    agents: {
      list: [
        {
          id: "main",
          default: true,
          agentDir: "/tmp/agent-main",
          workspace: "/tmp/workspace-main",
        },
      ],
    },
    logging: { level },
  };
}

function snapshot(cfg: OpenClawConfig): GatewayModelCatalogSnapshot {
  return {
    agentDir: "/tmp/agent-main",
    agentId: "main",
    catalogComplete: true,
    config: cfg,
    entries: [{ provider: "openai", id: "gpt-5.6-sol", name: "Sol" }],
    routeVariants: [],
    workspaceDir: "/tmp/workspace-main",
  };
}

describe("session mutation model catalog ownership", () => {
  it("projects entries from the exact request config owner", () => {
    const cfg = config("info");

    expect(
      projectSessionMutationModelCatalog({ agentId: "MAIN", config: cfg, snapshot: snapshot(cfg) }),
    ).toEqual([{ provider: "openai", id: "gpt-5.6-sol", name: "Sol" }]);
  });

  it("fails closed when a replacement owner has different policy config", () => {
    expect(() =>
      projectSessionMutationModelCatalog({
        agentId: "main",
        config: config("info"),
        snapshot: snapshot(config("debug")),
      }),
    ).toThrow("prepared model catalog owner config was replaced during the read");
  });

  it("fails closed when the catalog owner resolves a different agent", () => {
    const cfg = config("info");

    expect(() =>
      projectSessionMutationModelCatalog({
        agentId: "main",
        config: cfg,
        snapshot: { ...snapshot(cfg), agentId: "worker" },
      }),
    ).toThrow('resolved agent "worker" instead of "main"');
  });
});
