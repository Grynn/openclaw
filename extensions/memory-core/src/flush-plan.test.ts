// Memory Core tests cover flush plan plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DREAMING_DAILY_PROVENANCE_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { buildMemoryFlushPlan } from "./flush-plan.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

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

  it("records mixed trusted and untrusted writes as untrusted for the whole file", async () => {
    const workspaceDir = await createTempWorkspace("openclaw-flush-provenance-");
    const plan = buildMemoryFlushPlan({ nowMs: Date.UTC(2026, 6, 28, 12, 0, 0) });
    if (!plan?.recordWriteProvenance) {
      throw new Error("expected memory flush provenance writer");
    }
    await plan.recordWriteProvenance({
      workspaceDir,
      relativePath: plan.relativePath,
      contentBefore: "",
      contentAfter: "trusted line\n",
      originClass: "agent",
      observedAt: 1,
    });
    await plan.recordWriteProvenance({
      workspaceDir,
      relativePath: plan.relativePath,
      contentBefore: "trusted line\n",
      contentAfter: "trusted line\nuntrusted line\n",
      originClass: "untrusted",
      observedAt: 2,
    });

    const records = await readMemoryCoreWorkspaceEntries<{
      fileHash: string;
      originClass: "agent" | "untrusted";
      observedAt: number;
    }>({ namespace: DREAMING_DAILY_PROVENANCE_NAMESPACE, workspaceDir });
    expect(records).toEqual([
      expect.objectContaining({
        key: plan.relativePath,
        value: expect.objectContaining({ originClass: "untrusted", observedAt: 2 }),
      }),
    ]);
  });
});
