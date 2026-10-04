import { expect, it } from "vitest";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import type { TranscriptTurnAdmission } from "../config/sessions/transcript-entry-anchor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  readCodexSessionTranscriptMessagesBetweenAdmissions,
  refreshCodexSessionTranscriptAdmission,
} from "./codex-session-transcript-runtime.js";

const messages = [
  { role: "user", content: "covered input", timestamp: 100 },
  { role: "user", content: "arrived during native turn", timestamp: 100 },
  { role: "assistant", content: "external assistant result", timestamp: 99 },
  { role: "custom", content: "durable note", customType: "openclaw.system-note", timestamp: 98 },
  { role: "user", content: "current input", timestamp: 100 },
];
const events = [
  { type: "session", id: "exact-admission", version: 3 },
  ...messages.map((message, index) => ({
    type: "message",
    id: `message-${index}`,
    parentId: index ? `message-${index - 1}` : null,
    message,
  })),
];

it("reads exact in-flight arrivals once regardless of equal or older timestamps", async () => {
  await withOpenClawTestState({ label: "codex-exact-admission" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "exact-admission",
      sessionKey: "agent:main:exact-admission",
      storePath: state.statePath("transcript.sqlite"),
      env: state.env,
    };
    await replaceTranscriptEvents(scope, events);
    const facts = await readSessionTranscriptAnchorsAsync(scope, {
      entryIds: ["message-0", "message-4"],
    });
    const admissions = facts.anchors.map((anchor): TranscriptTurnAdmission =>
      Object.assign({}, anchor, { role: "user" as const, logicalTurnId: anchor.entryId }),
    );
    const [covered, current] = admissions;
    expect(covered?.messageFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(current).toBeDefined();
    expect(await readCodexSessionTranscriptMessagesBetweenAdmissions(covered!, current!)).toEqual({
      kind: "ok",
      messages: messages.slice(1, -1),
    });
    expect(await readCodexSessionTranscriptMessagesBetweenAdmissions(current!, current!)).toEqual({
      kind: "ok",
      messages: [],
    });
    expect(await readCodexSessionTranscriptMessagesBetweenAdmissions(current!, covered!)).toEqual({
      kind: "stale",
    });
  });
});

it.each([false, true])(
  "refreshes rewritten admissions only for identical persisted payloads (edited: %s)",
  async (edited) => {
    await withOpenClawTestState({ label: "codex-admission-rewrite" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "exact-admission",
        sessionKey: "agent:main:exact-admission",
        storePath: state.statePath("transcript.sqlite"),
        env: state.env,
      };
      await replaceTranscriptEvents(scope, events);
      const { anchors } = await readSessionTranscriptAnchorsAsync(scope, {
        entryIds: ["message-0"],
      });
      const admission: TranscriptTurnAdmission = {
        ...anchors[0]!,
        role: "user",
        logicalTurnId: "first",
      };
      const rewritten = structuredClone(events);
      if (edited) {
        Object.assign(rewritten[1]!, {
          message: { ...messages[0], content: "edited covered input" },
        });
      }
      await replaceTranscriptEvents(scope, rewritten);
      const refreshed = await refreshCodexSessionTranscriptAdmission(admission);
      if (edited) {
        expect(refreshed).toBeUndefined();
      } else {
        expect(refreshed).toMatchObject({ ...admission, generation: expect.any(String) });
        expect(refreshed?.generation).not.toBe(admission.generation);
      }
      expect(
        await refreshCodexSessionTranscriptAdmission({
          ...admission,
          messageFingerprint: undefined,
        }),
      ).toBeUndefined();
    });
  },
);
