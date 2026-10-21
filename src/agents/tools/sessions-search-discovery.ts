import { parseAgentSessionKey } from "../../routing/session-key.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import type { createSessionVisibilityRowChecker } from "./sessions-helpers.js";

export type SearchSessionCandidate = {
  key: string;
  agentId?: string;
  expectedSessionId?: string;
};

/** Batch discovery rotates sources so an unbounded active roster cannot hide archived sessions. */
export async function listVisibleSearchSessions(params: {
  unscopedAgentId: string;
  effectiveRequesterAgentId?: string;
  effectiveRequesterKey: string;
  gatewayCall: AgentToolGatewayRequestCaller;
  rowGuard: Pick<ReturnType<typeof createSessionVisibilityRowChecker>, "check">;
  restrictToSpawned: boolean;
  batch: boolean;
}): Promise<{ candidates: SearchSessionCandidate[]; truncated: boolean }> {
  const candidates = new Map<string, SearchSessionCandidate>();
  const candidateId = (candidate: Pick<SearchSessionCandidate, "agentId" | "key">) =>
    parseAgentSessionKey(candidate.key)
      ? candidate.key
      : `${candidate.agentId ?? ""}\0${candidate.key}`;
  const requester = {
    key: params.effectiveRequesterKey,
    ...(params.effectiveRequesterAgentId ? { agentId: params.effectiveRequesterAgentId } : {}),
  };
  if (params.rowGuard.check(requester).allowed) {
    candidates.set(candidateId(requester), requester);
  }
  // Only requester-agent pages may contribute unscoped keys: they cannot encode a foreign owner
  // for a follow-up sessions_history call. Combined pages supply scoped keys.
  const agents = params.restrictToSpawned ? [undefined] : [undefined, params.unscopedAgentId];
  const pending = agents.flatMap((agentId) =>
    [false, true].map((archived) => ({ agentId, archived, offset: 0 })),
  );
  let calls = 0;
  while (pending.length && (!params.batch || calls < 16)) {
    const cursor = pending.shift()!;
    const { agentId, archived, offset } = cursor;
    const page = await params.gatewayCall<{
      sessions?: Array<{
        key?: unknown;
        agentId?: unknown;
        ownerSessionKey?: unknown;
        parentSessionKey?: unknown;
        spawnedBy?: unknown;
      }>;
      hasMore?: boolean;
      nextOffset?: number;
    }>({
      method: "sessions.list",
      params: {
        limit: 200,
        offset,
        archived,
        includeGlobal: !params.restrictToSpawned,
        includeUnknown: false,
        ...(agentId ? { agentId } : {}),
        ...(params.restrictToSpawned ? { spawnedBy: params.effectiveRequesterKey } : {}),
      },
    });
    calls++;
    for (const row of Array.isArray(page.sessions) ? page.sessions : []) {
      if (typeof row.key !== "string" || (!agentId && parseAgentSessionKey(row.key) === null)) {
        continue;
      }
      const visibilityRow = {
        key: row.key,
        ...(typeof row.agentId === "string"
          ? { agentId: row.agentId }
          : agentId
            ? { agentId }
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
        candidates.set(candidateId(visibilityRow), {
          key: visibilityRow.key,
          agentId: visibilityRow.agentId,
        });
      }
    }
    if (page.hasMore === true && typeof page.nextOffset === "number" && page.nextOffset > offset) {
      cursor.offset = page.nextOffset;
      if (params.batch) {
        pending.push(cursor);
      } else {
        pending.unshift(cursor);
      }
    }
  }
  const values = [...candidates.values()];
  return {
    candidates: params.batch
      ? values
      : values.toSorted((left, right) => left.key.localeCompare(right.key)),
    truncated: pending.length > 0,
  };
}
