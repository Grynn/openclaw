export type SessionCatalogOwnerTask<T> = {
  abortController: AbortController;
  consumers: Set<symbol>;
  result: Promise<T>;
  settled: boolean;
};

async function waitForSessionCatalogOwnerTask<T>(
  task: SessionCatalogOwnerTask<T>,
  options: {
    signal?: AbortSignal;
    onOrphaned: () => void;
    orphanedMessage: string;
  },
): Promise<T> {
  const consumer = Symbol("session-catalog-owner-consumer");
  task.consumers.add(consumer);
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    task.consumers.delete(consumer);
    if (!task.settled && task.consumers.size === 0) {
      options.onOrphaned();
      if (!task.abortController.signal.aborted) {
        task.abortController.abort(options.signal?.reason ?? new Error(options.orphanedMessage));
      }
    }
  };
  const signal = options.signal;
  if (!signal) {
    try {
      return await task.result;
    } finally {
      release();
    }
  }
  let rejectAborted: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = () => {
    release();
    rejectAborted?.(signal.reason ?? new Error(options.orphanedMessage));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  try {
    return await Promise.race([task.result, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    release();
  }
}

export async function resolveSessionCatalogOwnerTask<T>(options: {
  activeTasks: Map<string, SessionCatalogOwnerTask<T>>;
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
  onResolved?: (value: T, task: SessionCatalogOwnerTask<T>) => void;
  orphanedMessage: string;
  signal?: AbortSignal;
}): Promise<T> {
  options.signal?.throwIfAborted();
  let task = options.activeTasks.get(options.key);
  if (!task) {
    const abortController = new AbortController();
    task = {
      abortController,
      consumers: new Set(),
      result: options.load(abortController.signal),
      settled: false,
    };
    options.activeTasks.set(options.key, task);
    const owned = task;
    void owned.result
      .then(
        (value) => {
          owned.settled = true;
          if (options.activeTasks.get(options.key) === owned) {
            options.activeTasks.delete(options.key);
          }
          options.onResolved?.(value, owned);
        },
        () => {
          owned.settled = true;
          if (options.activeTasks.get(options.key) === owned) {
            options.activeTasks.delete(options.key);
          }
        },
      )
      .catch(() => undefined);
  }
  return await waitForSessionCatalogOwnerTask(task, {
    ...(options.signal ? { signal: options.signal } : {}),
    onOrphaned: () => {
      if (options.activeTasks.get(options.key) === task) {
        options.activeTasks.delete(options.key);
      }
    },
    orphanedMessage: options.orphanedMessage,
  });
}
