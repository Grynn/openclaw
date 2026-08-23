import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const ROOT_PACKAGE_NAME = "openclaw";
const PACKAGE_LAYOUT_DIRS = new Set(["dist", "src"]);
const packageRootCache = new Map<string, string | null>();
const jsonCache = new Map<string, Record<string, unknown> | null>();

function readJson(filePath: string): Record<string, unknown> | null {
  if (jsonCache.has(filePath)) {
    return jsonCache.get(filePath) ?? null;
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const parsed = isRecord(value) ? value : null;
    jsonCache.set(filePath, parsed);
    return parsed;
  } catch {
    jsonCache.set(filePath, null);
    return null;
  }
}

function resolveLayoutPackageRoot(moduleUrl: string): string | null {
  const moduleDir = path.dirname(fileURLToPath(moduleUrl));
  for (let current = moduleDir; ; current = path.dirname(current)) {
    if (PACKAGE_LAYOUT_DIRS.has(path.basename(current))) {
      // src/dist identifies the owning package. Never walk past this boundary:
      // an outer OpenClaw manifest is not a substitute for missing inner metadata.
      return path.dirname(current);
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
  }
}

function resolveOpenClawPackageRoot(moduleUrl: string): string | null {
  if (packageRootCache.has(moduleUrl)) {
    return packageRootCache.get(moduleUrl) ?? null;
  }
  try {
    const packageRoot = resolveLayoutPackageRoot(moduleUrl);
    const resolved =
      packageRoot && readJson(path.join(packageRoot, "package.json"))?.name === ROOT_PACKAGE_NAME
        ? packageRoot
        : null;
    packageRootCache.set(moduleUrl, resolved);
    return resolved;
  } catch {
    packageRootCache.set(moduleUrl, null);
    return null;
  }
}

export function readOpenClawPackageJsonForModuleUrl(
  moduleUrl: string,
): Record<string, unknown> | null {
  const packageRoot = resolveOpenClawPackageRoot(moduleUrl);
  return packageRoot ? readJson(path.join(packageRoot, "package.json")) : null;
}

export function readOpenClawBuildInfoForModuleUrl(
  moduleUrl: string,
): Record<string, unknown> | null {
  const packageRoot = resolveOpenClawPackageRoot(moduleUrl);
  return packageRoot ? readJson(path.join(packageRoot, "dist", "build-info.json")) : null;
}
