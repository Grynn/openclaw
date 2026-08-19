import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  all: vi.fn(),
  isReconcileRunning: vi.fn(),
  listDirtySessions: vi.fn(),
  openDatabase: vi.fn(),
  prepare: vi.fn(),
  startReconcile: vi.fn(),
}));

vi.mock("../../state/openclaw-agent-db.js", () => ({
  openOpenClawAgentDatabase: (...args: unknown[]) => mocks.openDatabase(...args),
}));
vi.mock("./session-transcript-index.js", () => ({
  listSessionsNeedingTranscriptIndexReconcile: (...args: unknown[]) =>
    mocks.listDirtySessions(...args),
}));
vi.mock("./session-transcript-reconcile.js", () => ({
  isSessionTranscriptIndexReconcileRunning: (...args: unknown[]) =>
    mocks.isReconcileRunning(...args),
  startSessionTranscriptIndexReconcile: (...args: unknown[]) => mocks.startReconcile(...args),
}));

import { searchSessionTranscriptsBatch } from "./session-transcript-search.js";

describe("searchSessionTranscriptsBatch setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.all.mockReturnValue([]);
    mocks.prepare.mockReturnValue({ all: mocks.all });
    mocks.openDatabase.mockReturnValue({ db: { prepare: mocks.prepare } });
    mocks.listDirtySessions.mockReturnValue([]);
    mocks.isReconcileRunning.mockReturnValue(false);
  });

  it("shares database, index, and statement setup across all queries", () => {
    const result = searchSessionTranscriptsBatch({
      agentId: "main",
      queries: ["alpha", "beta plan", "gamma"],
      limit: 3,
    });

    expect(result).toHaveLength(3);
    expect(mocks.openDatabase).toHaveBeenCalledOnce();
    expect(mocks.listDirtySessions).toHaveBeenCalledOnce();
    expect(mocks.isReconcileRunning).toHaveBeenCalledOnce();
    expect(mocks.startReconcile).not.toHaveBeenCalled();
    expect(mocks.prepare).toHaveBeenCalledOnce();
    expect(mocks.all).toHaveBeenCalledTimes(3);
    expect(mocks.all.mock.calls).toEqual([
      ['"alpha"', 4],
      ['"beta" AND "plan"', 4],
      ['"gamma"', 4],
    ]);
  });
});
