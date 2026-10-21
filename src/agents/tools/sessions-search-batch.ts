import { ToolInputError } from "./common.js";

export const SESSIONS_SEARCH_MAX_QUERY_CHARS = 4096;
export const SESSIONS_SEARCH_MAX_BYTES = 32 * 1024;

export function readSearchQueries(params: Record<string, unknown>): {
  queries: string[];
  batch: boolean;
} {
  const batch = params.queries !== undefined;
  if (batch && params.query !== undefined) {
    throw new ToolInputError("Use query or queries, not both");
  }
  const raw = batch ? params.queries : [params.query];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 8) {
    throw new ToolInputError("queries must contain between 1 and 8 non-empty queries");
  }
  const queries = raw.map((value: unknown) => (typeof value === "string" ? value.trim() : ""));
  if (queries.some((query) => !query)) {
    throw new ToolInputError(
      "query must not be empty; retry with non-empty keywords to match in past session text",
    );
  }
  if (queries.some((query) => query.length > SESSIONS_SEARCH_MAX_QUERY_CHARS)) {
    throw new ToolInputError(`query must not exceed ${SESSIONS_SEARCH_MAX_QUERY_CHARS} characters`);
  }
  return { queries, batch };
}

/** Bound exactly the pretty JSON emitted by jsonResult, including status and link guidance. */
export function capBatchSearchHits<T>(params: {
  groups: T[][];
  metadata: Record<string, unknown>;
  truncatedQueries: Set<number>;
}) {
  const queryCount = params.groups.length;
  const results: Array<T & { queryIndex: number }> = [];
  const truncated = new Set(params.truncatedQueries);
  const envelope = {
    ...params.metadata,
    batch: true,
    queryCount,
    results,
  };
  // Reserve all truncation markers up front; appending a marker must not overflow the envelope.
  const fits = () =>
    Buffer.byteLength(
      JSON.stringify(
        { ...envelope, truncated: true, truncatedQueries: params.groups.map((_, index) => index) },
        null,
        2,
      ),
      "utf8",
    ) <= SESSIONS_SEARCH_MAX_BYTES;
  if (!fits()) {
    throw new Error(
      "Session search metadata exceeds the response budget; shorten session link configuration",
    );
  }
  const count = Math.max(0, ...params.groups.map((group) => group.length));
  for (let offset = 0; offset < count; offset++) {
    for (const [queryIndex, group] of params.groups.entries()) {
      const hit = group[offset];
      if (!hit) {
        continue;
      }
      results.push({ ...hit, queryIndex });
      if (!fits()) {
        results.pop();
        truncated.add(queryIndex);
      }
    }
  }
  return {
    ...envelope,
    ...(truncated.size
      ? { truncated: true, truncatedQueries: [...truncated].toSorted((a, b) => a - b) }
      : {}),
  };
}
