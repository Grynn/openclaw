import { describe, expect, it, vi } from "vitest";
import { SessionCatalogListAdmission } from "./session-catalog-list-admission.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("SessionCatalogListAdmission", () => {
  it("starts at most the configured number of provider lists", async () => {
    const admission = new SessionCatalogListAdmission(2, 2);
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    const tasks = gates.map((gate) => vi.fn(() => gate.promise));
    const pending = tasks.map((task) => admission.run(task));

    expect(tasks.map((task) => task.mock.calls.length)).toEqual([1, 1, 0, 0]);
    gates[0]?.resolve(0);
    await expect(pending[0]).resolves.toBe(0);
    expect(tasks.map((task) => task.mock.calls.length)).toEqual([1, 1, 1, 0]);

    gates[1]?.resolve(1);
    gates[2]?.resolve(2);
    gates[3]?.resolve(3);
    await expect(Promise.all(pending)).resolves.toEqual([0, 1, 2, 3]);
  });

  it("releases a slot after rejection and preserves FIFO order", async () => {
    const admission = new SessionCatalogListAdmission(1, 2);
    const active = deferred<void>();
    const order: string[] = [];
    const first = admission.run(() => active.promise);
    const second = admission.run(async () => {
      order.push("second");
      return 2;
    });
    const third = admission.run(async () => {
      order.push("third");
      return 3;
    });

    active.reject(new Error("provider failed"));
    await expect(first).rejects.toThrow("provider failed");
    await expect(Promise.all([second, third])).resolves.toEqual([2, 3]);
    expect(order).toEqual(["second", "third"]);
  });

  it("rejects overflow without starting the provider", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const active = deferred<void>();
    const first = admission.run(() => active.promise);
    const queued = admission.run(async () => undefined);
    const overflowTask = vi.fn(async () => undefined);

    await expect(admission.run(overflowTask)).rejects.toMatchObject({ code: "catalog_busy" });
    expect(overflowTask).not.toHaveBeenCalled();

    active.resolve();
    await Promise.all([first, queued]);
  });

  it("removes an aborted queued list without consuming the next slot", async () => {
    const admission = new SessionCatalogListAdmission(1, 3);
    const active = deferred<void>();
    const first = admission.run(() => active.promise);
    const controller = new AbortController();
    const abandonedTask = vi.fn(async () => "abandoned");
    const abandoned = admission.run(abandonedTask, controller.signal);
    const keptTask = vi.fn(async () => "kept");
    const kept = admission.run(keptTask);

    controller.abort(new Error("requester disconnected"));
    await expect(abandoned).rejects.toThrow("requester disconnected");
    expect(abandonedTask).not.toHaveBeenCalled();

    active.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(kept).resolves.toBe("kept");
    expect(keptTask).toHaveBeenCalledOnce();
  });

  it("rejects a list whose signal was already aborted", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const controller = new AbortController();
    const task = vi.fn(async () => undefined);
    controller.abort(new Error("already gone"));

    await expect(admission.run(task, controller.signal)).rejects.toThrow("already gone");
    expect(task).not.toHaveBeenCalled();
  });

  it("does not release an active slot until an abort-ignoring provider settles", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const active = deferred<void>();
    const controller = new AbortController();
    const first = admission.run(() => active.promise, controller.signal);
    const keptTask = vi.fn(async () => "kept");
    const kept = admission.run(keptTask);

    controller.abort(new Error("requester disconnected"));
    await Promise.resolve();
    expect(keptTask).not.toHaveBeenCalled();

    active.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(kept).resolves.toBe("kept");
    expect(keptTask).toHaveBeenCalledOnce();
  });
});
