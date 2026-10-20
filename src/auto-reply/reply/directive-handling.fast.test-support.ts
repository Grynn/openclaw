import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { handleDirectiveOnly } from "./directive-handling.impl.js";

type HandleParams = Parameters<typeof handleDirectiveOnly>[0];
type SessionEntry = HandleParams["sessionEntry"];

export function registerFastDirectiveTests(harness: {
  runHandleCommand: (
    command: string,
    overrides?: Partial<HandleParams>,
  ) => ReturnType<typeof handleDirectiveOnly>;
  createSessionEntry: (overrides?: Partial<SessionEntry>) => SessionEntry;
  persistModelDirectiveForTest: (params: {
    command: string;
    cfg: OpenClawConfig;
    sessionEntry: SessionEntry;
    provider: string;
    model: string;
    allowedModelKeys: string[];
  }) => Promise<{
    result: { kind: string; directiveAck?: { text?: string } };
  }>;
}) {
  const { runHandleCommand, createSessionEntry, persistModelDirectiveForTest } = harness;

  it("rejects enabling fast mode under provider policy while allowing saved preferences to be cleared", async () => {
    const sessionEntry = createSessionEntry({ fastMode: true });
    const params = {
      provider: "anthropic",
      model: "claude",
      sessionEntry,
      currentFastMode: true,
      cfg: {
        models: {
          providers: { anthropic: { baseUrl: "", models: [], params: { fastModeAllowed: false } } },
        },
      },
    } satisfies Partial<HandleParams>;
    for (const mode of ["on", "auto", "ultrafast"]) {
      expect((await runHandleCommand(`/fast ${mode}`, params))?.text).toContain(
        "disabled by policy",
      );
      expect(sessionEntry.fastMode).toBe(true);
    }
    expect((await runHandleCommand("/fast status", params))?.text).toContain(
      "Current fast mode: off",
    );
    expect((await runHandleCommand("/fast default", params))?.text).toContain("reset to default");
    expect(sessionEntry.fastMode).toBeUndefined();
    expect((await runHandleCommand("/fast off", params))?.text).toContain("Fast mode disabled");
    expect(sessionEntry.fastMode).toBe(false);
    const mixed = await persistModelDirectiveForTest({
      command: "/fast on continue with the request",
      cfg: params.cfg,
      sessionEntry,
      provider: params.provider,
      model: params.model,
      allowedModelKeys: [],
    });
    expect(mixed.result.kind).toBe("continue");
    expect(mixed.result.directiveAck?.text).toContain("disabled by policy");
    expect(sessionEntry.fastMode).toBe(false);
  });
}
