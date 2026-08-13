import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(process.cwd(), "scripts", "update-gateway.sh");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function runUpdater(overrides: Record<string, string | undefined>) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-update-gateway-test-"));
  tempRoots.push(root);
  const binDir = path.join(root, "bin");
  const gitLog = path.join(root, "git.log");
  writeFileSync(
    path.join(root, "placeholder"),
    "The fake bin directory is created below so the fixture root already exists.\n",
  );
  mkdirSync(binDir);
  const fakeGit = path.join(binDir, "git");
  writeFileSync(
    fakeGit,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$OPENCLAW_TEST_GIT_LOG"\nexit 93\n',
  );
  chmodSync(fakeGit, 0o755);

  const env = {
    ...process.env,
    OPENCLAW_TEST_GIT_LOG: gitLog,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
  };
  delete env.OPENCLAW_UPDATE_RESTART_CMD;
  delete env.OPENCLAW_UPDATE_STOP_CMD;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const result = spawnSync("bash", [SCRIPT], { encoding: "utf8", env });
  return {
    ...result,
    gitCalls: existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "",
  };
}

describe("update-gateway command overrides", () => {
  it("accepts the paired built-in defaults", () => {
    const result = runUpdater({});

    expect(result.status).toBe(93);
    expect(result.gitCalls).toContain("rev-parse --git-dir");
  });

  it("accepts paired custom commands after trimming surrounding whitespace", () => {
    const result = runUpdater({
      OPENCLAW_UPDATE_RESTART_CMD: "  custom restart\t",
      OPENCLAW_UPDATE_STOP_CMD: "\n custom stop  ",
    });

    expect(result.status).toBe(93);
    expect(result.gitCalls).toContain("rev-parse --git-dir");
  });

  it.each([
    ["stop only", { OPENCLAW_UPDATE_STOP_CMD: "custom stop" }],
    ["restart only", { OPENCLAW_UPDATE_RESTART_CMD: "custom restart" }],
  ])("rejects a %s override before touching git", (_name, overrides) => {
    const result = runUpdater(overrides);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be set together");
    expect(result.gitCalls).toBe("");
  });

  it.each([
    ["stop", { OPENCLAW_UPDATE_RESTART_CMD: "custom restart", OPENCLAW_UPDATE_STOP_CMD: " \t\n" }],
    ["restart", { OPENCLAW_UPDATE_RESTART_CMD: "\n\t ", OPENCLAW_UPDATE_STOP_CMD: "custom stop" }],
  ])("rejects a whitespace-only %s command before touching git", (command, overrides) => {
    const result = runUpdater(overrides);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`OPENCLAW_UPDATE_${command.toUpperCase()}_CMD is blank`);
    expect(result.gitCalls).toBe("");
  });
});
