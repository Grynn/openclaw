import { readToolStringParam, ToolInputError } from "./common.js";

export const SESSIONS_SEARCH_MAX_BATCH_QUERIES = 8;
export const SESSIONS_SEARCH_MAX_QUERY_CHARS = 4096;

export type BatchSearchQueryState<Hit extends object> = {
  visibleHits: Hit[];
  indexing: boolean;
  backendTruncated: boolean;
};

const SEARCH_QUERY_MARK_RE = /\p{Mark}/u;
const SEARCH_QUERY_LATIN_RE = /\p{Script=Latin}/u;
const SEARCH_QUERY_TOKEN_CHAR_RE = /[\p{Letter}\p{Number}\p{Private_Use}]/u;
const SEARCH_QUERY_TOKEN_SEPARATOR = "\u0001";
const SEARCH_QUERY_PHRASE_SEPARATOR = "\u0002";
const SEARCH_QUERY_SIMPLE_FOLD_EXCEPTIONS = new Map([
  ["µ", "μ"],
  ["ſ", "s"],
  ["ς", "σ"],
  ["ϐ", "β"],
  ["ϑ", "θ"],
  ["ϕ", "φ"],
  ["ϖ", "π"],
  ["ϰ", "κ"],
  ["ϱ", "ρ"],
  ["ϵ", "ε"],
  ["ẛ", "ṡ"],
  ["ι", "ι"],
]);

function isUnicode61Diacritic(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? -1;
  if (codePoint < 0x300 || codePoint > 0x331) {
    return false;
  }
  const offset = codePoint - 0x300;
  const mask = offset < 32 ? 0x08029fdf : 0x000361f8;
  return ((mask >>> (offset & 31)) & 1) === 1;
}

function foldUnicode61TokenCharacter(character: string): string {
  // Whole-string lowercasing is contextual; unicode61 folds each code point.
  const folded = SEARCH_QUERY_SIMPLE_FOLD_EXCEPTIONS.get(character) ?? character.toLowerCase();
  if (!SEARCH_QUERY_LATIN_RE.test(character)) {
    return folded;
  }
  return Array.from(folded.normalize("NFD"))
    .filter((part) => !SEARCH_QUERY_MARK_RE.test(part))
    .join("");
}

function tokenizeUnicode61Phrase(phrase: string): string {
  const tokens: string[] = [];
  let token = "";
  for (const character of phrase) {
    if (SEARCH_QUERY_TOKEN_CHAR_RE.test(character)) {
      token += foldUnicode61TokenCharacter(character);
      continue;
    }
    // unicode61 ignores this exact generated diacritic set within a token.
    if (token && isUnicode61Diacritic(character)) {
      continue;
    }
    if (token) {
      tokens.push(token);
      token = "";
    }
  }
  if (token) {
    tokens.push(token);
  }
  return tokens.join(SEARCH_QUERY_TOKEN_SEPARATOR);
}

/** Mirror the configured unicode61 folding and phrase boundaries for duplicate detection. */
function normalizeSearchQueryKey(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .map(tokenizeUnicode61Phrase)
    .join(SEARCH_QUERY_PHRASE_SEPARATOR);
}

export function readSearchQueries(params: Record<string, unknown>): {
  queries: string[];
  batch: boolean;
} {
  const query = readToolStringParam(params, "query");
  const rawQueries = params.queries;
  if (query !== undefined && rawQueries !== undefined) {
    throw new ToolInputError("use query or queries, not both");
  }
  if (rawQueries !== undefined) {
    if (!Array.isArray(rawQueries)) {
      throw new ToolInputError("queries must be an array");
    }
    if (rawQueries.length === 0 || rawQueries.length > SESSIONS_SEARCH_MAX_BATCH_QUERIES) {
      throw new ToolInputError(`queries must contain 1-${SESSIONS_SEARCH_MAX_BATCH_QUERIES} items`);
    }
    const firstIndexByQuery = new Map<string, number>();
    const queries = rawQueries.map((value, index) => {
      if (typeof value !== "string" || !value.trim()) {
        throw new ToolInputError(`queries[${index}] must not be empty`);
      }
      const normalized = value.trim();
      if (normalized.length > SESSIONS_SEARCH_MAX_QUERY_CHARS) {
        throw new ToolInputError(
          `queries[${index}] must not exceed ${SESSIONS_SEARCH_MAX_QUERY_CHARS} characters`,
        );
      }
      const duplicateKey = normalizeSearchQueryKey(normalized);
      const duplicateIndex = firstIndexByQuery.get(duplicateKey);
      if (duplicateIndex !== undefined) {
        throw new ToolInputError(`queries[${index}] duplicates queries[${duplicateIndex}]`);
      }
      firstIndexByQuery.set(duplicateKey, index);
      return normalized;
    });
    return { queries, batch: true };
  }
  if (!query) {
    throw new ToolInputError("query must not be empty");
  }
  if (query.length > SESSIONS_SEARCH_MAX_QUERY_CHARS) {
    throw new ToolInputError(`query must not exceed ${SESSIONS_SEARCH_MAX_QUERY_CHARS} characters`);
  }
  return { queries: [query], batch: false };
}

