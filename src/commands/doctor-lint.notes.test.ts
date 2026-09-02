import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  };
});

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

describe("runDoctorLintCli note output", () => {
  let previousStateDir: string | undefined;
  let stateDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthChecksForTest();
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-notes-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {},
      path: path.join(stateDir, "openclaw.json"),
    });
  });

  afterEach(() => {
    clearHealthChecksForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("keeps legacy health-check notes out of JSON stdout", async () => {
    registerHealthCheck({
      id: "test/json-note-leak",
      kind: "plugin",
      description: "test legacy note suppression",
      async detect() {
        note("legacy diagnostic", "Doctor warnings");
        return [];
      },
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        onlyIds: ["test/json-note-leak"],
      });

      expect(exitCode).toBe(0);
      expect(stdout).toHaveBeenCalledTimes(1);
      const output = String(stdout.mock.calls[0]?.[0]);
      expect(output).not.toContain("legacy diagnostic");
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        checksRun: 1,
        findings: [],
      });
    } finally {
      stdout.mockRestore();
    }
  });
});
