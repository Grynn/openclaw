/** Full-text search over visible session transcripts. */
import { Type } from "typebox";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { jsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { redactToolPayloadText } from "../../logging/redact.js";
import {
  agentSessionKeysMatchByRequestKey,
  isIncognitoSessionKey,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { isRecordWithoutThrowing } from "../../shared/safe-record.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { optionalPositiveIntegerSchema } from "../schema/typebox.js";
import {
  describeSessionLinkRule,
  describeSessionsSearchTool,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
import {
  resolveSessionToolTargetAgentId,
  runWithScopedSessionAccess,
} from "./scoped-session-access.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
  resolveDisplaySessionKey,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxedSessionToolContext,
  resolveSessionReference,
  resolveSessionToolAccess,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import {
  capBatchSearchHits,
  interleaveSearchChunks,
  readSearchQueries,
  SESSIONS_SEARCH_MAX_BATCH_QUERIES,
  SESSIONS_SEARCH_MAX_QUERY_CHARS,
  type BatchSearchQueryState,
} from "./sessions-search-batch.js";
import {
  listVisibleSearchSessions,
  type SearchSessionCandidate,
} from "./sessions-search-discovery.js";

const SESSIONS_SEARCH_DEFAULT_LIMIT = 10;
const SESSIONS_SEARCH_MAX_LIMIT = 25;
const SESSIONS_SEARCH_MAX_SESSION_KEYS = 200;
const SESSIONS_SEARCH_MAX_BATCH_LIST_CALLS = 16;
const SESSIONS_SEARCH_MAX_BATCH_SEARCH_CALLS = 48;
const SESSIONS_SEARCH_MAX_BYTES = 32 * 1024;
const SESSIONS_SEARCH_SNIPPET_MAX_CHARS = 300;
const SESSIONS_SEARCH_INDEXING_WARNING =
  "Transcript indexing is in progress; results may be incomplete. Retry sessions_search shortly.";

const SessionsSearchToolSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      maxLength: SESSIONS_SEARCH_MAX_QUERY_CHARS,
      description: "One recall query; use query or queries, not both.",
    }),
  ),
  queries: Type.Optional(
    Type.Array(Type.String({ maxLength: SESSIONS_SEARCH_MAX_QUERY_CHARS }), {
      minItems: 1,
      maxItems: SESSIONS_SEARCH_MAX_BATCH_QUERIES,
      description: "One to eight distinct related recall queries; whitespace is trimmed.",
    }),
  ),
  sessionKey: Type.Optional(Type.String()),
  limit: optionalPositiveIntegerSchema({
    maximum: SESSIONS_SEARCH_MAX_LIMIT,
    description: "Maximum results per query; complete batch output is capped at 32 KiB.",
  }),
});

