import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { root as fsRoot } from "../infra/fs-safe.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export type MemoryFlushFileSandbox = {
  root: string;
  bridge: SandboxFsBridge;
};

export async function readOptionalUtf8File(params: {
  absolutePath: string;
  relativePath: string;
  sandbox?: MemoryFlushFileSandbox;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    if (params.sandbox) {
      const stat = await params.sandbox.bridge.stat({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      if (!stat) {
        return "";
      }
      const buffer = await params.sandbox.bridge.readFile({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      return buffer.toString("utf-8");
    }
    return await fs.readFile(params.absolutePath, "utf-8");
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return "";
    }
    throw error;
  }
}

export async function appendMemoryFlushContent(params: {
  absolutePath: string;
  root: string;
  relativePath: string;
  content: string;
  sandbox?: MemoryFlushFileSandbox;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<boolean> {
  // The caller already resolved the novel suffix. Resolving again here would
  // trim the leading blank line that separates the appended section.
  const content = params.content;
  if (!content) {
    return false;
  }
  if (!params.sandbox) {
    const root = await fsRoot(params.root);
    params.assertCurrent();
    await root.append(params.relativePath, content, {
      mkdir: true,
      // fs-safe recognizes a leading LF; a preserved CR or CRLF is a separator too.
      prependNewlineIfNeeded: !content.startsWith("\r"),
      assertBeforeMutation: params.assertCurrent,
    });
    return true;
  }

  const existing = await readOptionalUtf8File({
    absolutePath: params.absolutePath,
    relativePath: params.relativePath,
    sandbox: params.sandbox,
    signal: params.signal,
  });
  const separator =
    existing.length > 0 &&
    !existing.endsWith("\n") &&
    !content.startsWith("\n") &&
    !content.startsWith("\r")
      ? "\n"
      : "";
  const next = `${existing}${separator}${content}`;
  const parent = path.posix.dirname(params.relativePath);
  params.assertCurrent();
  if (parent && parent !== ".") {
    await params.sandbox.bridge.mkdirp({
      filePath: parent,
      cwd: params.sandbox.root,
      signal: params.signal,
    });
  }
  params.assertCurrent();
  await params.sandbox.bridge.writeFile({
    filePath: params.relativePath,
    cwd: params.sandbox.root,
    data: next,
    mkdir: true,
    signal: params.signal,
  });
  return true;
}

/**
 * Models occasionally pass the complete file snapshot to an append-only memory
 * write. Appending that snapshot duplicates every prior section. Keep this
 * boundary idempotent by stripping an exact existing-file prefix and rejecting
 * an exact payload replay. Comparisons normalize only line endings and outer
 * whitespace; novel prose is never fuzzy-matched or rewritten.
 */
export function resolveNovelMemoryFlushContent(existing: string, proposed: string): string {
  const existingLines = existing.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const proposedLines = proposed.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const existingNormalized = existingLines.trim();
  const proposedNormalized = proposedLines.trim();
  if (!proposedNormalized) {
    return "";
  }
  if (!existingNormalized) {
    return proposed;
  }
  if (proposedNormalized === existingNormalized) {
    return "";
  }
  // Prefer the complete prefix, including Markdown hard-break spaces and its
  // trailing newlines. A shared word prefix alone is not a file snapshot.
  const existingPrefix = existingLines.trimStart();
  const proposedPrefix = proposedLines.trimStart();
  const hasExactPrefix =
    proposedPrefix.startsWith(existingPrefix) &&
    (existingPrefix.endsWith("\n") || proposedPrefix[existingPrefix.length] === "\n");
  if (!hasExactPrefix && !proposedNormalized.startsWith(`${existingNormalized}\n`)) {
    return proposed;
  }

  // Normalized offsets are UTF-16 code units. Map the matched prefix back to
  // the original payload so novel indentation, line endings and spaces survive.
  const prefixLength = hasExactPrefix ? existingPrefix.length : existingNormalized.length;
  const rawProposed = proposed.trimStart();
  let rawOffset = 0;
  for (let offset = 0; offset < prefixLength; offset += 1) {
    rawOffset += rawProposed[rawOffset] === "\r" && rawProposed[rawOffset + 1] === "\n" ? 2 : 1;
  }
  const suffix = rawProposed.slice(rawOffset);
  // Only the trimmed-prefix fallback still includes the existing final newline.
  return !hasExactPrefix && /\n\s*$/u.test(existing)
    ? suffix.replace(/^(?:\r\n|\r|\n)/u, "")
    : suffix;
}
