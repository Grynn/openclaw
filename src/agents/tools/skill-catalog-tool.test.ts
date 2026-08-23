import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DEFAULT_MAX_SKILL_FILE_BYTES } from "../../skills/loading/skill-root-discovery.js";
import { createCanonicalFixtureSkill } from "../../skills/test-support/test-helpers.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION, type SkillSnapshot } from "../../skills/types.js";
import type { AnyAgentTool } from "./common.js";
import { createSkillCatalogTool } from "./skill-catalog-tool.js";

const EXPECTED_MAX_OUTPUT_BYTES = 32_000;
const EXPECTED_MAX_PAGE_BYTES = 12_000;
const EXPECTED_MAX_QUERY_CHARS = 512;
const EXPECTED_MAX_SEARCH_LIMIT = 25;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createSnapshot(
  skills: Array<{
    name: string;
    description?: string;
    filePath?: string;
    readContent?: string;
    promptVersion?: string;
  }>,
): SkillSnapshot {
  const resolvedSkills = skills.map((skill) => ({
    ...createCanonicalFixtureSkill({
      name: skill.name,
      description: skill.description ?? `${skill.name} description`,
      filePath: skill.filePath ?? `/skills/${skill.name}/SKILL.md`,
      baseDir: path.dirname(skill.filePath ?? `/skills/${skill.name}/SKILL.md`),
      source: skill.readContent === undefined ? "openclaw-workspace" : "openclaw-node",
    }),
    skillKey: `key:${skill.name}`,
    ...(skill.promptVersion ? { promptVersion: skill.promptVersion } : {}),
    ...(skill.readContent !== undefined ? { readContent: skill.readContent } : {}),
  }));
  return {
    prompt: "bounded prompt",
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
    skills: skills.map((skill) => ({ name: skill.name, skillKey: `key:${skill.name}` })),
    modelInvocableSkills: skills.map((skill) => ({
      name: skill.name,
      skillKey: `key:${skill.name}`,
    })),
    resolvedSkills,
  };
}

function requireTool(snapshot: SkillSnapshot) {
  const tool = createSkillCatalogTool({ skillsSnapshot: snapshot });
  if (!tool) {
    throw new Error("expected skill_catalog tool");
  }
  return tool;
}

function outputBytes(result: Awaited<ReturnType<AnyAgentTool["execute"]>>): number {
  const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
  return Buffer.byteLength(text, "utf8");
}

async function readAllPages(
  tool: AnyAgentTool,
  params: { action: "read_resource"; name: string; resource: string },
): Promise<{ content: string; pages: number }> {
  const chunks: string[] = [];
  let offset = 0;
  let pages = 0;
  while (true) {
    const result = await tool.execute(`page-${pages}`, { ...params, offset });
    expect(outputBytes(result)).toBeLessThanOrEqual(EXPECTED_MAX_OUTPUT_BYTES);
    const details = result.details as {
      bytes: number;
      content: string;
      nextOffset: number | null;
      offset: number;
      totalBytes: number;
    };
    expect(details.offset).toBe(offset);
    expect(details.bytes).toBeLessThanOrEqual(EXPECTED_MAX_PAGE_BYTES);
    chunks.push(details.content);
    pages += 1;
    if (details.nextOffset === null) {
      expect(Buffer.byteLength(chunks.join(""), "utf8")).toBe(details.totalBytes);
      break;
    }
    expect(details.nextOffset).toBeGreaterThan(offset);
    offset = details.nextOffset;
  }
  return { content: chunks.join(""), pages };
}