/** Interleave bounded chunks so one large agent store cannot starve smaller stores. */
export function interleaveSearchChunks<Item>(
  groups: Array<[string, Item[]]>,
  chunkSize: number,
): Array<{ groupKey: string; items: Item[] }> {
  const chunks: Array<{ groupKey: string; items: Item[] }> = [];
  for (let offset = 0; ; offset += chunkSize) {
    let added = false;
    for (const [groupKey, items] of groups) {
      const chunk = items.slice(offset, offset + chunkSize);
      if (chunk.length > 0) {
        chunks.push({ groupKey, items: chunk });
        added = true;
      }
    }
    if (!added) {
      return chunks;
    }
  }
}

function buildBatchSearchPayload<Hit extends object>(params: {
  states: Array<BatchSearchQueryState<Hit>>;
  results: Array<Hit & { queryIndex: number }>;
  limit: number;
  byteTruncated: ReadonlySet<number>;
  indexingWarning: string;
  sessionLinkRule?: string;
}) {
  const indexingQueries = params.states.flatMap((state, queryIndex) =>
    state.indexing ? [queryIndex] : [],
  );
  const truncatedQueries = params.states.flatMap((state, queryIndex) =>
    state.backendTruncated ||
    state.visibleHits.length > params.limit ||
    params.byteTruncated.has(queryIndex)
      ? [queryIndex]
      : [],
  );
  return {
    results: params.results,
    batch: true as const,
    queryCount: params.states.length,
    ...(params.sessionLinkRule ? { sessionLinkRule: params.sessionLinkRule } : {}),
    ...(indexingQueries.length > 0
      ? {
          indexing: true as const,
          indexingQueries,
          warning: params.indexingWarning,
        }
      : {}),
    ...(truncatedQueries.length > 0 ? { truncated: true as const, truncatedQueries } : {}),
  };
}

/** Fairly interleaves query hits while bounding the exact pretty-printed tool payload. */
export function capBatchSearchHits<Hit extends object>(params: {
  states: Array<BatchSearchQueryState<Hit>>;
  limit: number;
  maxBytes: number;
  indexingWarning: string;
  sessionLinkRule?: string;
}) {
  const results: Array<Hit & { queryIndex: number }> = [];
  const byteTruncated = new Set<number>();
  const sizingTruncated = new Set(params.states.keys());
  const candidates = params.states.map((state) => state.visibleHits.slice(0, params.limit));
  for (let hitIndex = 0; hitIndex < params.limit; hitIndex += 1) {
    for (let queryIndex = 0; queryIndex < candidates.length; queryIndex += 1) {
      const hit = candidates[queryIndex]?.[hitIndex];
      if (!hit) {
        continue;
      }
      results.push({ ...hit, queryIndex });
      const sizingPayload = buildBatchSearchPayload({
        states: params.states,
        results,
        limit: params.limit,
        byteTruncated: sizingTruncated,
        indexingWarning: params.indexingWarning,
        sessionLinkRule: params.sessionLinkRule,
      });
      // Reserve all possible truncation markers so the final payload cannot grow past the cap.
      if (Buffer.byteLength(JSON.stringify(sizingPayload, null, 2), "utf8") > params.maxBytes) {
        results.pop();
        byteTruncated.add(queryIndex);
      }
    }
  }
  return buildBatchSearchPayload({
    states: params.states,
    results,
    limit: params.limit,
    byteTruncated,
    indexingWarning: params.indexingWarning,
    sessionLinkRule: params.sessionLinkRule,
  });
}
