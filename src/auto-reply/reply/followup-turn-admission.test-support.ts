import { vi } from "vitest";
import type { FollowupRun } from "./queue.js";

export function createRun(overrides: Partial<FollowupRun> = {}): FollowupRun {
  return {
    prompt: "queued prompt",
    enqueuedAt: 1,
    run: {
      agentId: "agent",
      agentDir: "/tmp/agent",
      sessionId: "queued-session",
      sessionKey: "main",
      sessionFile: "/tmp/queued.jsonl",
      workspaceDir: "/tmp",
      config: {},
      provider: "anthropic",
      model: "claude",
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
    },
    ...overrides,
  };
}

export function createOperation(sessionId = "queued-session") {
  return {
    sessionId,
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    abortForRestart: vi.fn(() => true),
    retainFailureUntilComplete: vi.fn(),
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
}

export function createDefaults(overrides: Record<string, unknown> = {}) {
  return {
    typing: {} as never,
    typingMode: "never" as const,
    defaultModel: "claude",
    sessionKey: "main",
    ...overrides,
  };
}
