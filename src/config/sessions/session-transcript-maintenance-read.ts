import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { jsonPathValue } from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { NESTED_TOOL_ACTIVITY_CUSTOM_TYPE } from "../../sessions/nested-tool-activity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-read.js";
import {
  getSessionKysely,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import {
  loadTranscriptSuffixEventsBoundedFromDatabase,
  readPreviousIndexedTranscriptEventSync,
} from "./session-accessor.sqlite-suffix-read.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { readWithCanonicalSessionAdmission } from "./session-canonical-key.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import type {
  SessionTranscriptMaintenanceRead,
  SessionTranscriptMaintenanceFacts,
} from "./session-transcript-hydration.types.js";
import { SessionTranscriptProjectionUnavailableError } from "./session-transcript-projection-error.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  readTranscriptReportEvent,
  readTranscriptReportNavigation,
} from "./session-transcript-report-read.js";
import {
  transcriptEventJsonSql,
  transcriptEventNavigationSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";

export function readSessionTranscriptMaintenance(
  database: OpenClawAgentReadOnlyDatabase,
  target: SessionTranscriptRuntimeTarget,
  request: SessionTranscriptMaintenanceRead,
  resolvedScope: ResolvedTranscriptReadScope,
): SessionTranscriptMaintenanceFacts {
  if (request.operation === "custom-branch") {
    return readWithCanonicalSessionAdmission(database, () =>
      runSqliteReadSnapshotSync(database.db, () => {
        const fence = resolveSqliteSessionTranscriptReadFence({ database, ...target });
        assertSessionTranscriptHot(database.db, target.sessionId);
        const navigation = readTranscriptReportNavigation(
          database,
          target.sessionId,
          fence?.beforeRawSeq,
        );
        return {
          kind: "transcript-maintenance" as const,
          events: navigation.readCustomBranch(request.leafEntryId, request.customType, (seq) =>
            readTranscriptReportEvent(database, target.sessionId, seq),
          ),
        };
      }),
    );
  }
  if (request.operation === "latest-active-control") {
    const result = readCurrentProjectionSnapshot(database, resolvedScope, (projection) => {
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolvedScope });
      const eventType = transcriptPredicateSql(database.db, "navigation_last_type", "event");
      const navigation = transcriptEventNavigationSql(database.db, "event");
      const customType = isPostgresSqlConnection(database.db)
        ? jsonPathValue(database.db, navigation, sql.lit("$.customType"))
        : /* kysely-allow-raw: SQLite's final duplicate root member matches JSON.parse and memory history. */
          sql<
            string | null
          >`(SELECT value FROM json_each(${navigation}) WHERE key = 'customType' ORDER BY id DESC LIMIT 1)`;
      const query = getSessionKysely(database.db)
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .select(eventType.as("type"))
        .where("active.session_id", "=", projection.resolved.sessionId)
        .where((eb) =>
          eb.or([
            eb(eventType, "in", ["reset", "compaction"]),
            // Read the small navigation projection, never decompress message bodies.
            eb(
              eb.case().when(eventType, "=", "custom").then(customType).else(null).end(),
              "=",
              request.customType,
            ),
          ]),
        )
        .orderBy("active.active_position", "desc")
        .limit(1);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        fence ? query.where("event.seq", "<", fence.beforeRawSeq) : query,
      );
      return row?.type === "custom" || row?.type === "reset" || row?.type === "compaction"
        ? row.type
        : undefined;
    });
    if (result.kind !== "value") {
      throw new SessionTranscriptProjectionUnavailableError(target.sessionId);
    }
    return { kind: "transcript-maintenance", latestControl: result.value };
  }
  if (request.operation === "previous") {
    return {
      kind: "transcript-maintenance",
      previous: readPreviousIndexedTranscriptEventSync(target, request.beforeSeq, {
        readOnly: true,
      })?.event,
    };
  }
  if (request.operation === "suffix") {
    return {
      kind: "transcript-maintenance",
      events: loadTranscriptSuffixEventsBoundedFromDatabase(
        database,
        target,
        request.startSeq,
        request,
      ),
    };
  }
  if (request.operation === "nested-activity") {
    return readWithCanonicalSessionAdmission(database, () =>
      runSqliteReadSnapshotSync(database.db, () => {
        const first = readTranscriptIdentityByEventId(
          database,
          target.sessionId,
          request.firstEntryId,
        );
        const last = readTranscriptIdentityByEventId(
          database,
          target.sessionId,
          request.lastEntryId,
        );
        if (!first || !last || first.seq > last.seq) {
          throw new Error("Accepted nested tool activity is no longer available");
        }
        // These exact accepted entries attest this attempt's own tool evidence,
        // including rows after its user admission and before a compaction boundary.
        const rows = iterateSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("transcript_events")
            .select(transcriptEventJsonSql(database.db).as("event_json"))
            .where("session_id", "=", target.sessionId)
            .where("seq", ">=", first.seq)
            .where("seq", "<=", last.seq)
            .orderBy("seq", "asc"),
        );
        const events: TranscriptEvent[] = [];
        for (const row of rows) {
          const event: TranscriptEvent = JSON.parse(row.event_json);
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          if (
            message?.customType === NESTED_TOOL_ACTIVITY_CUSTOM_TYPE &&
            asOptionalRecord(message.details)?.scopeId === request.scopeId
          ) {
            events.push(event);
          }
        }
        return { kind: "transcript-maintenance" as const, events };
      }),
    );
  }
  return readWithCanonicalSessionAdmission(database, () =>
    runSqliteReadSnapshotSync(
      database.db,
      (): SessionTranscriptMaintenanceFacts =>
        request.operation === "identity"
          ? {
              kind: "transcript-maintenance",
              seq: readTranscriptIdentityByEventId(database, target.sessionId, request.eventId)
                ?.seq,
            }
          : {
              kind: "transcript-maintenance",
              version: readTranscriptContextVersionInTransaction(database, target.sessionId),
              lifecycleRevision: readSessionEntryRow(database, target.sessionKey)?.entry
                .lifecycleRevision,
              appendParentId: resolveTranscriptMessageAppendParent(database, target.sessionId, {}),
            },
      { databaseLabel: database.path, operationLabel: "session transcript maintenance read" },
    ),
  );
}
