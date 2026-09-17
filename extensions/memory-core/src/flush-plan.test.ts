// Memory Core tests cover flush plan plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMemoryFlushPlan } from "./flush-plan.js";

describe("buildMemoryFlushPlan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when the injected timestamp is outside Date range", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 4, 30, 12, 0, 0));

    const plan = buildMemoryFlushPlan({
      nowMs: 8_640_000_000_000_001,
    });

    expect(plan?.relativePath).toBe("memory/2026-05-30.md");
  });

  it("requires reading and deduplicating the daily target before appending", () => {
    const plan = buildMemoryFlushPlan({ nowMs: Date.UTC(2026, 6, 28, 12, 0, 0) });

    expect(plan?.prompt).toContain("Read the target daily memory file before writing");
    expect(plan?.prompt).toContain("do not repeat or restate existing entries");
    expect(plan?.prompt).toContain("trust that receipt and do not reread");
    expect(plan?.systemPrompt).toContain("Read the target daily memory file before writing");
    expect(plan?.systemPrompt).toContain("trust that receipt and do not reread");
  });

  it.each([
    [8_000, 2_000, 3_000],
    [16_000, 4_000, 4_000],
    [24_000, 6_000, 4_000],
    [32_768, 8_192, 4_000],
    [128_000, 20_000, 4_000],
    [200_000, 20_000, 4_000],
  ])(
    "sizes its reserve and maintenance headroom to a %i-token context window",
    (contextWindowTokens, reserveTokensFloor, softThresholdTokens) => {
      expect(buildMemoryFlushPlan({ contextWindowTokens })).toMatchObject({
        reserveTokensFloor,
        softThresholdTokens,
      });
    },
  );
});
