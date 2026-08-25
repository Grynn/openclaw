import { SessionManagerBranching } from "../sessions/session-manager-branching.js";
import { generateFullSessionEntryId } from "../sessions/session-manager-id.js";
import type { FileEntry, SessionHeader } from "../sessions/session-manager-types.js";

export class BoundedTranscriptRewritePlanner extends SessionManagerBranching {
  override flushPendingPersistence(): void {
    super.flushPendingPersistence();
  }
}

/** Creates a non-persisted planner whose IDs cannot collide by compact-prefix reuse. */
export function createBoundedTranscriptRewritePlanner(
  entries: readonly unknown[],
): BoundedTranscriptRewritePlanner {
  // SAFETY: SessionManagerCore partitions and validates cloned persisted entries before indexing.
  const fileEntries = structuredClone(entries) as FileEntry[];
  const header = fileEntries.find((entry): entry is SessionHeader => entry.type === "session");
  return new BoundedTranscriptRewritePlanner(
    header?.cwd ?? process.cwd(),
    undefined,
    fileEntries,
    generateFullSessionEntryId,
  );
}
