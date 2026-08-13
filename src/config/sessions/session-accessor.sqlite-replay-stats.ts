import { sql } from "kysely";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getActiveTranscriptKysely } from "./session-accessor.sqlite-active-projection.js";

/** Measures the latest semantic replay window without discarding durable history. */
export function readActiveTranscriptContextByteSize(
  database: OpenClawAgentDatabase,
  sessionId: string,
): number {
  const db = getActiveTranscriptKysely(database);
  const boundary = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select(["active.active_position", "identity.event_type", "event.event_json"])
      .where("active.session_id", "=", sessionId)
      .where("identity.event_type", "in", ["compaction", "reset"])
      .orderBy("identity.seq", "desc")
      .limit(1),
  );

  let query = db
    .selectFrom("session_transcript_active_events as active")
    .innerJoin("transcript_events as event", (join) =>
      join
        .onRef("event.session_id", "=", "active.session_id")
        .onRef("event.seq", "=", "active.event_seq"),
    )
    .select(
      /* kysely-allow-raw: Replay size excludes private Codex prompt provenance and includes one terminating newline per event. */
      sql<number>`COALESCE(SUM(LENGTH(CAST(json_remove(
        event.event_json,
        '$.message.__openclaw.upstreamUserText'
      ) AS BLOB))), 0)
        + COUNT(*)`.as("size_bytes"),
    )
    .where("active.session_id", "=", sessionId);

  if (boundary) {
    let firstKeptEntryId: string | undefined;
    try {
      const parsed = JSON.parse(boundary.event_json) as { firstKeptEntryId?: unknown };
      firstKeptEntryId =
        typeof parsed.firstKeptEntryId === "string" ? parsed.firstKeptEntryId : undefined;
    } catch {
      // A corrupt boundary cannot safely narrow the fuse; count the full path.
      return executeSqliteQueryTakeFirstSync(database.db, query)?.size_bytes ?? 0;
    }

    const firstKeptPosition = firstKeptEntryId
      ? executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("session_transcript_active_events as active", (join) =>
              join
                .onRef("active.session_id", "=", "identity.session_id")
                .onRef("active.event_seq", "=", "identity.seq"),
            )
            .select("active.active_position")
            .where("identity.session_id", "=", sessionId)
            .where("identity.event_id", "=", firstKeptEntryId)
            .limit(1),
        )?.active_position
      : undefined;
    const retainedStartPosition =
      typeof firstKeptPosition === "number" &&
      firstKeptPosition >= 0 &&
      firstKeptPosition < boundary.active_position
        ? firstKeptPosition
        : boundary.active_position;

    if (boundary.event_type === "reset") {
      // Reset has no summary message. Count its retained tail plus everything
      // after the boundary; retaining all tail event roles is conservative and
      // covers paired tool results used by safeguard recovery.
      query = query.where(
        /* kysely-allow-raw: Reset replay combines the retained and post-boundary position ranges. */
        sql<boolean>`(
          active.active_position >= ${boundary.active_position + 1}
          OR (
            active.active_position >= ${retainedStartPosition}
            AND active.active_position < ${boundary.active_position}
          )
        )`,
      );
    } else {
      // Compaction replay is its summary marker, retained tail, and later rows.
      query = query.where("active.active_position", ">=", retainedStartPosition);
    }
  }

  return executeSqliteQueryTakeFirstSync(database.db, query)?.size_bytes ?? 0;
}
