import {
  ErrorCodes,
  errorShape,
  type SessionsSearchHit,
  type SessionsSearchQueryState,
  validateSessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  resolveExistingAgentSessionStoreTargetsSync,
  resolveSessionStorePathCore,
} from "../../config/sessions.js";
import {
  listSessionEntriesReadOnly,
  withSessionEntryReadOnlyScope,
} from "../../config/sessions/session-accessor.js";
import {
  searchSessionTranscripts,
  searchSessionTranscriptsBatch,
} from "../../config/sessions/session-transcript-search.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import {
  canAccessIncognitoSession,
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { resolveSessionStoreAgentId } from "../session-store-key.js";
import type { GatewaySessionStoreDiscoveryCache } from "../session-utils-store-lookup.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { resolveSessionSearchScope } from "./sessions-search-scope.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type SessionSearchTargetResult = {
  hits: SessionsSearchHit[];
  indexing: boolean;
  truncated: boolean;
  archivedTranscriptsExcluded?: number;
};

function mergeSessionSearchTargetResults(
  targetResults: SessionSearchTargetResult[],
  limit: number,
): SessionsSearchQueryState {
  const sortedHits = targetResults
    .flatMap((result) => result.hits)
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        right.timestamp - left.timestamp ||
        left.messageId.localeCompare(right.messageId),
    );
  const seenHits = new Set<string>();
  const hits = sortedHits.filter((hit) => {
    const identity = `${hit.sessionKey}\0${hit.sessionId}\0${hit.messageId}`;
    if (seenHits.has(identity)) {
      return false;
    }
    seenHits.add(identity);
    return true;
  });
  const archivedTranscriptsExcluded = targetResults.reduce(
    (total, result) => total + (result.archivedTranscriptsExcluded ?? 0),
    0,
  );
  return {
    results: hits.slice(0, limit),
    ...(archivedTranscriptsExcluded ? { archivedTranscriptsExcluded } : {}),
    ...(targetResults.some((result) => result.indexing) ? { indexing: true } : {}),
    ...(targetResults.some((result) => result.truncated) || hits.length > limit
      ? { truncated: true }
      : {}),
  };
}

export const handleSessionsSearch: GatewayRequestHandlers["sessions.search"] = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!assertValidParams(params, validateSessionsSearchParams, "sessions.search", respond)) {
    return;
  }
  const isBatch = params.queries !== undefined;
  const queries = params.queries?.map((query) => query.trim()) ?? [params.query?.trim() ?? ""];
  const emptyQueryIndex = queries.findIndex((query) => !query);
  if (emptyQueryIndex >= 0) {
    const message = isBatch
      ? `queries[${emptyQueryIndex}] must not be empty`
      : "query must not be empty";
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    return;
  }
  const firstQuery = queries[0];
  if (!firstQuery) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "query must not be empty"));
    return;
  }
  const cfg = context.getRuntimeConfig();
  const scope = resolveSessionSearchScope(cfg, params);
  if (!scope.ok) {
    respond(false, undefined, scope.error);
    return;
  }
  const { agentId, configured, requestedAgentId, sessionKeys } = scope;
  const restrictIncognito = Boolean(gatewayClientSessionCreator(client)) && !isGatewayAdmin(client);
  const roleVisibilityFilter = hasOperatorBoundary(client, cfg)
    ? createSessionListEntryFilter({ client, cfg })
    : undefined;
  const restrictVisibility = restrictIncognito || Boolean(roleVisibilityFilter);
  // One discovery cache per request: every query in a batch resolves the same
  // session store targets, so the lookup must not repeat per query.
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const canSearchSessionKey = (sessionKey: string) => {
    if (
      isIncognitoSessionKey(sessionKey) &&
      !canAccessIncognitoSession({ cfg, client: client ?? null, sessionKey, agentId })
    ) {
      return false;
    }
    if (!roleVisibilityFilter) {
      return true;
    }
    const target = resolveSessionSharingTarget({ cfg, sessionKey, agentId, targetDiscoveryCache });
    return Boolean(target && roleVisibilityFilter(target.storeKey, target.entry));
  };
  if (requestedAgentId && !params.sessionKeys && configured) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "agentId requires sessionKeys"),
    );
    return;
  }
  const scopedSessionKeysRaw = configured
    ? sessionKeys
    : sessionKeys?.filter((sessionKey) => {
        const sessionAgentId =
          requestedAgentId && (sessionKey === "global" || sessionKey === "unknown")
            ? requestedAgentId
            : resolveSessionStoreAgentId(cfg, sessionKey);
        return sessionAgentId === agentId;
      });
  const scopedSessionKeys = scopedSessionKeysRaw?.filter(canSearchSessionKey);
  if (!configured && scopedSessionKeys?.length === 0) {
    respond(
      true,
      isBatch ? { states: queries.map(() => ({ results: [] })) } : { results: [] },
      undefined,
    );
    return;
  }
  const searchTargets = configured
    ? [{ agentId, storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }) }]
    : resolveExistingAgentSessionStoreTargetsSync(cfg, agentId);
  if (!configured && searchTargets.length === 0) {
    respond(
      true,
      isBatch ? { states: queries.map(() => ({ results: [] })) } : { results: [] },
      undefined,
    );
    return;
  }
  try {
    const targetResultsByQuery: SessionSearchTargetResult[][] = queries.map(() => []);
    for (const target of searchTargets) {
      const targetSessionKeys =
        scopedSessionKeys ??
        (restrictVisibility
          ? withSessionEntryReadOnlyScope(target, () =>
              listSessionEntriesReadOnly({
                agentId: target.agentId,
                storePath: target.storePath,
                projection: "list",
                clone: false,
              })
                .map((entry) => entry.sessionKey)
                .filter((sessionKey) => {
                  // A shared physical store can include rows owned by another agent.
                  const parsed = parseAgentSessionKey(sessionKey);
                  if (parsed && normalizeAgentId(parsed.agentId) !== agentId) {
                    return false;
                  }
                  return canSearchSessionKey(sessionKey);
                }),
            )
          : undefined);
      if (targetSessionKeys?.length === 0) {
        continue;
      }
      const searchScope = {
        ...target,
        // Over-fetch retired multi-store searches so deduplication can still fill the caller's
        // requested page when the same transcript was copied during a store migration.
        limit: configured ? params.limit : 25,
        ...(targetSessionKeys ? { sessionKeys: targetSessionKeys } : {}),
      };
      if (isBatch) {
        const queryResults = searchSessionTranscriptsBatch({ ...searchScope, queries });
        for (let queryIndex = 0; queryIndex < queryResults.length; queryIndex += 1) {
          const queryResult = queryResults[queryIndex];
          if (queryResult) {
            targetResultsByQuery[queryIndex]?.push(queryResult);
          }
        }
      } else {
        targetResultsByQuery[0]?.push(
          searchSessionTranscripts({ ...searchScope, query: firstQuery }),
        );
      }
    }
    const limit = params.limit ?? 10;
    const states = targetResultsByQuery.map((targetResults) =>
      mergeSessionSearchTargetResults(targetResults, limit),
    );
    if (isBatch) {
      respond(true, { states }, undefined);
      return;
    }
    const state = states[0];
    if (!state) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "search returned no state"));
      return;
    }
    // Preserve the legacy responder call shape as well as its payload.
    respond(true, state);
  } catch (error) {
    respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatErrorMessage(error)));
  }
};
