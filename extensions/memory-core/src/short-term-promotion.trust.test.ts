import { expect, it, vi } from "vitest";
import { isPromotionOriginBlocked } from "./dreaming-consolidation-candidates.js";
import {
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

vi.mock("openclaw/plugin-sdk/memory-host-events", () => ({
  appendMemoryHostEvent: vi.fn(async () => {}),
}));

const { createTempWorkspace } = createMemoryCoreTestHarness();

it("omits untrusted candidates before ranking and dreaming work", async () => {
  const workspaceDir = await createTempWorkspace("promotion-trust-");
  await recordShortTermRecalls({
    workspaceDir,
    query: "promotion trust boundary",
    results: [
      {
        path: "memory/2026-04-01.md",
        startLine: 1,
        endLine: 1,
        score: 0.99,
        snippet: "Untrusted router note must not become durable memory.",
        source: "memory",
        provenance: {
          originClass: "untrusted",
          sessionKind: "interactive",
          observedAt: Date.parse("2026-04-01T12:00:00.000Z"),
        },
      },
      {
        path: "memory/2026-04-02.md",
        startLine: 1,
        endLine: 1,
        score: 0.8,
        snippet: "Gateway maintenance requires an authorized restart.",
        source: "memory",
        provenance: {
          originClass: "agent",
          sessionKind: "interactive",
          observedAt: Date.parse("2026-04-02T12:00:00.000Z"),
        },
      },
    ],
  });

  const thresholds = { workspaceDir, minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
  const ranked = await rankShortTermPromotionCandidates(thresholds);
  expect(ranked).toHaveLength(1);
  expect(ranked[0]?.path).toBe("memory/2026-04-02.md");
  expect(ranked[0] && isPromotionOriginBlocked(ranked[0])).toBe(false);

  const applyRanked = await rankShortTermPromotionCandidates({
    ...thresholds,
    includeBlockedOrigins: true,
  });
  expect(applyRanked.map((candidate) => candidate.path)).toEqual([
    "memory/2026-04-01.md",
    "memory/2026-04-02.md",
  ]);
  expect(applyRanked[0] && isPromotionOriginBlocked(applyRanked[0])).toBe(true);
});
