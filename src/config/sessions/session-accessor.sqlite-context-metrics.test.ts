import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readSessionTranscriptContextByteSize,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptVisibleStats,
} from "./session-accessor.sqlite-active-events.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite transcript context metrics", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    scope = {
      agentId: "main",
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: tempDirs.make("openclaw-transcript-context-metrics-"),
      },
      sessionId: "transcript-context-metrics-test",
      sessionKey: "agent:main:transcript-context-metrics-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("counts only messages visible after a reset", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "kept-user",
          parentId: "old",
          message: { role: "user", content: "kept question" },
        },
        {
          eventId: "kept-tool",
          parentId: "kept-user",
          message: { role: "toolResult", content: `hidden tool ${"x".repeat(2_000)}` },
        },
        {
          eventId: "kept-assistant",
          parentId: "kept-tool",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "reset-boundary",
      parentId: "kept-assistant",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "kept-user",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-reset",
          parentId: "reset-boundary",
          message: { role: "user", content: "new turn" },
        },
      ],
      touchSessionEntry: false,
    });

    const visibleRows = readSessionTranscriptMessageEventPage(scope, {
      maxMessages: 10,
      offset: 0,
    }).events.map(({ event }) => JSON.stringify(event));

    expect(readSessionTranscriptVisibleStats(scope)).toEqual({
      eventCount: visibleRows.length,
      sizeBytes: visibleRows.reduce(
        (total, eventJson) => total + Buffer.byteLength(eventJson, "utf8") + 1,
        0,
      ),
    });
  });

  it("excludes private upstream prompt provenance from visible transcript bytes", async () => {
    const content = `actual prompt ${"y".repeat(4_096)}`;
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "provenance-heavy-user",
          parentId: null,
          message: {
            role: "user",
            content,
            __openclaw: {
              senderIsOwner: true,
              upstreamUserText: `assembled context ${"x".repeat(1_000_000)}`,
            },
          },
        },
      ],
      touchSessionEntry: false,
    });

    const [visible] = readSessionTranscriptMessageEventPage(scope, {
      maxMessages: 1,
      offset: 0,
    }).events;
    if (!visible) {
      throw new Error("expected one visible transcript event");
    }
    const replayEvent = structuredClone(visible.event) as {
      message: Record<string, unknown>;
    };
    const replayMeta = replayEvent.message["__openclaw"] as Record<string, unknown>;
    delete replayMeta.upstreamUserText;
    const stats = readSessionTranscriptVisibleStats(scope);

    expect(stats).toEqual({
      eventCount: 1,
      sizeBytes: Buffer.byteLength(JSON.stringify(replayEvent), "utf8") + 1,
    });
    expect(stats.sizeBytes).toBeGreaterThan(Buffer.byteLength(content, "utf8"));
    expect(stats.sizeBytes).toBeLessThan(10_000);
  });

  it("measures compaction replay bytes without hiding durable UI history", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "large-old",
          parentId: null,
          message: { role: "user", content: `old ${"x".repeat(8_000)}` },
        },
        {
          eventId: "kept",
          parentId: "large-old",
          message: { role: "assistant", content: "kept answer" },
        },
      ],
      touchSessionEntry: false,
    });
    const bytesBefore = readSessionTranscriptContextByteSize(scope);

    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "compaction-boundary",
      parentId: "kept",
      timestamp: "2026-08-13T00:00:00.000Z",
      summary: "short summary",
      firstKeptEntryId: "kept",
      tokensBefore: 2_000,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-compaction",
          parentId: "compaction-boundary",
          message: { role: "user", content: "continue" },
        },
      ],
      touchSessionEntry: false,
    });

    const replayBytes = readSessionTranscriptContextByteSize(scope);
    const visibleStats = readSessionTranscriptVisibleStats(scope);
    expect(bytesBefore).toBeGreaterThan(8_000);
    expect(replayBytes).toBeGreaterThan(Buffer.byteLength("short summary", "utf8"));
    expect(replayBytes).toBeLessThan(bytesBefore / 2);
    expect(visibleStats.eventCount).toBe(3);
    expect(visibleStats.sizeBytes).toBeGreaterThan(bytesBefore);

    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "later",
          parentId: "post-compaction",
          message: { role: "assistant", content: "later answer" },
        },
      ],
      touchSessionEntry: false,
    });
    expect(readSessionTranscriptContextByteSize(scope)).toBeGreaterThan(replayBytes);
  });
});
