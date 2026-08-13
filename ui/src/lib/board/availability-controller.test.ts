// @vitest-environment node
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import { BoardAvailabilityController } from "./availability-controller.ts";
import {
  acquireBoardProviderForSession,
  boardProviderForSession,
  clearSessionBoardAvailability,
  sessionHasBoard,
} from "./provider.ts";

describe("BoardAvailabilityController", () => {
  it("invalidates its host when a visible session board snapshot changes", async () => {
    vi.stubGlobal("location", { search: "?mockBoard=1" });
    const provider = boardProviderForSession("agent:main:main");
    const requestUpdate = vi.fn();
    let controller: BoardAvailabilityController | undefined;
    const host: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        controller = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate,
      updateComplete: Promise.resolve(true),
    };
    controller = new BoardAvailabilityController(
      host,
      () => ["main", "agent:main:main"],
      () => provider,
    );
    controller?.hostConnected();

    await provider.applyOps([{ kind: "tab_update", tabId: "main", chatDock: "left" }]);

    expect(requestUpdate).toHaveBeenCalledOnce();
    controller?.hostDisconnected();
  });

  it("lets an active board provider own the sidebar presence read", async () => {
    vi.stubGlobal("location", { search: "" });
    const sessionKey = "agent:main:active-board";
    const snapshot = { sessionKey, revision: 1, tabs: [], widgets: [] };
    const client = {
      request: vi.fn(async () => snapshot),
      addEventListener: vi.fn(() => () => undefined),
    };
    const lease = acquireBoardProviderForSession(sessionKey, client as never);
    let controller: BoardAvailabilityController | undefined;
    const host: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        controller = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    };
    controller = new BoardAvailabilityController(
      host,
      () => [sessionKey],
      boardProviderForSession,
      () => ({ client: client as never, connected: true, available: true, key: "gateway-a" }),
    );

    try {
      controller.hostConnected();
      await vi.waitFor(() => expect(lease.provider.snapshot$.value).toEqual(snapshot));
      expect(client.request).toHaveBeenCalledOnce();
    } finally {
      controller.hostDisconnected();
      lease.release();
      clearSessionBoardAvailability();
    }
  });

  it("loads and refreshes board presence for sessions without full providers", async () => {
    vi.stubGlobal("location", { search: "" });
    const sessionKey = "agent:main:sidebar-only";
    let hasBoard = true;
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async () => ({
        sessionKey,
        revision: hasBoard ? 1 : 2,
        tabs: hasBoard
          ? [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }]
          : [],
        widgets: [],
      })),
      addEventListener: vi.fn((next) => {
        listener = next as typeof listener;
        return () => {
          listener = undefined;
        };
      }),
    };
    const requestUpdate = vi.fn();
    let controller: BoardAvailabilityController | undefined;
    const host: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        controller = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate,
      updateComplete: Promise.resolve(true),
    };
    controller = new BoardAvailabilityController(
      host,
      () => [sessionKey],
      boardProviderForSession,
      () => ({ client: client as never, connected: true, available: true, key: "gateway-a" }),
    );
    controller.hostConnected();

    await vi.waitFor(() => expect(sessionHasBoard(sessionKey)).toBe(true));
    expect(client.request).toHaveBeenCalledWith("board.get", { sessionKey });

    listener?.({ event: "board.changed", payload: { sessionKey, revision: 1 } });
    await Promise.resolve();
    expect(client.request).toHaveBeenCalledOnce();

    hasBoard = false;
    listener?.({ event: "board.changed", payload: { sessionKey, revision: 2 } });
    await vi.waitFor(() => expect(sessionHasBoard(sessionKey)).toBe(false));
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(requestUpdate).toHaveBeenCalledTimes(2);

    controller.hostDisconnected();
    expect(listener).toBeUndefined();
  });

  it("reduces nine startup reads to one and retries only failed metadata", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { search: "" });
    const sessionKeys = Array.from({ length: 9 }, (_, index) => `agent:main:batch-${index}`);
    const legacyClient = {
      request: vi.fn(async (_method: string, params: { sessionKey: string }) => ({
        sessionKey: params.sessionKey,
        revision: 1,
        tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
        widgets: [],
      })),
      addEventListener: vi.fn(() => () => {}),
    };
    let legacyController: BoardAvailabilityController | undefined;
    const legacyHost: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        legacyController = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    };
    legacyController = new BoardAvailabilityController(
      legacyHost,
      () => sessionKeys,
      boardProviderForSession,
      () => ({
        client: legacyClient as never,
        connected: true,
        available: true,
        key: "legacy-gateway",
      }),
    );
    legacyController.hostConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(legacyClient.request).toHaveBeenCalledTimes(9);
    expect(legacyClient.request.mock.calls.every(([method]) => method === "board.get")).toBe(true);
    legacyController.hostDisconnected();
    clearSessionBoardAvailability();

    let requestCount = 0;
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    const client = {
      request: vi.fn(async (method: string, params: { sessionKeys: string[] }) => {
        expect(method).toBe("board.metadata");
        requestCount += 1;
        return {
          outcomes: params.sessionKeys.map((sessionKey) =>
            requestCount === 1 && sessionKey === sessionKeys[4]
              ? {
                  ok: false as const,
                  sessionKey,
                  error: { code: "UNAVAILABLE", message: "database busy" },
                }
              : {
                  ok: true as const,
                  sessionKey,
                  revision: 1,
                  hasBoard: true,
                },
          ),
        };
      }),
      addEventListener: vi.fn((next) => {
        listener = next as typeof listener;
        return () => {
          listener = undefined;
        };
      }),
    };
    let controller: BoardAvailabilityController | undefined;
    const host: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        controller = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    };
    controller = new BoardAvailabilityController(
      host,
      () => sessionKeys,
      boardProviderForSession,
      () => ({
        client: client as never,
        connected: true,
        available: true,
        metadataAvailable: true,
        key: "gateway-a",
      }),
    );
    controller.hostConnected();

    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledOnce();
    expect(client.request).toHaveBeenCalledWith("board.metadata", { sessionKeys });
    expect(sessionHasBoard(sessionKeys[0]!)).toBe(true);
    expect(sessionHasBoard(sessionKeys[4]!)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(client.request).toHaveBeenLastCalledWith("board.metadata", {
      sessionKeys: [sessionKeys[4]],
    });
    expect(sessionHasBoard(sessionKeys[4]!)).toBe(true);

    listener?.({
      event: "board.changed",
      payload: { sessionKey: sessionKeys[0], revision: 1 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledTimes(2);

    listener?.({
      event: "board.changed",
      payload: { sessionKey: sessionKeys[0], revision: 2 },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledTimes(3);
    expect(client.request).toHaveBeenLastCalledWith("board.metadata", {
      sessionKeys: [sessionKeys[0]],
    });

    controller.hostDisconnected();
    expect(listener).toBeUndefined();
    clearSessionBoardAvailability();
    vi.useRealTimers();
  });

  it("ignores an older lookup after a session is hidden and shown again", async () => {
    vi.stubGlobal("location", { search: "" });
    const sessionKey = "agent:main:sidebar-race";
    let visible = true;
    const resolvers: Array<
      (snapshot: {
        sessionKey: string;
        revision: number;
        tabs: Array<{ tabId: string; title: string; position: number; chatDock: "right" }>;
        widgets: [];
      }) => void
    > = [];
    const client = {
      request: vi.fn(
        () =>
          new Promise((resolve) => {
            resolvers.push(resolve);
          }),
      ),
      addEventListener: vi.fn(() => () => {}),
    };
    const requestUpdate = vi.fn();
    let controller: BoardAvailabilityController | undefined;
    const host: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        controller = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate,
      updateComplete: Promise.resolve(true),
    };
    controller = new BoardAvailabilityController(
      host,
      () => (visible ? [sessionKey] : []),
      boardProviderForSession,
      () => ({ client: client as never, connected: true, available: true, key: "gateway-a" }),
    );
    controller.hostConnected();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    visible = false;
    controller.hostUpdate();
    visible = true;
    controller.hostUpdate();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.({ sessionKey, revision: 2, tabs: [], widgets: [] });
    await vi.waitFor(() => expect(requestUpdate).toHaveBeenCalledOnce());

    resolvers[0]?.({
      sessionKey,
      revision: 1,
      tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
      widgets: [],
    });
    await Promise.resolve();
    expect(sessionHasBoard(sessionKey)).toBe(false);
    controller.hostDisconnected();
  });

  it("clears cached presence when a reconnect loses board support", async () => {
    vi.stubGlobal("location", { search: "" });
    const sessionKey = "agent:main:sidebar-capability-change";
    const source = {
      client: {
        request: vi.fn(async () => ({
          sessionKey,
          revision: 1,
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" as const }],
          widgets: [],
        })),
        addEventListener: vi.fn(() => () => {}),
      },
      connected: true,
      available: true,
      key: "gateway-a",
    };
    const requestUpdate = vi.fn();
    let controller: BoardAvailabilityController | undefined;
    const host: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        controller = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate,
      updateComplete: Promise.resolve(true),
    };
    controller = new BoardAvailabilityController(
      host,
      () => [sessionKey],
      boardProviderForSession,
      () => source as never,
    );
    controller.hostConnected();
    await vi.waitFor(() => expect(sessionHasBoard(sessionKey)).toBe(true));
    const updatesAfterLoad = requestUpdate.mock.calls.length;

    source.connected = false;
    controller.hostUpdate();
    expect(sessionHasBoard(sessionKey)).toBe(true);

    source.connected = true;
    source.available = false;
    controller.hostUpdate();
    expect(sessionHasBoard(sessionKey)).toBe(false);
    expect(requestUpdate).toHaveBeenCalledTimes(updatesAfterLoad + 1);
    controller.hostDisconnected();
  });

  it("retries a transient lookup failure with bounded backoff", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", { search: "" });
    const sessionKey = "agent:main:sidebar-retry";
    const client = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error("gateway busy"))
        .mockResolvedValue({
          sessionKey,
          revision: 1,
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
          widgets: [],
        }),
      addEventListener: vi.fn(() => () => {}),
    };
    let controller: BoardAvailabilityController | undefined;
    const host: ReactiveControllerHost = {
      addController(next: ReactiveController) {
        controller = next as BoardAvailabilityController;
      },
      removeController() {},
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    };
    controller = new BoardAvailabilityController(
      host,
      () => [sessionKey],
      boardProviderForSession,
      () => ({ client: client as never, connected: true, available: true, key: "gateway-a" }),
    );
    controller.hostConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.request).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.request).toHaveBeenCalledTimes(2);
    expect(sessionHasBoard(sessionKey)).toBe(true);
    controller.hostDisconnected();
    vi.useRealTimers();
  });
});
