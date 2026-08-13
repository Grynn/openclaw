/**
 * Stable, storage-neutral session-listing API for read-only command paths.
 *
 * Keep this facade intentionally narrow: importing the full session accessor also
 * initializes mutation, lifecycle, and transcript implementation graphs.
 */
export { listSessionEntriesReadOnly } from "./session-accessor.sqlite-entry-list.js";
