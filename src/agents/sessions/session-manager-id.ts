import { randomUUID } from "node:crypto";
import { uuidv7 } from "../runtime/index.js";

export type SessionEntryIdGenerator = (existing: { has(id: string): boolean }) => string;

export function createManagedSessionId(): string {
  return uuidv7();
}

/** Generates a short collision-checked id, with a full UUID fallback. */
export function generateSessionEntryId(existing: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!existing.has(id)) {
      return id;
    }
  }
  return randomUUID();
}

/** Generates a full UUID for managers built from a deliberately incomplete transcript view. */
export function generateFullSessionEntryId(existing: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID();
    if (!existing.has(id)) {
      return id;
    }
  }
  throw new Error("Unable to allocate a unique full session entry id");
}
