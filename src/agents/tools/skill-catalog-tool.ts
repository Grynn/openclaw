/** Bounded, read-only discovery for the model-authorized workspace skill catalog. */
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { root as fsSafeRoot } from "../../infra/fs-safe.js";
import { walkRootDirectory } from "../../infra/root-walk.js";
import { DEFAULT_MAX_SKILL_FILE_BYTES } from "../../skills/loading/skill-root-discovery.js";
import {
  resolveAuthorizedModelSkills,
  type AuthorizedModelSkill,
} from "../../skills/runtime/model-skill-catalog.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  stringEnum,
} from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import {
  asToolParamsRecord,
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";

export const SKILL_CATALOG_TOOL_NAME = "skill_catalog";
export const SKILL_CATALOG_DEFAULT_SEARCH_LIMIT = 10;
export const SKILL_CATALOG_MAX_SEARCH_LIMIT = 25;
export const SKILL_CATALOG_MAX_QUERY_CHARS = 512;
export const SKILL_CATALOG_MAX_PAGE_BYTES = 12_000;
export const SKILL_CATALOG_MAX_FILE_BYTES = DEFAULT_MAX_SKILL_FILE_BYTES;
export const SKILL_CATALOG_MAX_OUTPUT_BYTES = 32_000;
export const SKILL_CATALOG_MAX_RESOURCE_ENTRIES = 2_000;
export const SKILL_CATALOG_MAX_RESOURCE_PATH_CHARS = 512;
const SKILL_CATALOG_MAX_RESOURCE_DEPTH = 12;
const SKILL_CATALOG_DESCRIPTION_MAX_CHARS = 300;
const SKILL_CATALOG_BLOCKED_RESOURCE_SEGMENTS = new Set(["node_modules"]);

const SkillCatalogToolSchema = Type.Object(
  {
    action: stringEnum(["search", "read", "list_resources", "read_resource"] as const, {
      description:
        "Search skills, read one complete SKILL.md, list its relative support files, or page through one support file.",
    }),
    query: Type.Optional(
      Type.String({
        maxLength: SKILL_CATALOG_MAX_QUERY_CHARS,
        description: "Name or description terms. Omit to list authorized skills.",
      }),
    ),
    limit: optionalPositiveIntegerSchema({
      maximum: SKILL_CATALOG_MAX_SEARCH_LIMIT,
      description: "Result count for search or list_resources.",
    }),
    offset: optionalNonNegativeIntegerSchema({
      description:
        "Exact nextOffset from the preceding search or resource page; defaults to 0. Not valid for read.",
    }),
    name: Type.Optional(
      Type.String({
        maxLength: 256,
        description: "Exact skill name returned by search; required except for search.",
      }),
    ),
    resource: Type.Optional(
      Type.String({
        maxLength: SKILL_CATALOG_MAX_RESOURCE_PATH_CHARS,
        description:
          "Exact relative support-file path returned by list_resources; required for read_resource.",
      }),
    ),
  },
  { additionalProperties: false },
);

const NullableOffsetSchema = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

const SkillCatalogSearchEntrySchema = Type.Object(
  {
    name: Type.String(),
    description: Type.String(),
    version: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const SkillCatalogOutputSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("search"),
      query: Type.String(),
      totalMatches: Type.Integer({ minimum: 0 }),
      offset: Type.Integer({ minimum: 0 }),
      nextOffset: NullableOffsetSchema,
      skills: Type.Array(SkillCatalogSearchEntrySchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("read"),
      name: Type.String(),
      version: Type.Optional(Type.String()),
      totalBytes: Type.Integer({ minimum: 0, maximum: SKILL_CATALOG_MAX_FILE_BYTES }),
      content: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("list_resources"),
      name: Type.String(),
      totalResources: Type.Integer({ minimum: 0 }),
      scanTruncated: Type.Boolean(),
      offset: Type.Integer({ minimum: 0 }),
      nextOffset: NullableOffsetSchema,
      resources: Type.Array(Type.String({ maxLength: SKILL_CATALOG_MAX_RESOURCE_PATH_CHARS })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("read_resource"),
      name: Type.String(),
      resource: Type.String({ maxLength: SKILL_CATALOG_MAX_RESOURCE_PATH_CHARS }),
      totalBytes: Type.Integer({ minimum: 0, maximum: SKILL_CATALOG_MAX_FILE_BYTES }),
      offset: Type.Integer({ minimum: 0 }),
      nextOffset: NullableOffsetSchema,
      bytes: Type.Integer({ minimum: 0, maximum: SKILL_CATALOG_MAX_PAGE_BYTES }),
      content: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function compactDescription(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= SKILL_CATALOG_DESCRIPTION_MAX_CHARS) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, SKILL_CATALOG_DESCRIPTION_MAX_CHARS - 3).trimEnd()}...`;
}

function buildSearchEntry(skill: AuthorizedModelSkill) {
  return {
    name: skill.name,
    description: compactDescription(skill.description),
    ...(skill.promptVersion ? { version: skill.promptVersion } : {}),
  };
}

function scoreSearchMatch(
  skill: AuthorizedModelSkill,
  normalizedQuery: string,
): number | undefined {
  if (!normalizedQuery) {
    return 0;
  }
  const normalizedName = normalizeSearchText(skill.name);
  const normalizedDescription = normalizeSearchText(skill.description);
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  if (
    !tokens.every(
      (token) => normalizedName.includes(token) || normalizedDescription.includes(token),
    )
  ) {
    return undefined;
  }
  let score = 0;
  if (normalizedName === normalizedQuery) {
    score += 1_000;
  } else if (normalizedName.startsWith(normalizedQuery)) {
    score += 700;
  } else if (normalizedName.includes(normalizedQuery)) {
    score += 500;
  }
  for (const token of tokens) {
    score += normalizedName.includes(token) ? 50 : 5;
  }
  return score;
}

function decodeTextBuffer(buffer: Buffer, label: string): void {
  const content = buffer.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(buffer) || content.includes("\0")) {
    throw new ToolInputError(`${label} is not valid UTF-8 text.`);
  }
}

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function serializedBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload, null, 2), "utf8");
}

// Skill guidance must be consumed whole: reject overflow instead of returning a
// plausible-looking first page. Large supporting detail belongs in resources.
function buildAtomicSkillResult(skill: AuthorizedModelSkill, buffer: Buffer) {
  const payload = {
    action: "read" as const,
    name: skill.name,
    ...(skill.promptVersion ? { version: skill.promptVersion } : {}),
    totalBytes: buffer.byteLength,
    content: buffer.toString("utf8"),
  };
  if (serializedBytes(payload) > SKILL_CATALOG_MAX_OUTPUT_BYTES) {
    throw new ToolInputError(
      `Skill "${skill.name}" cannot be returned whole within ${SKILL_CATALOG_MAX_OUTPUT_BYTES} bytes. Move supporting detail into listed resource files and retry.`,
    );
  }
  return payload;
}

function buildBoundedResultPage<T>(params: {
  values: readonly T[];
  offset: number;
  limit: number;
  build: (page: T[], nextOffset: number | null) => unknown;
}) {
  if (params.offset > params.values.length) {
    throw new ToolInputError(`offset must be at most ${params.values.length}`);
  }
  const page = params.values.slice(params.offset, params.offset + params.limit);
  while (true) {
    const end = params.offset + page.length;
    const payload = params.build(page, end < params.values.length ? end : null);
    if (serializedBytes(payload) <= SKILL_CATALOG_MAX_OUTPUT_BYTES) {
      return payload;
    }
    if (page.length <= 1) {
      throw new ToolInputError("The selected catalog entry exceeds the output limit.");
    }
    page.pop();
  }
}

function nextUtf8Boundary(buffer: Buffer, offset: number): number {
  let end = offset + 1;
  while (end < buffer.length && isUtf8ContinuationByte(buffer[end])) {
    end += 1;
  }
  return end;
}

function pageEndForBudget(buffer: Buffer, offset: number, byteBudget: number): number {
  let end = Math.min(buffer.length, offset + byteBudget);
  if (end === buffer.length) {
    return end;
  }
  while (end > offset && isUtf8ContinuationByte(buffer[end])) {
    end -= 1;
  }
  return end > offset ? end : nextUtf8Boundary(buffer, offset);
}

function buildTextPage(params: {
  buffer: Buffer;
  offset: number;
  build: (page: { bytes: number; content: string; nextOffset: number | null }) => unknown;
}) {
  if (params.offset > params.buffer.length) {
    throw new ToolInputError(`offset must be at most ${params.buffer.length}`);
  }
  if (
    params.offset < params.buffer.length &&
    isUtf8ContinuationByte(params.buffer[params.offset])
  ) {
    throw new ToolInputError("offset must be an exact nextOffset returned by this read.");
  }
  let byteBudget = Math.min(SKILL_CATALOG_MAX_PAGE_BYTES, params.buffer.length - params.offset);
  while (true) {
    const end = pageEndForBudget(params.buffer, params.offset, byteBudget);
    const bytes = end - params.offset;
    const payload = params.build({
      bytes,
      content: params.buffer.subarray(params.offset, end).toString("utf8"),
      nextOffset: end < params.buffer.length ? end : null,
    });
    if (serializedBytes(payload) <= SKILL_CATALOG_MAX_OUTPUT_BYTES) {
      return payload;
    }
    if (bytes <= 1) {
      throw new ToolInputError("The selected text page exceeds the output limit.");
    }
    byteBudget = Math.max(1, Math.floor(byteBudget / 2));
  }
}

function normalizeResourcePath(value: string): string {
  let hasAsciiControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      hasAsciiControlCharacter = true;
      break;
    }
  }
  if (
    value.length > SKILL_CATALOG_MAX_RESOURCE_PATH_CHARS ||
    Buffer.byteLength(value, "utf8") > SKILL_CATALOG_MAX_RESOURCE_PATH_CHARS * 4 ||
    hasAsciiControlCharacter ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    throw new ToolInputError(
      "resource must be an exact safe relative path returned by list_resources.",
    );
  }
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        segment.trim() !== segment ||
        segment === "." ||
        segment === ".." ||
        segment.startsWith(".") ||
        SKILL_CATALOG_BLOCKED_RESOURCE_SEGMENTS.has(segment),
    ) ||
    value === "SKILL.md"
  ) {
    throw new ToolInputError(
      "resource must be an exact safe relative path returned by list_resources.",
    );
  }
  return value;
}

function shouldSkipResourceSubtree(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some(
      (segment) => segment.startsWith(".") || SKILL_CATALOG_BLOCKED_RESOURCE_SEGMENTS.has(segment),
    );
}

async function readLocalSkillText(params: {
  skill: AuthorizedModelSkill;
  relativePath: string;
  label: string;
}): Promise<Buffer> {
  if (!params.skill.resourceRoot) {
    throw new ToolInputError(
      `Skill "${params.skill.name}" does not publish local support files through this catalog.`,
    );
  }
  try {
    const capability = await fsSafeRoot(params.skill.resourceRoot);
    const read = await capability.read(params.relativePath, {
      hardlinks: "reject",
      maxBytes: SKILL_CATALOG_MAX_FILE_BYTES,
      symlinks: "reject",
    });
    decodeTextBuffer(read.buffer, params.label);
    return read.buffer;
  } catch (error) {
    if (error instanceof ToolInputError) {
      throw error;
    }
    throw new ToolInputError(
      `${params.label} could not be read safely or exceeds ${SKILL_CATALOG_MAX_FILE_BYTES} bytes.`,
    );
  }
}

async function listLocalSkillResources(
  skill: AuthorizedModelSkill,
  signal?: AbortSignal,
): Promise<{ resources: string[]; scanTruncated: boolean }> {
  if (!skill.resourceRoot) {
    throw new ToolInputError(
      `Skill "${skill.name}" does not publish local support files through this catalog.`,
    );
  }
  const resources = new Set<string>();
  let scanTruncated = false;
  try {
    for await (const entry of walkRootDirectory(skill.resourceRoot, "", {
      maxDepth: SKILL_CATALOG_MAX_RESOURCE_DEPTH,
      maxEntries: SKILL_CATALOG_MAX_RESOURCE_ENTRIES,
      symlinkPolicy: "skip",
      signal,
      limitBehavior: "truncate",
      onDirectoryError: "skip-and-report",
      entryFilter: (candidate) => {
        if (shouldSkipResourceSubtree(candidate.relativePath)) {
          return candidate.kind === "directory" ? "skip-subtree" : "skip";
        }
        return candidate.kind === "file" ? "include" : "skip";
      },
    })) {
      if (entry.kind === "truncated") {
        scanTruncated = true;
        break;
      }
      if (entry.kind === "directory-error") {
        scanTruncated = true;
        continue;
      }
      if (entry.kind !== "file" || entry.relativePath === "SKILL.md") {
        continue;
      }
      try {
        resources.add(normalizeResourcePath(entry.relativePath));
      } catch {
        continue;
      }
    }
  } catch {
    signal?.throwIfAborted();
    throw new ToolInputError(`Skill "${skill.name}" resources could not be listed safely.`);
  }
  signal?.throwIfAborted();
  return {
    resources: [...resources].toSorted((left, right) => left.localeCompare(right)),
    scanTruncated,
  };
}

function requireSkill(
  byExactName: ReadonlyMap<string, AuthorizedModelSkill>,
  params: Record<string, unknown>,
): AuthorizedModelSkill {
  const name = readToolStringParam(params, "name", { required: true });
  const skill = byExactName.get(name);
  if (!skill) {
    throw new ToolInputError(
      `Unknown skill "${name}". Search ${SKILL_CATALOG_TOOL_NAME} first and use an exact returned name.`,
    );
  }
  return skill;
}

/** Creates the tool only when a complete, unambiguous authorized catalog is available. */
export function createSkillCatalogTool(options: {
  skillsSnapshot?: SkillSnapshot;
}): AnyAgentTool | null {
  const catalog = resolveAuthorizedModelSkills(options.skillsSnapshot);
  if (catalog.length === 0) {
    return null;
  }
  const byExactName = new Map(catalog.map((skill) => [skill.name, skill]));
  const contentCache = new Map<string, Buffer>();
  const resourceListCache = new Map<string, { resources: string[]; scanTruncated: boolean }>();
  const loadResourceList = async (skill: AuthorizedModelSkill, signal?: AbortSignal) => {
    const cached = resourceListCache.get(skill.name);
    if (cached) {
      return cached;
    }
    const listing = await listLocalSkillResources(skill, signal);
    resourceListCache.set(skill.name, listing);
    return listing;
  };
  const loadContent = async (params: {
    skill: AuthorizedModelSkill;
    resource?: string;
    signal?: AbortSignal;
  }) => {
    const cacheKey = JSON.stringify([params.skill.name, params.resource ?? null]);
    const cached = contentCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    params.signal?.throwIfAborted();
    let buffer: Buffer;
    if (params.resource) {
      buffer = await readLocalSkillText({
        skill: params.skill,
        relativePath: params.resource,
        label: `Resource "${params.resource}" for skill "${params.skill.name}"`,
      });
    } else if (params.skill.readContent !== undefined) {
      buffer = Buffer.from(params.skill.readContent, "utf8");
      decodeTextBuffer(buffer, `Skill "${params.skill.name}"`);
      if (buffer.byteLength > SKILL_CATALOG_MAX_FILE_BYTES) {
        throw new ToolInputError(
          `Skill "${params.skill.name}" exceeds ${SKILL_CATALOG_MAX_FILE_BYTES} bytes.`,
        );
      }
    } else {
      buffer = await readLocalSkillText({
        skill: params.skill,
        relativePath: "SKILL.md",
        label: `Skill "${params.skill.name}"`,
      });
    }
    params.signal?.throwIfAborted();
    contentCache.set(cacheKey, buffer);
    return buffer;
  };

  return {
    label: "Skill Catalog",
    name: SKILL_CATALOG_TOOL_NAME,
    description:
      "Search model-authorized OpenClaw skills without exposing host paths. The read action returns one complete SKILL.md and does not accept offset or limit. Use list_resources and read_resource for paged relative references, scripts, templates, or assets; pass only exact returned names, paths, and offsets.",
    parameters: SkillCatalogToolSchema,
    outputSchema: SkillCatalogOutputSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      signal?.throwIfAborted();
      const params = asToolParamsRecord(rawParams);
      const action = readToolStringParam(params, "action", { required: true });
      if (action === "search") {
        const offset = readNonNegativeIntegerParam(params, "offset") ?? 0;
        const query = readToolStringParam(params, "query") ?? "";
        if (query.length > SKILL_CATALOG_MAX_QUERY_CHARS) {
          throw new ToolInputError(
            `query must be at most ${SKILL_CATALOG_MAX_QUERY_CHARS} characters`,
          );
        }
        const limit =
          readPositiveIntegerParam(params, "limit", {
            max: SKILL_CATALOG_MAX_SEARCH_LIMIT,
            message: `limit must be an integer from 1 to ${SKILL_CATALOG_MAX_SEARCH_LIMIT}`,
          }) ?? SKILL_CATALOG_DEFAULT_SEARCH_LIMIT;
        const normalizedQuery = normalizeSearchText(query);
        const matches = catalog
          .map((skill) => ({ skill, score: scoreSearchMatch(skill, normalizedQuery) }))
          .filter(
            (entry): entry is { skill: AuthorizedModelSkill; score: number } =>
              entry.score !== undefined,
          )
          .toSorted(
            (left, right) =>
              right.score - left.score || left.skill.name.localeCompare(right.skill.name),
          );
        signal?.throwIfAborted();
        return jsonResult(
          buildBoundedResultPage({
            values: matches,
            offset,
            limit,
            build: (page, nextOffset) => ({
              action: "search" as const,
              query,
              totalMatches: matches.length,
              offset,
              nextOffset,
              skills: page.map(({ skill }) => buildSearchEntry(skill)),
            }),
          }),
        );
      }

      const skill = requireSkill(byExactName, params);
      if (action === "read") {
        if (params.offset !== undefined || params.limit !== undefined) {
          throw new ToolInputError(
            "read does not accept offset or limit; it returns SKILL.md whole.",
          );
        }
        const buffer = await loadContent({ skill, signal });
        return jsonResult(buildAtomicSkillResult(skill, buffer));
      }
      if (action === "list_resources") {
        const offset = readNonNegativeIntegerParam(params, "offset") ?? 0;
        const limit =
          readPositiveIntegerParam(params, "limit", {
            max: SKILL_CATALOG_MAX_SEARCH_LIMIT,
            message: `limit must be an integer from 1 to ${SKILL_CATALOG_MAX_SEARCH_LIMIT}`,
          }) ?? SKILL_CATALOG_DEFAULT_SEARCH_LIMIT;
        const listing = await loadResourceList(skill, signal);
        return jsonResult(
          buildBoundedResultPage({
            values: listing.resources,
            offset,
            limit,
            build: (resources, nextOffset) => ({
              action: "list_resources" as const,
              name: skill.name,
              totalResources: listing.resources.length,
              scanTruncated: listing.scanTruncated,
              offset,
              nextOffset,
              resources,
            }),
          }),
        );
      }
      if (action === "read_resource") {
        const offset = readNonNegativeIntegerParam(params, "offset") ?? 0;
        const resource = normalizeResourcePath(
          readToolStringParam(params, "resource", { required: true }),
        );
        const listing = await loadResourceList(skill, signal);
        // The canonical, symlink-free listing is the read capability boundary;
        // a lexically safe guessed path is not sufficient authority.
        if (!listing.resources.includes(resource)) {
          throw new ToolInputError(
            `Unknown resource "${resource}" for skill "${skill.name}". Use an exact path returned by list_resources.`,
          );
        }
        const buffer = await loadContent({ skill, resource, signal });
        return jsonResult(
          buildTextPage({
            buffer,
            offset,
            build: (page) => ({
              action: "read_resource" as const,
              name: skill.name,
              resource,
              totalBytes: buffer.byteLength,
              offset,
              ...page,
            }),
          }),
        );
      }
      throw new ToolInputError(
        'action must be "search", "read", "list_resources", or "read_resource"',
      );
    },
  };
}
