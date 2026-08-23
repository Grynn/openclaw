import { readOpenClawBuildInfoForModuleUrl } from "../infra/openclaw-package-metadata.js";

/** Reads the package build stamp once through Node's JSON module cache. */
export function bundledCatalogGeneratedAt(moduleUrl = import.meta.url): number | undefined {
  const info = readOpenClawBuildInfoForModuleUrl(moduleUrl);
  if (typeof info?.builtAt !== "string") {
    return undefined;
  }
  const generatedAt = Date.parse(info.builtAt);
  return Number.isFinite(generatedAt) && generatedAt > 0 ? generatedAt : undefined;
}
