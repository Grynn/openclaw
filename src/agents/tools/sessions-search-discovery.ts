import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";

type SearchVisibilityRow = {
  key: string;
  agentId?: string;
  ownerSessionKey?: string;
  parentSessionKey?: string;
  spawnedBy?: string;
};

export type SearchSessionCandidate = SearchVisibilityRow & {
  access: "authorized" | "row";
  expectedSessionId?: string;
};

type ListingPage = {
  sessions?: Array<{
    key?: unknown;
    agentId?: unknown;
    ownerSessionKey?: unknown;
    parentSessionKey?: unknown;
    spawnedBy?: unknown;
  }>;
  hasMore?: boolean;
  nextOffset?: number;
};

type ListingCursor = {
  archived: boolean;
  agentId?: string;
  offset: number;
  complete: boolean;
};

/** Fairly discovers visible active/archived and scoped/unscoped session rows. */
export async function listVisibleSearchSessions(params: {
  unscopedAgentId: string;
  effectiveRequesterAgentId?: string;
  effectiveRequesterKey: string;
  gatewayCall: AgentToolGatewayRequestCaller;
  rowGuard: { check: (row: SearchVisibilityRow) => { allowed: boolean } };
  restrictToSpawned: boolean;
  preserveRoundRobin: boolean;
  maxGatewayCalls?: number;
  signal?: AbortSignal;
}): Promise<{ candidates: SearchSessionCandidate[]; truncated: boolean }> {
  const candidates = new Map<string, SearchSessionCandidate>();
  const candidateId = (candidate: Pick<SearchSessionCandidate, "agentId" | "key">) =>
    parseAgentSessionKey(candidate.key)
      ? candidate.key
      : `${candidate.agentId ?? ""}\0${candidate.key}`;
  const requesterRow = {
    key: params.effectiveRequesterKey,
    ...(params.effectiveRequesterAgentId ? { agentId: params.effectiveRequesterAgentId } : {}),
  };
  if (params.rowGuard.check(requesterRow).allowed) {
    const requesterCandidate = {
      ...requesterRow,
      access: "row",
    } satisfies SearchSessionCandidate;
    candidates.set(candidateId(requesterCandidate), requesterCandidate);
  }

  const listingCursors: ListingCursor[] = [
    { archived: false, offset: 0, complete: false },
    { archived: true, offset: 0, complete: false },
    ...(!params.restrictToSpawned
      ? [
          { archived: false, agentId: params.unscopedAgentId, offset: 0, complete: false },
          { archived: true, agentId: params.unscopedAgentId, offset: 0, complete: false },
        ]
      : []),
  ];
  let gatewayCalls = 0;
  let complete = true;
  while (listingCursors.some((cursor) => !cursor.complete)) {
    for (const cursor of listingCursors) {
      if (cursor.complete) {
        continue;
      }
      params.signal?.throwIfAborted();
      if (gatewayCalls >= (params.maxGatewayCalls ?? Number.POSITIVE_INFINITY)) {
        complete = false;
        break;
      }
      gatewayCalls += 1;
      const page = await params.gatewayCall<ListingPage>({
        method: "sessions.list",
        params: {
          limit: 200,
          offset: cursor.offset,
          archived: cursor.archived,
          includeGlobal: !params.restrictToSpawned,
          includeUnknown: false,
          ...(cursor.agentId ? { agentId: cursor.agentId } : {}),
          ...(params.restrictToSpawned ? { spawnedBy: params.effectiveRequesterKey } : {}),
        },
      });
      params.signal?.throwIfAborted();
      for (const row of Array.isArray(page.sessions) ? page.sessions : []) {
        // Unscoped keys cannot encode a foreign owner for follow-up history. Only the requester's
        // agent-scoped listing may contribute them; the combined listing supplies scoped keys.
        if (
          typeof row.key !== "string" ||
          (!cursor.agentId && parseAgentSessionKey(row.key) === null)
        ) {
          continue;
        }
        const visibilityRow = {
          key: row.key,
          ...(typeof row.agentId === "string"
            ? { agentId: row.agentId }
            : cursor.agentId
              ? { agentId: cursor.agentId }
              : {}),
          ...(typeof row.ownerSessionKey === "string"
            ? { ownerSessionKey: row.ownerSessionKey }
            : {}),
          ...(typeof row.parentSessionKey === "string"
            ? { parentSessionKey: row.parentSessionKey }
            : {}),
          ...(typeof row.spawnedBy === "string"
            ? { spawnedBy: row.spawnedBy }
            : params.restrictToSpawned
              ? { spawnedBy: params.effectiveRequesterKey }
              : {}),
        };
        if (params.rowGuard.check(visibilityRow).allowed) {
          const id = candidateId(visibilityRow);
          candidates.set(id, {
            ...candidates.get(id),
            ...visibilityRow,
            access: "row",
          });
        }
      }
      if (
        page.hasMore === true &&
        typeof page.nextOffset === "number" &&
        page.nextOffset > cursor.offset
      ) {
        cursor.offset = page.nextOffset;
      } else {
        cursor.complete = true;
      }
    }
    if (!complete) {
      break;
    }
  }
  const candidateValues = [...candidates.values()];
  return {
    // Batches preserve the view round robin through later bounded chunks. Legacy single-query
    // requests retain their prior deterministic key ordering.
    candidates: params.preserveRoundRobin
      ? candidateValues
      : candidateValues.toSorted((left, right) => left.key.localeCompare(right.key)),
    truncated: !complete,
  };
}