const SessionsSearchHitSchema = Type.Object(
  {
    sessionKey: Type.String(),
    timestamp: Type.Number(),
    role: Type.Union([Type.Literal("assistant"), Type.Literal("user")]),
    snippet: Type.String(),
    score: Type.Number(),
    sessionId: Type.Optional(Type.String()),
    messageId: Type.Optional(Type.String()),
    queryIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const SessionsSearchOutputSchema = Type.Union([
  Type.Object(
    {
      results: Type.Array(SessionsSearchHitSchema),
      sessionLinkRule: Type.Optional(
        Type.String({
          description: "How to build Control UI URLs for sessionKey values in this result.",
        }),
      ),
      batch: Type.Optional(Type.Literal(true)),
      queryCount: Type.Optional(Type.Integer({ minimum: 1 })),
      indexingQueries: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
      truncatedQueries: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))),
      indexing: Type.Optional(Type.Literal(true)),
      warning: Type.Optional(Type.String()),
      truncated: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Union([Type.Literal("error"), Type.Literal("forbidden")]),
      error: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

type GatewayCaller = AgentToolGatewayRequestCaller;

type GatewaySearchHit = {
  sessionKey?: unknown;
  sessionId?: unknown;
  messageId?: unknown;
  role?: unknown;
  timestamp?: unknown;
  snippet?: unknown;
  score?: unknown;
};

type GatewaySearchQueryState = {
  results: GatewaySearchHit[];
  indexing?: boolean;
  truncated?: boolean;
};

function isGatewaySearchQueryState(value: unknown): value is GatewaySearchQueryState {
  if (!isRecordWithoutThrowing(value)) {
    return false;
  }
  return (
    Array.isArray(value.results) &&
    (value.indexing === undefined || typeof value.indexing === "boolean") &&
    (value.truncated === undefined || typeof value.truncated === "boolean")
  );
}

type SanitizedSearchHit = {
  sessionKey: string;
  timestamp: number;
  role: "assistant" | "user";
  snippet: string;
  score: number;
  sessionId?: string;
  messageId?: string;
};

type SearchQueryState = BatchSearchQueryState<SanitizedSearchHit>;

function sanitizeHit(params: {
  alias: string;
  hit: GatewaySearchHit;
  mainKey: string;
}): SanitizedSearchHit | undefined {
  const { hit } = params;
  if (
    typeof hit.sessionKey !== "string" ||
    (hit.role !== "user" && hit.role !== "assistant") ||
    typeof hit.timestamp !== "number" ||
    typeof hit.snippet !== "string" ||
    typeof hit.score !== "number"
  ) {
    return undefined;
  }
  const sanitized = redactToolPayloadText(hit.snippet);
  const snippet =
    sanitized.length > SESSIONS_SEARCH_SNIPPET_MAX_CHARS
      ? `${truncateUtf16Safe(sanitized, SESSIONS_SEARCH_SNIPPET_MAX_CHARS)}…`
      : sanitized;
  return {
    sessionKey: resolveDisplaySessionKey({
      key: hit.sessionKey,
      alias: params.alias,
      mainKey: params.mainKey,
    }),
    timestamp: hit.timestamp,
    role: hit.role,
    snippet,
    score: hit.score,
    ...(typeof hit.sessionId === "string" ? { sessionId: hit.sessionId } : {}),
    ...(typeof hit.messageId === "string" ? { messageId: hit.messageId } : {}),
  };
}

function capSearchHits(items: SanitizedSearchHit[]): {
  items: SanitizedSearchHit[];
  truncated: boolean;
} {
  const selected: SanitizedSearchHit[] = [];
  let bytes = 2;
  for (const item of items) {
    const itemBytes = jsonUtf8Bytes(item);
    const separatorBytes = selected.length > 0 ? 1 : 0;
    if (bytes + separatorBytes + itemBytes > SESSIONS_SEARCH_MAX_BYTES) {
      return { items: selected, truncated: true };
    }
    selected.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return { items: selected, truncated: false };
}

function compareSearchHits(left: SanitizedSearchHit, right: SanitizedSearchHit): number {
  return (
    right.score - left.score ||
    right.timestamp - left.timestamp ||
    left.sessionKey.localeCompare(right.sessionKey) ||
    (left.messageId ?? "").localeCompare(right.messageId ?? "")
  );
}

function resolveHitVisibilityKey(params: {
  candidateAgentId: string;
  candidateKey: string;
  hitKey: string;
}): string {
  const { candidateKey, hitKey } = params;
  if (hitKey === candidateKey) {
    return hitKey;
  }
  const hitAgentId = parseAgentSessionKey(hitKey)?.agentId;
  // Gateway canonicalizes unscoped aliases (notably `main`) to agent store keys. Preserve the
  // already-authorized request key so visibility and display use the caller's equivalent alias.
  return !parseAgentSessionKey(candidateKey) &&
    hitAgentId === params.candidateAgentId &&
    agentSessionKeysMatchByRequestKey(hitKey, candidateKey)
    ? candidateKey
    : hitKey;
}

function matchSearchHitCandidate(params: {
  agentId: string;
  candidates: SearchSessionCandidate[];
  hitKey: string;
}): { candidate: SearchSessionCandidate; visibilityKey: string } | undefined {
  for (const candidate of params.candidates) {
    const visibilityKey = resolveHitVisibilityKey({
      candidateAgentId: params.agentId,
      candidateKey: candidate.key,
      hitKey: params.hitKey,
    });
    if (visibilityKey === candidate.key) {
      return { candidate, visibilityKey };
    }
  }
  return undefined;
}

export function createSessionsSearchTool(opts?: {
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
  sessionLinkBase?: string;
}): AnyAgentTool {
  const gatewayCall = opts?.callGateway ?? callAgentToolGatewayRequest;
  return {
    label: "Sessions Search",
    name: "sessions_search",
    displaySummary: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSearchTool({ sessionLinkBase: opts?.sessionLinkBase }),
    parameters: SessionsSearchToolSchema,
    outputSchema: SessionsSearchOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      signal?.throwIfAborted();
      const signalGatewayCall: GatewayCaller = async <T>(request: Parameters<GatewayCaller>[0]) =>
        await gatewayCall<T>({
          ...request,
          ...(signal ? { signal } : {}),
        });
      const params = args as Record<string, unknown>;
      const searchInput = readSearchQueries(params);
      const limit =
        readPositiveIntegerParam(params, "limit", {
          max: SESSIONS_SEARCH_MAX_LIMIT,
        }) ?? SESSIONS_SEARCH_DEFAULT_LIMIT;
      const requestedSessionKey = readToolStringParam(params, "sessionKey");
      const cfg = opts?.config ?? getRuntimeConfig();
      const { mainKey, alias, effectiveRequesterKey, mainSessionKey, restrictToSpawned } =
        resolveSandboxedSessionToolContext({
          cfg,
          agentSessionKey: opts?.agentSessionKey,
          requesterAgentId: opts?.agentId,
          sandboxed: opts?.sandboxed,
        });
      const requesterAgentId = resolveSessionAgentId({
        sessionKey: effectiveRequesterKey,
        config: cfg,
        agentId: opts?.agentId,
      });

      let sessionTarget:
        | {
            agentId: string;
            key: string;
            requesterOwned: boolean;
            expectedSessionId?: string;
          }
        | undefined;
      if (requestedSessionKey) {
        const normalizedRequestedKey = requestedSessionKey.trim();
        const semanticTargetAgentId =
          normalizedRequestedKey === "current"
            ? requesterAgentId
            : normalizedRequestedKey === "main" ||
                normalizedRequestedKey === "global" ||
                normalizedRequestedKey === mainKey ||
                normalizedRequestedKey === alias ||
                Boolean(parseAgentSessionKey(normalizedRequestedKey))
              ? resolveSessionToolTargetAgentId({
                  cfg,
                  targetSessionKey: normalizedRequestedKey,
                  requesterAgentId,
                })
              : undefined;
        const resolved = await resolveSessionReference({
          action: "search",
          sessionKey: requestedSessionKey,
          keyAgentId: semanticTargetAgentId ?? requesterAgentId,
          alias,
          mainKey,
          requesterInternalKey: effectiveRequesterKey,
          restrictToSpawned,
          callGateway: signalGatewayCall,
        });
        if (!resolved.ok) {
          return jsonResult({ status: resolved.status, error: resolved.error });
        }
        const visible = await resolveVisibleSessionReference({
          action: "search",
          resolvedSession: resolved,
          requesterSessionKey: effectiveRequesterKey,
          requesterAgentId,
          restrictToSpawned,
          visibilitySessionKey: requestedSessionKey,
          callGateway: signalGatewayCall,
        });
        if (!visible.ok) {
          return jsonResult({ status: visible.status, error: visible.error });
        }
        sessionTarget = {
          key: visible.key,
          agentId: resolveSessionToolTargetAgentId({
            cfg,
            targetSessionKey: visible.key,
            resolvedAgentId: visible.agentId ?? semanticTargetAgentId,
            requesterAgentId,
          }),
          requesterOwned: visible.requesterOwned,
        };
      }

      const visibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });
      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const defaultAgentId = requesterAgentId;
      const rowGuard = createSessionVisibilityRowChecker({
        action: "history",
        defaultAgentId,
        requesterAgentId,
        requesterSessionKey: effectiveRequesterKey,
        mainSessionKey,
        visibility,
        a2aPolicy,
      });
      let revalidateSessionTargetAccess: (() => Promise<void>) | undefined;
      if (sessionTarget) {
        const { agentId, key, requesterOwned } = sessionTarget;
        const authorizationTargetSessionKey =
          agentId !== requesterAgentId && !parseAgentSessionKey(key)
            ? `agent:${agentId}:${key}`
            : key;
        const accessParams = {
          action: "history",
          displayAction: "search",
          requesterAgentId,
          requesterSessionKey: effectiveRequesterKey,
          mainSessionKey,
          authorizationTargetSessionKey,
          targetAgentId: agentId,
          targetSessionKey: key,
          requesterOwned,
          visibility,
          a2aPolicy,
          callGateway: signalGatewayCall,
        } as const;
        const access = await resolveSessionToolAccess(accessParams);
        if (!access.allowed) {
          return jsonResult({ status: access.status, error: access.error });
        }
        if (access.expectedSessionId) {
          sessionTarget.expectedSessionId = access.expectedSessionId;
          const expectedSessionId = access.expectedSessionId;
          revalidateSessionTargetAccess = async () => {
            const current = await resolveSessionToolAccess(accessParams);
            if (!current.allowed) {
              throw new Error(current.error);
            }
            if (current.expectedSessionId && current.expectedSessionId !== expectedSessionId) {
              throw new Error(`Session "${key}" access changed during search.`);
            }
          };
        }
      }
      let discoveryTruncated = false;
      let searchSessions: SearchSessionCandidate[];
      if (sessionTarget) {
        searchSessions = [
          {
            key: sessionTarget.key,
            access: "authorized",
            ...(sessionTarget.expectedSessionId
              ? { expectedSessionId: sessionTarget.expectedSessionId }
              : {}),
            ...(!parseAgentSessionKey(sessionTarget.key) ? { agentId: sessionTarget.agentId } : {}),
          },
        ];
      } else {
        const discovery = await listVisibleSearchSessions({
          unscopedAgentId: requesterAgentId,
          effectiveRequesterAgentId: opts?.agentId,
          effectiveRequesterKey,
          gatewayCall: signalGatewayCall,
          rowGuard,
          restrictToSpawned,
          preserveRoundRobin: searchInput.batch,
          ...(searchInput.batch ? { maxGatewayCalls: SESSIONS_SEARCH_MAX_BATCH_LIST_CALLS } : {}),
          ...(signal ? { signal } : {}),
        });
        searchSessions = discovery.candidates;
        discoveryTruncated = discovery.truncated;
      }
      // Search excerpts are re-persisted in the caller transcript; incognito
      // sessions therefore stay absent even when the caller could otherwise see them.
      searchSessions = searchSessions.filter((candidate) => !isIncognitoSessionKey(candidate.key));
      const queryStates = searchInput.queries.map(
        (): SearchQueryState => ({
          visibleHits: [],
          indexing: false,
          backendTruncated: discoveryTruncated,
        }),
      );
      const sessionsByAgent = new Map<string, SearchSessionCandidate[]>();
      for (const candidate of searchSessions) {
        const agentId = resolveSessionAgentId({
          sessionKey: candidate.key,
          config: cfg,
          agentId: parseAgentSessionKey(candidate.key) ? undefined : candidate.agentId,
        });
        const candidates = sessionsByAgent.get(agentId) ?? [];
        candidates.push(candidate);
        sessionsByAgent.set(agentId, candidates);
      }
      const agentGroups = [...sessionsByAgent].toSorted(([left], [right]) =>
        left.localeCompare(right),
      );
      const searchChunks = interleaveSearchChunks(agentGroups, SESSIONS_SEARCH_MAX_SESSION_KEYS);
      const maxSearchChunks = searchInput.batch
        ? Math.max(
            1,
            Math.floor(SESSIONS_SEARCH_MAX_BATCH_SEARCH_CALLS / searchInput.queries.length),
          )
        : Number.POSITIVE_INFINITY;
      // Visibility filtering precedes result/byte caps so hidden hit counts never affect output.
      for (let chunkIndex = 0; chunkIndex < searchChunks.length; chunkIndex += 1) {
        if (chunkIndex >= maxSearchChunks) {
          for (const state of queryStates) {
            state.backendTruncated = true;
          }
          break;
        }
        const searchChunk = searchChunks[chunkIndex];
        if (!searchChunk) {
          continue;
        }
        const { groupKey: agentId, items: chunk } = searchChunk;
        const scopedCandidate = chunk.length === 1 ? chunk[0] : undefined;
        const runChunkSearches = async () => {
          signal?.throwIfAborted();
          if (scopedCandidate?.expectedSessionId && revalidateSessionTargetAccess) {
            await revalidateSessionTargetAccess();
            signal?.throwIfAborted();
          }
          const scopeParams = {
            agentId,
            limit: SESSIONS_SEARCH_MAX_LIMIT,
            sessionKeys: chunk.map((candidate) => candidate.key),
          };
          const gatewayStates = searchInput.batch
            ? (
                await signalGatewayCall<{ states?: GatewaySearchQueryState[] }>({
                  method: "sessions.search",
                  params: { ...scopeParams, queries: searchInput.queries },
                })
              ).states
            : [
                await signalGatewayCall<GatewaySearchQueryState>({
                  method: "sessions.search",
                  params: { ...scopeParams, query: searchInput.queries[0] },
                }),
              ];
          signal?.throwIfAborted();
          if (scopedCandidate?.expectedSessionId && revalidateSessionTargetAccess) {
            await revalidateSessionTargetAccess();
            signal?.throwIfAborted();
          }
          if (
            !Array.isArray(gatewayStates) ||
            gatewayStates.length !== queryStates.length ||
            !gatewayStates.every(isGatewaySearchQueryState)
          ) {
            throw new Error("sessions.search returned an invalid response");
          }
          for (let queryIndex = 0; queryIndex < gatewayStates.length; queryIndex += 1) {
            const result = gatewayStates[queryIndex];
            const queryState = queryStates[queryIndex];
            if (!result || !queryState) {
              throw new Error("sessions.search returned an invalid response");
            }
            queryState.indexing ||= result.indexing === true;
            queryState.backendTruncated ||= result.truncated === true;
            for (const hit of result.results) {
              if (typeof hit.sessionKey !== "string") {
                continue;
              }
              const candidateMatch = matchSearchHitCandidate({
                agentId,
                candidates: chunk,
                hitKey: hit.sessionKey,
              });
              if (!candidateMatch) {
                continue;
              }
              const { candidate, visibilityKey } = candidateMatch;
              const access =
                candidate.access === "authorized"
                  ? { allowed: true as const }
                  : rowGuard.check(candidate);
              if (!access.allowed) {
                continue;
              }
              const sanitized = sanitizeHit({
                alias,
                hit: { ...hit, sessionKey: visibilityKey },
                mainKey,
              });
              if (sanitized) {
                queryState.visibleHits.push(sanitized);
              }
            }
          }
        };
        if (scopedCandidate?.expectedSessionId) {
          await runWithScopedSessionAccess({
            cfg,
            agentId,
            expectedSessionId: scopedCandidate.expectedSessionId,
            ...(signal ? { signal } : {}),
            targetSessionKey: scopedCandidate.key,
            run: runChunkSearches,
          });
        } else {
          await runChunkSearches();
        }
      }
      signal?.throwIfAborted();
      for (const state of queryStates) {
        state.visibleHits.sort(compareSearchHits);
      }
      const sessionLinkRule = opts?.sessionLinkBase
        ? describeSessionLinkRule(opts.sessionLinkBase)
        : undefined;
      if (searchInput.batch) {
        return jsonResult(
          capBatchSearchHits({
            states: queryStates,
            limit,
            maxBytes: SESSIONS_SEARCH_MAX_BYTES,
            indexingWarning: SESSIONS_SEARCH_INDEXING_WARNING,
            sessionLinkRule,
          }),
        );
      }
      const state = queryStates[0];
      if (!state) {
        throw new ToolInputError("query must not be empty");
      }
      const limited = state.visibleHits.slice(0, limit);
      const capped = capSearchHits(limited);
      return jsonResult({
        results: capped.items,
        ...(sessionLinkRule ? { sessionLinkRule } : {}),
        ...(state.indexing ? { indexing: true, warning: SESSIONS_SEARCH_INDEXING_WARNING } : {}),
        ...(state.backendTruncated || state.visibleHits.length > limit || capped.truncated
          ? { truncated: true }
          : {}),
      });
    },
  };
}
