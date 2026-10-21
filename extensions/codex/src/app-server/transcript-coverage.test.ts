import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { TranscriptTurnAdmission } from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it } from "vitest";
import { readCodexAppServerThreadBinding } from "./session-binding.js";
import {
  buildCodexCompletedCoveragePatch,
  buildCodexTranscriptCoverage,
  fingerprintCodexTranscriptCoverageMessage,
  selectCodexUncoveredTranscriptMessages,
} from "./transcript-coverage.js";
import { fingerprintCodexMirrorSourceMessage } from "./transcript-mirror-attestation.js";

type TestUserMessage = Extract<AgentMessage, { role: "user" }> & {
  idempotencyKey?: string;
  __openclaw?: Record<string, unknown>;
};

function admission(generation: string): TranscriptTurnAdmission {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    storePath: "/tmp/openclaw.sqlite",
    generation,
    entryId: "entry-1",
    rawSeq: 4,
    effectiveParentId: "parent-1",
    activeMessagePosition: 3,
    idempotencyKey: "prompt-1",
    logicalTurnId: "logical-1",
    role: "user",
  };
}

function user(
  content: string,
  options: {
    idempotencyKey?: string;
    metadata?: Record<string, unknown>;
    timestamp?: number;
  } = {},
): TestUserMessage {
  return {
    role: "user",
    content,
    timestamp: options.timestamp ?? 0,
    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
    ...(options.metadata ? { __openclaw: options.metadata } : {}),
  };
}

function promptAnchor(content = "accepted prompt"): TestUserMessage {
  const upstreamUserText = "accepted native input";
  const sourceFingerprint = fingerprintCodexMirrorSourceMessage(
    user(content, { metadata: { upstreamUserText } }),
  );
  return user(content, {
    idempotencyKey: "prompt-1",
    metadata: {
      runId: "run-1",
      mirrorIdentity: "turn-1:prompt",
      mirrorOrigin: "codex-app-server",
      mirrorSourceFingerprint: sourceFingerprint,
      upstreamUserText,
    },
    timestamp: 10,
  });
}

function coverageFor(message = promptAnchor()) {
  const sourceFingerprint = Reflect.get(message, "__openclaw")?.mirrorSourceFingerprint;
  if (typeof sourceFingerprint !== "string") {
    throw new Error("fixture prompt has no source fingerprint");
  }
  return {
    schemaVersion: 2 as const,
    threadId: "thread-1",
    runId: "run-1",
    idempotencyKey: "prompt-1",
    mirrorIdentity: "turn-1:prompt",
    mirrorSourceFingerprint: sourceFingerprint,
    messageFingerprint: fingerprintCodexTranscriptCoverageMessage(message),
  };
}

