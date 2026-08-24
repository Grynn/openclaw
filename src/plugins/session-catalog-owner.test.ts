import { describe, expect, it } from "vitest";
import {
  resolveSessionCatalogOwnerTask,
  type SessionCatalogOwnerTask,
} from "./session-catalog-owner.js";

describe("session catalog owner tasks", () => {
  it("orphans an owner when its only requester aborts during owner creation", async () => {
    const requester = new AbortController();
    const reason = new Error("request disconnected");
    const activeTasks = new Map<string, SessionCatalogOwnerTask<string>>();
    let ownerSignal: AbortSignal | undefined;

    const result = resolveSessionCatalogOwnerTask({
      activeTasks,
      key: "catalog",
      load: (signal) => {
        ownerSignal = signal;
        return new Promise<string>(() => {
          requester.abort(reason);
        });
      },
      orphanedMessage: "catalog owner lost its requester",
      signal: requester.signal,
    });

    await expect(result).rejects.toBe(reason);
    expect(ownerSignal?.aborted).toBe(true);
    expect(ownerSignal?.reason).toBe(reason);
    expect(activeTasks.size).toBe(0);
  });
});
