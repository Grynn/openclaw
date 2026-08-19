import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

const SessionsSearchScopeFields = {
  agentId: Type.Optional(NonEmptyString),
  sessionKeys: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, maxItems: 200 })),
} as const;

/** Searches one agent's indexed session transcripts, optionally within selected sessions. */
export const SessionsSearchParamsSchema = Type.Object(
  {
    ...SessionsSearchScopeFields,
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    queries: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), {
        minItems: 1,
        maxItems: 8,
      }),
    ),
  },
  {
    additionalProperties: false,
    // Keep one object schema so generated clients retain the legacy params model while the wire
    // contract still requires exactly one request mode.
    oneOf: [
      { required: ["query"], not: { required: ["queries"] } },
      { required: ["queries"], not: { required: ["query"] } },
    ],
  },
);

/** One full-text session transcript match with follow-up provenance. */
export const SessionsSearchHitSchema = closedObject({
  sessionKey: NonEmptyString,
  sessionId: NonEmptyString,
  messageId: NonEmptyString,
  role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
  timestamp: Type.Integer({ minimum: 0 }),
  snippet: Type.String(),
  score: Type.Number(),
});

/** Full-text search response; indexing marks a still-running first-use reconcile. */
export const SessionsSearchResultSchema = closedObject({
  results: Type.Array(SessionsSearchHitSchema),
  indexing: Type.Optional(Type.Boolean()),
  truncated: Type.Optional(Type.Boolean()),
});

/** Ordered per-query results for one native transcript-search batch. */
export const SessionsSearchQueryStateSchema = closedObject({
  results: Type.Array(SessionsSearchHitSchema),
  indexing: Type.Optional(Type.Boolean()),
  truncated: Type.Optional(Type.Boolean()),
});

/** Batch transcript-search response; states align one-for-one with requested queries. */
export const SessionsSearchBatchResultSchema = closedObject({
  states: Type.Array(SessionsSearchQueryStateSchema, { minItems: 1, maxItems: 8 }),
});

export type SessionsSearchParams = Static<typeof SessionsSearchParamsSchema>;
export type SessionsSearchHit = Static<typeof SessionsSearchHitSchema>;
export type SessionsSearchResult = Static<typeof SessionsSearchResultSchema>;
export type SessionsSearchQueryState = Static<typeof SessionsSearchQueryStateSchema>;
export type SessionsSearchBatchResult = Static<typeof SessionsSearchBatchResultSchema>;
