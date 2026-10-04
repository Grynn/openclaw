import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../shared/json-schema.types.js";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { createWriteTool } from "./sessions/tools/index.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const RELATIVE_PATH = "memory/2026-08-08.md";

let declaredWriteTool: ReturnType<typeof createWriteTool>;
let declaredWriteOutputSchema: JsonSchemaObject;

function baseWriteTool(): AnyAgentTool {
  return {
    ...declaredWriteTool,
    outputSchema: declaredWriteOutputSchema,
    execute: vi.fn(async () => {
      throw new Error("append-only wrapper should not delegate for append params");
    }),
  };
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
    declaredWriteTool = createWriteTool(root);
    const outputSchema = declaredWriteTool.outputSchema;
    if (!isRecord(outputSchema)) {
      throw new Error("The public write tool must declare an object output schema");
    }
    declaredWriteOutputSchema = structuredClone(outputSchema);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function runAppend(): Promise<unknown> {
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });
    const result = await wrapped.execute(
      "call-1",
      { path: RELATIVE_PATH, content: "hello" },
      new AbortController().signal,
      undefined,
    );
    return result.details;
  }

  it("rechecks source authority after provenance work before appending", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "seed\n");
    const originalClaim = {};
    let claim = originalClaim;
    let reachedCommit = false;
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
      memoryWriteProvenance: {
        classifies: async () => true,
        write: async ({ commit }) => {
          reachedCommit = true;
          claim = {};
          await commit();
        },
        clearAfterDelete: async () => {},
      },
    });
    const pending = withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:memory-flush-authority",
        receiptAuthority: () => claim === originalClaim,
      },
      () => wrapped.execute("source-append", { path: RELATIVE_PATH, content: "hello" }),
    );
    await expect(pending).rejects.toThrow("authority is no longer active");
    expect(reachedCommit).toBe(true);
    expect(await fs.readFile(absolute, "utf8")).toBe("seed\n");
  });

  it("returns write-schema-conforming details when creating the memory file", async () => {
    const details = await runAppend();
    expect(details).toEqual({ changed: true });
    expect(validateAgainstDeclaredSchema(details).ok).toBe(true);
  });

  it("does not append a replay of the complete memory file", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const existing = "## Existing memory\n\nKeep this fact.\n";
    await fs.writeFile(absolute, existing, "utf8");
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });

    const result = await wrapped.execute("replayed-snapshot", {
      path: RELATIVE_PATH,
      content: existing.replaceAll("\n", "\r\n"),
    });

    expect(result.details).toEqual({ changed: false });
    expect(validateAgainstDeclaredSchema(result.details).ok).toBe(true);
    expect(await fs.readFile(absolute, "utf8")).toBe(existing);
  });

  it.each([undefined, "seed\n"])(
    "preserves novel Markdown bytes with existing content %j",
    async (existing) => {
      const absolute = path.join(root, RELATIVE_PATH);
      if (existing !== undefined) {
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, existing, "utf8");
      }
      const content = "    indented code  \r\n    second line\t \r\n";
      const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
        root,
        relativePath: RELATIVE_PATH,
      });

      const result = await wrapped.execute("novel-markdown", { path: RELATIVE_PATH, content });

      expect(result.details).toEqual({ changed: true });
      expect(validateAgainstDeclaredSchema(result.details).ok).toBe(true);
      expect(await fs.readFile(absolute, "utf8")).toBe(`${existing ?? ""}${content}`);
    },
  );

  it("keeps whitespace-only replay a no-op", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "seed\n", "utf8");
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });

    const result = await wrapped.execute("whitespace-only", {
      path: RELATIVE_PATH,
      content: " \t\r\n ",
    });

    expect(result.details).toEqual({ changed: false });
    expect(await fs.readFile(absolute, "utf8")).toBe("seed\n");
  });

  it.each(
    [
      {
        name: "mixed line endings and a non-BMP prefix",
        existing: "## Existing 😀\r\n\r\nKeep this fact.\r\n",
        proposedPrefix: "## Existing 😀\n\nKeep this fact.\n",
        suffix: "\r\n    new indented code  \r\n",
      },
      {
        name: "existing Markdown hard-break spaces",
        existing: "Keep this fact.  \r\n",
        proposedPrefix: "Keep this fact.  \n",
        suffix: "    new indented code  \r\n",
      },
      {
        name: "a CRLF suffix after an unterminated existing line",
        existing: "A",
        proposedPrefix: "A",
        suffix: "\r\n    new indented code  \r\n",
      },
      {
        name: "a lone-CR suffix after an unterminated existing line",
        existing: "A",
        proposedPrefix: "A",
        suffix: "\r    new indented code  \r",
      },
    ].flatMap((scenario) =>
      (["host", "sandbox"] as const).map((storage) => ({ scenario, storage })),
    ),
  )(
    "preserves exact novel snapshot bytes with $scenario.name via $storage",
    async ({ scenario, storage }) => {
      const absolute = path.join(root, RELATIVE_PATH);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, scenario.existing, "utf8");
      const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
        root,
        relativePath: RELATIVE_PATH,
        ...(storage === "sandbox"
          ? {
              containerWorkdir: "/workspace",
              sandbox: { root, bridge: createHostSandboxFsBridge(root) },
            }
          : {}),
        memoryWriteProvenance: {
          classifies: async () => true,
          write: async ({ contentAfter, commit }) => {
            await commit();
            expect(await fs.readFile(absolute, "utf8")).toBe(contentAfter);
          },
          clearAfterDelete: async () => {},
        },
      });

      const result = await wrapped.execute("snapshot-markdown", {
        path: RELATIVE_PATH,
        content: `${scenario.proposedPrefix}${scenario.suffix}`,
      });

      expect(result.details).toEqual({ changed: true });
      expect(validateAgainstDeclaredSchema(result.details).ok).toBe(true);
      expect(await fs.readFile(absolute, "utf8")).toBe(`${scenario.existing}${scenario.suffix}`);
    },
  );

  it("does not mistake a shared word prefix for a complete-file snapshot", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "A", "utf8");
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });

    const result = await wrapped.execute("unrelated-prefix", {
      path: RELATIVE_PATH,
      content: "AB  \r\n",
    });

    expect(result.details).toEqual({ changed: true });
    expect(await fs.readFile(absolute, "utf8")).toBe("A\nAB  \r\n");
  });

  it("appends only the novel suffix of a complete-file snapshot", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    const existing = "## Existing memory\n\nKeep this fact.\n";
    const suffix = "\n## New memory\n\nKeep this new fact.";
    await fs.writeFile(absolute, existing, "utf8");
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseWriteTool(), {
      root,
      relativePath: RELATIVE_PATH,
    });

    const result = await wrapped.execute("extended-snapshot", {
      path: RELATIVE_PATH,
      content: `${existing}${suffix}\n`,
    });

    expect(result.details).toEqual({ changed: true });
    expect(validateAgainstDeclaredSchema(result.details).ok).toBe(true);
    expect(await fs.readFile(absolute, "utf8")).toBe(`${existing}${suffix}\n`);
  });

  it("appends schema-conforming results only to the allowed memory file", async () => {
    const absolute = path.join(root, RELATIVE_PATH);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, "seed", "utf-8");
    const baseTool = baseWriteTool();
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(baseTool, {
      root,
      relativePath: RELATIVE_PATH,
    });
    const result = await wrapped.execute("call-append", {
      path: RELATIVE_PATH,
      content: "hello",
    });
    expect(result).toEqual({
      content: [{ type: "text", text: `Appended content to ${RELATIVE_PATH}.` }],
      details: { changed: true },
    });
    expect(validateAgainstDeclaredSchema(result.details).ok).toBe(true);
    expect(await fs.readFile(absolute, "utf-8")).toBe("seed\nhello");
    await expect(
      wrapped.execute("call-sibling", {
        path: "memory/other-day.md",
        content: "wrong target",
      }),
    ).rejects.toThrow(
      `Memory flush writes are restricted to ${RELATIVE_PATH}; use that path only.`,
    );
    expect(baseTool.execute).not.toHaveBeenCalled();
  });

  it.each(["file", "absent"] as const)(
    "rejects @memory paths instead of appending to their allowed sibling (literal: %s)",
    async (literalState) => {
      const allowedPath = path.join(root, RELATIVE_PATH);
      const literalPath = path.join(root, `@${RELATIVE_PATH}`);
      await fs.mkdir(path.dirname(allowedPath), { recursive: true });
      await fs.writeFile(allowedPath, "allowed", "utf8");
      if (literalState === "file") {
        await fs.mkdir(path.dirname(literalPath), { recursive: true });
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
});
