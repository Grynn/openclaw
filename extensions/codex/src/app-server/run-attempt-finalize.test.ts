import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasCompletedBootstrapTurn } from "openclaw/plugin-sdk/agent-bootstrap-runtime";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { persistCodexCompletedBootstrapTurnAfterMirror } from "./run-attempt-bootstrap-persistence.js";

describe("Codex completed bootstrap finalization", () => {
  let tempDir: string;
  let sessionTarget: {
    agentId: string;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bootstrap-finalize-"));
    const sessionId = randomUUID();
    sessionTarget = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(tempDir, "sessions.json"),
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("persists only after a successful uncompacted turn is mirrored", async () => {
    await expect(
      persistCodexCompletedBootstrapTurnAfterMirror({
        attemptSucceeded: true,
        compactionCount: 0,
        mirroredMessageCount: 2,
        runId: "codex-run",
        sessionTarget,
        shouldRecordCompletedBootstrapTurn: true,
      }),
    ).resolves.toBe(true);
    expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(true);
  });

  it.each([
    ["bootstrap recording was not requested", false, true, 0, 1],
    ["the attempt failed", true, false, 0, 1],
    ["the attempt compacted", true, true, 1, 1],
    ["the transcript mirror was empty", true, true, 0, 0],
  ] as const)(
    "does not persist when %s",
    async (
      _reason,
      shouldRecordCompletedBootstrapTurn,
      attemptSucceeded,
      compactionCount,
      mirroredMessageCount,
    ) => {
      await expect(
        persistCodexCompletedBootstrapTurnAfterMirror({
          attemptSucceeded,
          compactionCount,
          mirroredMessageCount,
          runId: "codex-run",
          sessionTarget,
          shouldRecordCompletedBootstrapTurn,
        }),
      ).resolves.toBe(false);
      expect(await hasCompletedBootstrapTurn(sessionTarget)).toBe(false);
    },
  );

  it("treats marker persistence failures as best effort", async () => {
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);

    await expect(
      persistCodexCompletedBootstrapTurnAfterMirror({
        attemptSucceeded: true,
        mirroredMessageCount: 1,
        runId: "codex-run",
        sessionTarget: {
          ...sessionTarget,
          storePath: path.join("/dev/null", "sessions.json"),
        },
        shouldRecordCompletedBootstrapTurn: true,
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "failed to persist codex completed bootstrap marker",
      expect.objectContaining({ runId: "codex-run" }),
    );
  });
});