describe("skill_catalog", () => {
  it("searches deterministically with path-free pagination", async () => {
    const snapshot = createSnapshot([
      { name: "zeta-search", description: `Web search ${"x".repeat(500)}` },
      { name: "alpha-search", description: "Search source repositories" },
      { name: "calendar", description: "Schedule meetings" },
    ]);
    const tool = requireTool(snapshot);
    const first = await tool.execute("search-1", {
      action: "search",
      query: "search",
      limit: 1,
    });
    expect(first.details).toMatchObject({
      totalMatches: 2,
      offset: 0,
      nextOffset: 1,
      skills: [{ name: "alpha-search" }],
    });
    const second = await tool.execute("search-2", {
      action: "search",
      query: "search",
      limit: 1,
      offset: 1,
    });
    expect(second.details).toMatchObject({
      totalMatches: 2,
      offset: 1,
      nextOffset: null,
      skills: [{ name: "zeta-search" }],
    });
    const serialized = JSON.stringify([first.details, second.details]);
    expect(serialized).not.toMatch(/\/skills\/|skillKey|filePath|baseDir|resourceRoot/);
  });

  it("returns a complete multi-page-sized filesystem skill atomically", async () => {
    const dir = tempDirs.make("openclaw-skill-catalog-");
    const filePath = path.join(dir, "SKILL.md");
    const content = `# Alpha\n\n${"🙂 complete instructions\n".repeat(700)}`;
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(EXPECTED_MAX_PAGE_BYTES);
    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(DEFAULT_MAX_SKILL_FILE_BYTES);
    await fs.writeFile(filePath, content);
    const tool = requireTool(
      createSnapshot([{ name: "alpha", filePath, promptVersion: "sha256:test" }]),
    );

    const read = await tool.execute("read", { action: "read", name: "alpha" });
    expect(outputBytes(read)).toBeLessThanOrEqual(EXPECTED_MAX_OUTPUT_BYTES);
    expect(read.details).toMatchObject({
      action: "read",
      name: "alpha",
      version: "sha256:test",
      totalBytes: Buffer.byteLength(content, "utf8"),
      content,
    });
    expect(read.details).not.toHaveProperty("offset");
    expect(read.details).not.toHaveProperty("nextOffset");
    expect(JSON.stringify(read.details)).not.toContain(filePath);

    await expect(
      tool.execute("bad-offset", { action: "read", name: "alpha", offset: 1 }),
    ).rejects.toThrow("does not accept offset or limit");
    await expect(tool.execute("wrong-case", { action: "read", name: "Alpha" })).rejects.toThrow(
      "Search skill_catalog first",
    );
  });

  it("returns bounded node-hosted content atomically and rejects oversized content", async () => {
    const content = `# Pond\n${"node-hosted-marker\n".repeat(700)}`;
    const tool = requireTool(
      createSnapshot([
        {
          name: "pond",
          filePath: "node://one/skills/pond/SKILL.md",
          readContent: content,
        },
      ]),
    );
    expect(
      (await tool.execute("node-read", { action: "read", name: "pond" })).details,
    ).toMatchObject({ content, totalBytes: Buffer.byteLength(content, "utf8") });
    await expect(
      tool.execute("node-resources", { action: "list_resources", name: "pond" }),
    ).rejects.toThrow("does not publish local support files");

    const escapedBeyondOutputBudget = requireTool(
      createSnapshot([
        {
          name: "escaped",
          filePath: "node://one/skills/escaped/SKILL.md",
          readContent: "\n".repeat(EXPECTED_MAX_OUTPUT_BYTES),
        },
      ]),
    );
    await expect(
      escapedBeyondOutputBudget.execute("escaped", { action: "read", name: "escaped" }),
    ).rejects.toThrow(`returned whole within ${EXPECTED_MAX_OUTPUT_BYTES} bytes`);

    const oversized = requireTool(
      createSnapshot([
        {
          name: "large",
          filePath: "node://one/skills/large/SKILL.md",
          readContent: "x".repeat(DEFAULT_MAX_SKILL_FILE_BYTES + 1),
        },
      ]),
    );
    await expect(oversized.execute("large", { action: "read", name: "large" })).rejects.toThrow(
      `exceeds ${DEFAULT_MAX_SKILL_FILE_BYTES} bytes`,
    );
  });

  it("lists and pages relative resources without revealing their host root", async () => {
    const dir = tempDirs.make("openclaw-skill-resources-");
    const outside = tempDirs.make("openclaw-skill-outside-");
    const filePath = path.join(dir, "SKILL.md");
    const guide = `# Guide\n${"bounded reference\n".repeat(2_500)}`;
    await fs.mkdir(path.join(dir, "references"), { recursive: true });
    await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
    await fs.mkdir(path.join(dir, ".private"), { recursive: true });
    await fs.mkdir(path.join(dir, "node_modules", "package"), { recursive: true });
    await fs.writeFile(filePath, "# Resource skill\n");
    await fs.writeFile(path.join(dir, "references", "guide.md"), guide);
    await fs.writeFile(path.join(dir, "scripts", "collect.sh"), "#!/bin/sh\necho ok\n");
    await fs.writeFile(path.join(dir, ".private", "secret.txt"), "secret\n");
    await fs.writeFile(path.join(dir, "node_modules", "package", "index.js"), "ignored\n");
    await fs.writeFile(path.join(dir, " padded.md"), "ignored\n");
    await fs.writeFile(path.join(outside, "secret.txt"), "outside\n");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "references", "escape.md"));
    await fs.symlink(
      path.join("..", ".private", "secret.txt"),
      path.join(dir, "references", "hidden-alias.md"),
    );
    await fs.symlink(
      path.join("..", "node_modules", "package", "index.js"),
      path.join(dir, "references", "blocked-alias.md"),
    );
    const tool = requireTool(createSnapshot([{ name: "resources", filePath }]));

    const listed = await tool.execute("list", {
      action: "list_resources",
      name: "resources",
      limit: 1,
    });
    expect(listed.details).toMatchObject({
      action: "list_resources",
      name: "resources",
      totalResources: 2,
      scanTruncated: false,
      offset: 0,
      nextOffset: 1,
      resources: ["references/guide.md"],
    });
    const listedText = JSON.stringify(listed.details);
    expect(listedText).not.toContain(dir);
    expect(listedText).not.toContain(outside);
    expect(listedText).not.toMatch(
      /SKILL\.md|\.private|node_modules|escape\.md|hidden-alias\.md|blocked-alias\.md|padded\.md/,
    );

    await fs.writeFile(path.join(dir, "references", "guessed-after-list.md"), "not authorized\n");
    await expect(
      tool.execute("guessed-unlisted", {
        action: "read_resource",
        name: "resources",
        resource: "references/guessed-after-list.md",
      }),
    ).rejects.toThrow("exact path returned by list_resources");

    const read = await readAllPages(tool, {
      action: "read_resource",
      name: "resources",
      resource: "references/guide.md",
    });
    expect(read.content).toBe(guide);
    expect(read.pages).toBeGreaterThan(1);
    await expect(
      tool.execute("traversal", {
        action: "read_resource",
        name: "resources",
        resource: "../secret.txt",
      }),
    ).rejects.toThrow("safe relative path");
    await expect(
      tool.execute("absolute", {
        action: "read_resource",
        name: "resources",
        resource: path.join(outside, "secret.txt"),
      }),
    ).rejects.toThrow("safe relative path");
    await expect(
      tool.execute("control-character", {
        action: "read_resource",
        name: "resources",
        resource: "references/hidden\u0000.md",
      }),
    ).rejects.toThrow("safe relative path");
    for (const resource of [".private/secret.txt", "node_modules/package/index.js"]) {
      await expect(
        tool.execute(`blocked-${resource}`, {
          action: "read_resource",
          name: "resources",
          resource,
        }),
      ).rejects.toThrow("safe relative path");
    }
    await expect(
      tool.execute("symlink-escape", {
        action: "read_resource",
        name: "resources",
        resource: "references/escape.md",
      }),
    ).rejects.toThrow("exact path returned by list_resources");
    for (const resource of ["references/hidden-alias.md", "references/blocked-alias.md"]) {
      await expect(
        tool.execute(`symlink-${resource}`, {
          action: "read_resource",
          name: "resources",
          resource,
        }),
      ).rejects.toThrow("exact path returned by list_resources");
    }
  });

  it("enforces input, text, and authorization bounds", async () => {
    const tool = requireTool(createSnapshot([{ name: "alpha" }]));
    await expect(
      tool.execute("query", {
        action: "search",
        query: "x".repeat(EXPECTED_MAX_QUERY_CHARS + 1),
      }),
    ).rejects.toThrow(`at most ${EXPECTED_MAX_QUERY_CHARS}`);
    await expect(
      tool.execute("limit", {
        action: "search",
        limit: EXPECTED_MAX_SEARCH_LIMIT + 1,
      }),
    ).rejects.toThrow(`1 to ${EXPECTED_MAX_SEARCH_LIMIT}`);

    const dir = tempDirs.make("openclaw-skill-invalid-text-");
    const filePath = path.join(dir, "SKILL.md");
    await fs.writeFile(filePath, Buffer.from([0xff, 0xfe, 0xfd]));
    const invalidText = requireTool(createSnapshot([{ name: "invalid", filePath }]));
    await expect(
      invalidText.execute("invalid", { action: "read", name: "invalid" }),
    ).rejects.toThrow("not valid UTF-8 text");

    const snapshot = createSnapshot([{ name: "legacy" }]);
    const aborted = requireTool(snapshot);
    const controller = new AbortController();
    controller.abort();
    await expect(
      aborted.execute("aborted", { action: "search" }, controller.signal),
    ).rejects.toThrow();
    delete snapshot.modelInvocableSkills;
    expect(createSkillCatalogTool({ skillsSnapshot: snapshot })).toBeNull();
    const duplicate = createSnapshot([{ name: "alpha" }]);
    duplicate.resolvedSkills?.push(duplicate.resolvedSkills[0]!);
    expect(createSkillCatalogTool({ skillsSnapshot: duplicate })).toBeNull();
  });
});
