import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";

describe("resolveCodexDynamicToolDirectNames", () => {
  it("exposes the exact memory flush tools without a discovery turn", () => {
    const params = {
      trigger: "memory",
      memoryFlushWritePath: "memory/2026-08-12.md",
    } as EmbeddedRunAttemptParams;

    expect(resolveCodexDynamicToolDirectNames(params)).toEqual(["read", "write"]);
  });

  it("does not expose memory tools for an incomplete memory run", () => {
    const params = { trigger: "memory" } as EmbeddedRunAttemptParams;

    expect(resolveCodexDynamicToolDirectNames(params)).toEqual([]);
  });
});