describe("Codex exact transcript coverage", () => {
  it("attests the annotated admitted prompt across a generation rewrite", () => {
    const message = promptAnchor();
    expect(
      buildCodexTranscriptCoverage({
        admissionBeforeAnnotation: admission("before"),
        admissionAfterAnnotation: admission("after"),
        persistedMessage: message,
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-1",
      }),
    ).toEqual(coverageFor(message));
  });

  it("rejects a changed admission owner or prompt annotation", () => {
    const wrongIdentity = promptAnchor();
    const wrongIdentityMessage: TestUserMessage = {
      ...wrongIdentity,
      __openclaw: {
        ...Reflect.get(wrongIdentity, "__openclaw"),
        mirrorIdentity: "another-turn:prompt",
      },
    };
    expect(
      buildCodexTranscriptCoverage({
        admissionBeforeAnnotation: admission("before"),
        admissionAfterAnnotation: { ...admission("after"), entryId: "replacement" },
        persistedMessage: promptAnchor(),
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-1",
      }),
    ).toBeUndefined();
    expect(
      buildCodexTranscriptCoverage({
        admissionBeforeAnnotation: admission("before"),
        admissionAfterAnnotation: admission("after"),
        persistedMessage: wrongIdentityMessage,
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-1",
      }),
    ).toBeUndefined();
    const editedAfterAnnotation = { ...promptAnchor(), content: "edited after annotation" };
    expect(
      buildCodexTranscriptCoverage({
        admissionBeforeAnnotation: admission("before"),
        admissionAfterAnnotation: admission("after"),
        persistedMessage: editedAfterAnnotation,
        threadId: "thread-1",
        turnId: "turn-1",
        runId: "run-1",
      }),
    ).toBeUndefined();
  });

  it("selects rows after the exact anchor and removes only confirmed same-run steering", () => {
    const anchor = promptAnchor();
    const sameRunSteer = user("already steered", {
      metadata: { steerTargetRunId: "run-1" },
    });
    const otherRunSteer = user("belongs to another run", {
      metadata: { steerTargetRunId: "run-other" },
    });
    const late = user("late unsteered row");
    const nativeMirror = user("native assistant copy", {
      idempotencyKey: "codex-app-server:thread-1:turn-1:assistant",
    });
    const selection = selectCodexUncoveredTranscriptMessages({
      messages: [user("old host row"), anchor, sameRunSteer, nativeMirror, otherRunSteer, late],
      binding: { threadId: "thread-1", cwd: "/tmp", transcriptCoverage: coverageFor(anchor) },
    });
    expect(selection).toEqual({ mode: "exact", messages: [otherRunSteer, late] });
  });

  it.each([
    ["missing", [user("old host row"), user("late row")]],
    ["duplicate", [promptAnchor(), promptAnchor(), user("late row")]],
    ["edited", [promptAnchor("edited after completion"), user("late row")]],
  ])("replays all projectable host rows when the exact anchor is %s", (_name, messages) => {
    const confirmedSteer = user("confirmed steer", {
      metadata: { steerTargetRunId: "run-1" },
    });
    const selection = selectCodexUncoveredTranscriptMessages({
      messages: [...messages, confirmedSteer],
      binding: {
        threadId: "thread-1",
        cwd: "/tmp",
        transcriptCoverage: coverageFor(),
      },
    });
    expect(selection.mode).toBe("conservative");
    expect(selection.messages).toContain(confirmedSteer);
  });

  it("replays conservatively when the receipt belongs to another native thread", () => {
    const old = user("old host row");
    const selection = selectCodexUncoveredTranscriptMessages({
      messages: [old, promptAnchor()],
      binding: {
        threadId: "thread-2",
        cwd: "/tmp",
        transcriptCoverage: coverageFor(),
      },
    });
    expect(selection).toEqual({ mode: "conservative", messages: [old] });
  });

  it("retains legacy timestamp selection when no exact receipt exists", () => {
    const recent = user("recent", { timestamp: 30 });
    expect(
      selectCodexUncoveredTranscriptMessages({
        messages: [user("old", { timestamp: 10 }), recent],
        binding: {
          threadId: "thread-1",
          cwd: "/tmp",
          historyCoveredThrough: new Date(20).toISOString(),
        },
      }),
    ).toEqual({ mode: "legacy", messages: [recent] });
  });

  it("preserves maintenance and mismatch recovery semantics", () => {
    const coverage = coverageFor();
    const startupBinding = {
      threadId: "thread-1",
      cwd: "/tmp",
      transcriptCoverage: coverage,
    };
    expect(
      buildCodexCompletedCoveragePatch({
        hasRecorder: false,
        coverage: undefined,
        startupBinding,
        threadId: "thread-1",
        completedAt: "2026-10-21T00:00:00.000Z",
      }),
    ).toEqual({});
    expect(
      buildCodexCompletedCoveragePatch({
        hasRecorder: false,
        coverage: undefined,
        startupBinding: { threadId: "thread-1", cwd: "/tmp" },
        threadId: "thread-1",
        completedAt: "2026-10-21T00:00:00.000Z",
      }),
    ).toEqual({
      historyCoveredThrough: "2026-10-21T00:00:00.000Z",
      transcriptCoverage: undefined,
    });
    expect(
      buildCodexCompletedCoveragePatch({
        hasRecorder: true,
        coverage,
        startupBinding,
        threadId: "thread-1",
        completedAt: "2026-10-21T00:00:00.000Z",
      }),
    ).toEqual({ historyCoveredThrough: undefined, transcriptCoverage: coverage });
    expect(
      buildCodexCompletedCoveragePatch({
        hasRecorder: true,
        coverage: undefined,
        startupBinding,
        threadId: "thread-1",
        completedAt: "2026-10-21T00:00:00.000Z",
      }),
    ).toEqual({ historyCoveredThrough: undefined });
    expect(
      buildCodexCompletedCoveragePatch({
        hasRecorder: true,
        coverage: undefined,
        startupBinding,
        threadId: "thread-2",
        completedAt: "2026-10-21T00:00:00.000Z",
      }),
    ).toEqual({ historyCoveredThrough: undefined, transcriptCoverage: undefined });
  });

  it("round-trips V2 coverage and ignores an incompatible old receipt", () => {
    const coverage = coverageFor();
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-1",
        cwd: "/tmp",
        transcriptCoverage: coverage,
      })?.transcriptCoverage,
    ).toEqual(coverage);
    expect(
      readCodexAppServerThreadBinding({
        threadId: "thread-1",
        cwd: "/tmp",
        transcriptCoverage: { ...coverage, schemaVersion: 1 },
      })?.transcriptCoverage,
    ).toBeUndefined();
  });
});
