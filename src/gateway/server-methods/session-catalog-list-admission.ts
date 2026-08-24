type QueuedProviderList = {
  start: () => void;
};

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("session catalog list aborted", { cause: signal.reason });
}

class SessionCatalogListBusyError extends Error {
  readonly code = "catalog_busy";

  constructor(maxConcurrent: number, maxQueued: number) {
    super(`session catalog is busy (${maxConcurrent} active, ${maxQueued} queued); retry shortly`);
    this.name = "SessionCatalogListBusyError";
  }
}

export class SessionCatalogListAdmission {
  private active = 0;
  private readonly queue: QueuedProviderList[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number,
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    if (this.active < this.maxConcurrent) {
      return this.start(task);
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new SessionCatalogListBusyError(this.maxConcurrent, this.maxQueued));
    }
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const onAbort = () => {
        const index = this.queue.indexOf(queued);
        if (index < 0) {
          return;
        }
        this.queue.splice(index, 1);
        cleanup();
        if (signal) {
          reject(abortReason(signal));
        }
      };
      const queued: QueuedProviderList = {
        start: () => {
          cleanup();
          if (signal?.aborted) {
            reject(abortReason(signal));
            return;
          }
          void this.start(task).then(resolve, reject);
        },
      };
      this.queue.push(queued);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
    });
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    try {
      return await task();
    } finally {
      // Release before draining so every settlement, including rejection, hands
      // exactly one slot to the oldest waiter instead of leaking capacity.
      this.active -= 1;
      this.drain();
    }
  }

  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const next = this.queue.shift();
      if (!next) {
        return;
      }
      next.start();
    }
  }
}
