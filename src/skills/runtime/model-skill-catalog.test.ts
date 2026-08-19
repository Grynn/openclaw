import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION, type SkillSnapshot } from "../types.js";
import { resolveAuthorizedModelSkills } from "./model-skill-catalog.js";
import { hydrateResolvedSkills } from "./snapshot-hydration.js";

const unavailableSkillKeys = vi.hoisted(() => new Set<string>());

vi.mock("../loading/config.js", () => ({
  isSkillSecretOwnerUnavailable: (skillKey: string) => unavailableSkillKeys.has(skillKey),
}));

function createSnapshot(names: string[]): SkillSnapshot {
  return {
    prompt: "bounded prompt",
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
    skills: names.map((name) => ({ name, skillKey: `key:${name}` })),
    modelInvocableSkills: names.map((name) => ({ name, skillKey: `key:${name}` })),
    resolvedSkills: names.map((name) => ({
      ...createCanonicalFixtureSkill({
        name,
        description: `${name} description`,
        filePath: `/skills/${name}/SKILL.md`,
        baseDir: `/skills/${name}`,
        source: "openclaw-workspace",
      }),
      skillKey: `key:${name}`,
    })),
  };
}

describe("resolveAuthorizedModelSkills", () => {
  beforeEach(() => {
    unavailableSkillKeys.clear();
  });

  it("intersects persisted model authority with the hydrated runtime", () => {
    const snapshot = createSnapshot(["zulu", "alpha"]);
    snapshot.resolvedSkills?.push({
      ...createCanonicalFixtureSkill({
        name: "fresh-but-unauthorized",
        description: "Must not appear after cold hydration",
        filePath: "/skills/fresh/SKILL.md",
        baseDir: "/skills/fresh",
        source: "openclaw-workspace",
      }),
      skillKey: "key:fresh-but-unauthorized",
    });

    expect(resolveAuthorizedModelSkills(snapshot).map((skill) => skill.name)).toEqual([
      "alpha",
      "zulu",
    ]);
  });

  it("rejects a same-name skill whose key changed during cold hydration", () => {
    const persisted = createSnapshot(["alpha"]);
    delete persisted.resolvedSkills;
    const rebuilt = createSnapshot(["alpha"]);
    rebuilt.resolvedSkills![0]!.skillKey = "key:replacement";

    const hydrated = hydrateResolvedSkills(persisted, () => rebuilt);

    expect(resolveAuthorizedModelSkills(hydrated)).toEqual([]);
  });

  it.each([
    ["legacy marker", (snapshot: SkillSnapshot) => delete snapshot.modelInvocableSkills],
    [
      "legacy prompt format",
      (snapshot: SkillSnapshot) => {
        snapshot.promptFormatVersion = WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION - 1;
      },
    ],
    ["missing hydration", (snapshot: SkillSnapshot) => delete snapshot.resolvedSkills],
    [
      "mismatched skill key",
      (snapshot: SkillSnapshot) => {
        snapshot.modelInvocableSkills![0]!.skillKey = "wrong";
      },
    ],
    [
      "duplicate authority name",
      (snapshot: SkillSnapshot) => {
        snapshot.modelInvocableSkills!.push({ name: "alpha", skillKey: "key:alpha" });
      },
    ],
    [
      "duplicate hydrated name",
      (snapshot: SkillSnapshot) => {
        snapshot.resolvedSkills!.push(snapshot.resolvedSkills![0]!);
      },
    ],
    [
      "skill file outside its resource root",
      (snapshot: SkillSnapshot) => {
        snapshot.resolvedSkills![0]!.baseDir = "/other-root/alpha";
      },
    ],
  ])("fails closed for %s", (_label, mutate) => {
    const snapshot = createSnapshot(["alpha"]);
    mutate(snapshot);
    expect(resolveAuthorizedModelSkills(snapshot)).toEqual([]);
  });

  it("filters current model-disabled and secret-degraded skills", () => {
    const snapshot = createSnapshot(["available", "disabled", "degraded"]);
    const disabled = snapshot.resolvedSkills?.find((skill) => skill.name === "disabled");
    if (!disabled) {
      throw new Error("missing disabled fixture");
    }
    disabled.disableModelInvocation = true;
    unavailableSkillKeys.add("key:degraded");

    expect(resolveAuthorizedModelSkills(snapshot).map((skill) => skill.name)).toEqual([
      "available",
    ]);
  });
});
