import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createWriteTool } from "./sessions/tools/index.js";

const RELATIVE_PATH = "memory/2026-08-08.md";

let declaredWriteOutputSchema: Parameters<typeof validateJsonSchemaValue>[0]["schema"];

function baseWriteTool(): AnyAgentTool {
  return {
    name: "write",
    description: "Write a file.",
    parameters: { type: "object", properties: {} },
    outputSchema: declaredWriteOutputSchema,
    execute: async () => {
      throw new Error("append-only wrapper should not delegate for append params");
    },
  } as unknown as AnyAgentTool;
}

function validateAgainstDeclaredSchema(value: unknown) {
  return validateJsonSchemaValue({
    schema: declaredWriteOutputSchema,
    cacheKey: "test:memory-flush-write-output",
    value,
    cache: false,
  });
}

describe("wrapToolMemoryFlushAppendOnlyWrite output contract", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-flush-write-"));
    // Mirror the catalog path: declared schemas are JSON-serialized before the
    // bridge validates results against them. Read the schema from the public
    // tool factory so production internals do not need a test-only export.
    const writeTool = createWriteTool(root) as unknown as AnyAgentTool;
    declaredWriteOutputSchema = structuredClone(writeTool.outputSchema) as unknown as Parameters<
      typeof validateJsonSchemaValue
    >[0]["schema"];
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function runAppend(content = "hello"): Promise<unknown> {
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });
    const result = await wrapped.execute(
      "call-1",
      { path: RELATIVE_PATH, content },
      new AbortController().signal,
      undefined,
    );
    return (result as { details?: unknown }).details;
  }

  it("returns write-schema-conforming details when creating the memory file", async () => {
    const details = await runAppend();
    expect(details).toEqual({ changed: true });
    expect(validateAgainstDeclaredSchema(details).ok).toBe(true);
  });

  it("returns write-schema-conforming details when appending to an existing file", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "seed\n", "utf-8");
    const details = await runAppend();
    expect(details).toEqual({ changed: true });
    expect(validateAgainstDeclaredSchema(details).ok).toBe(true);
    expect(await fs.readFile(absolute, "utf-8")).toBe("seed\nhello");
  });

  it.each(["file", "ancestor", "absent"] as const)(
    "rejects @memory paths instead of appending to their allowed sibling (literal: %s)",
    async (literalState) => {
      const allowedPath = path.join(root, RELATIVE_PATH);
      const literalPath = path.join(root, `@${RELATIVE_PATH}`);
      await fs.mkdir(path.dirname(allowedPath), { recursive: true });
      await fs.writeFile(allowedPath, "allowed", "utf8");
      if (literalState !== "absent") {
        await fs.mkdir(path.dirname(literalPath), { recursive: true });
      }
      if (literalState === "file") {
        await fs.writeFile(literalPath, "literal", "utf8");
      }
      const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
        root,
        relativePath: RELATIVE_PATH,
      });

      await expect(
        wrapped.execute("at-memory-flush", {
          path: `@${RELATIVE_PATH}`,
          content: "wrong journal",
        }),
      ).rejects.toThrow(/Memory flush writes are restricted/);
      await expect(fs.readFile(allowedPath, "utf8")).resolves.toBe("allowed");
      if (literalState === "file") {
        await expect(fs.readFile(literalPath, "utf8")).resolves.toBe("literal");
      }
    },
  );

  it("documents the pre-fix regression: append-only metadata violates the declared schema", () => {
    const validation = validateAgainstDeclaredSchema({ path: RELATIVE_PATH, appendOnly: true });
    expect(validation.ok).toBe(false);
  });
  it("appends only the novel suffix when the model returns the complete file", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "# Day\n\n- Existing fact.\n", "utf-8");

    const details = await runAppend(
      "# Day\r\n\r\n- Existing fact.\r\n\r\n## New\r\n\r\n- Novel fact.\r\n",
    );

    expect(details).toEqual({ changed: true });
    await expect(fs.readFile(absolute, "utf-8")).resolves.toBe(
      "# Day\n\n- Existing fact.\n\n## New\n\n- Novel fact.",
    );
  });

  it("reports no change for an exact replay already present on line boundaries", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "# Day\n\n## Durable\n\n- Existing fact.\n", "utf-8");

    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });
    const result = await wrapped.execute(
      "call-replay",
      { path: RELATIVE_PATH, content: "## Durable\n\n- Existing fact." },
      new AbortController().signal,
      undefined,
    );

    expect(result).toEqual({
      content: [{ type: "text", text: `No new content to append to ${RELATIVE_PATH}.` }],
      details: { changed: false },
    });
    expect(validateAgainstDeclaredSchema((result as { details?: unknown }).details).ok).toBe(true);
    await expect(fs.readFile(absolute, "utf-8")).resolves.toBe(
      "# Day\n\n## Durable\n\n- Existing fact.\n",
    );
  });

  it("does not fuzzy-dedupe similar but changed prose", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "- Position is $100.\n", "utf-8");

    await runAppend("- Position is $101.\n");

    await expect(fs.readFile(absolute, "utf-8")).resolves.toBe(
      "- Position is $100.\n- Position is $101.",
    );
  });

  it("keeps an ordinary novel append", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "# Day\n", "utf-8");

    await runAppend("## New\n\n- Fact.\n");

    await expect(fs.readFile(absolute, "utf-8")).resolves.toBe("# Day\n## New\n\n- Fact.");
  });
});
