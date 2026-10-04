import path from "node:path";
import { expect, it } from "vitest";
import type { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { createReplyRestartRecoveryClaimController } from "./restart-recovery-claim.js";

export function createTestAdmission(params: {
  entryId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  return {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    generation: "test-generation",
    entryId: params.entryId,
    rawSeq: 1,
    effectiveParentId: null,
    activeMessagePosition: 0,
    logicalTurnId: `${params.entryId}:turn`,
    role: "user" as const,
  };
}

export function registerRestartRecoveryDeferralTests(
  tempDirs: Pick<ReturnType<typeof useAutoCleanupTempDirTracker>, "make">,
): void {
  it.each([
    "current",
    "commit-rotation",
    "commit-restart",
    "commit-user-abort",
    "commit-revoked",
    "missing-generation",
  ] as const)("fences deferred recovery at commit through %s", async (interruption) => {
    const root = tempDirs.make("openclaw-reply-deferral-fence-");
    const scope = { storePath: path.join(root, "sessions.json"), sessionKey: "agent:main:main" };
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const abort = new AbortController();
    let restartAborted = false;
    let revoked = false;
    let interruptBeforeCommit = false;
    let entry: InternalSessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      status: "running",
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-turn",
      restartRecoveryDeliveryContext: { channel: "telegram", to: "chat" },
    };
    await replaceSessionEntry(scope, entry);
    const controller = createReplyRestartRecoveryClaimController({
      ...scope,
      agentId: "main",
      lifecycleGeneration: interruption === "missing-generation" ? undefined : lifecycleGeneration,
      admissionRunId: "recovery-run",
      getEntry: () => entry,
      getSessionId: () => {
        if (interruptBeforeCommit) {
          interruptBeforeCommit = false;
          queueMicrotask(() => {
            if (interruption === "commit-rotation") {
              rotateAgentEventLifecycleGeneration();
            } else if (interruption === "commit-restart") {
              restartAborted = true;
            } else if (interruption === "commit-user-abort") {
              abort.abort(new Error("user cancelled"));
            } else if (interruption === "commit-revoked") {
              revoked = true;
            }
          });
        }
        return "session";
      },
      isRestartAbort: () => restartAborted,
      assertRecoveryDeferralCurrent: () => {
        abort.signal.throwIfAborted();
        if (revoked) {
          throw new Error("operator authority revoked");
        }
      },
      resolveDeliveryContext: () => entry.restartRecoveryDeliveryContext,
      setEntry: (next) => {
        entry = next;
      },
    });
    await expect(controller.admitUserTurn()).resolves.toBe("admitted");
    const before = loadSessionEntry(scope);
    interruptBeforeCommit = true;
    const deferral = controller.deferToRecovery(new Error("setup failed"));
    if (interruption === "current") {
      await expect(deferral).resolves.toBe(true);
      expect(loadSessionEntry(scope)).toMatchObject({
        abortedLastRun: true,
        restartRecoveryDeferralCause: "turn-failure",
      });
    } else {
      if (interruption === "missing-generation") {
        await expect(deferral).resolves.toBe(false);
      } else {
        await expect(deferral).rejects.toThrow();
      }
      expect(loadSessionEntry(scope)).toEqual(before);
    }
  });
}
