import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { bundledCatalogGeneratedAt } from "./bundled-catalog-stamp.js";

async function writeJson(root: string, relativePath: string, value: unknown): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value), "utf-8");
}

function moduleUrl(root: string, relativePath: string): string {
  return pathToFileURL(path.join(root, relativePath)).href;
}

describe("bundled catalog build stamp", () => {
  it("reads only the owning package's canonical build-info", async () => {
    await withTestDir({ prefix: "openclaw-catalog-stamp-" }, async (root) => {
      const builtAt = "2026-08-24T00:00:00.000Z";
      await writeJson(root, "package.json", { name: "openclaw" });
      await writeJson(root, "dist/build-info.json", { builtAt });
      await writeJson(root, "dist/model-catalog/build-info.json", {
        builtAt: "2020-01-01T00:00:00.000Z",
      });
      await writeJson(root, "dist/model-catalog/runtime/package.json", { name: "openclaw" });
      await writeJson(root, "dist/model-catalog/runtime/dist/build-info.json", {
        builtAt: "2019-01-01T00:00:00.000Z",
      });

      expect(
        bundledCatalogGeneratedAt(moduleUrl(root, "dist/model-catalog/runtime/index.js")),
      ).toBe(Date.parse(builtAt));
    });
  });

  it.each([
    { name: "missing", buildInfo: undefined },
    { name: "malformed", buildInfo: "{ invalid" },
  ])(
    "does not fall back to an ancestor stamp when canonical build-info is $name",
    async ({ buildInfo }) => {
      await withTestDir({ prefix: "openclaw-catalog-stamp-" }, async (root) => {
        await writeJson(root, "package.json", { name: "openclaw" });
        await writeJson(root, "build-info.json", { builtAt: "2020-01-01T00:00:00.000Z" });
        if (buildInfo !== undefined) {
          await fs.mkdir(path.join(root, "dist"), { recursive: true });
          await fs.writeFile(path.join(root, "dist/build-info.json"), buildInfo, "utf-8");
        }

        expect(
          bundledCatalogGeneratedAt(moduleUrl(root, "dist/model-catalog/index.js")),
        ).toBeUndefined();
      });
    },
  );
});
