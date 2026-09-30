import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshPersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { importLegacySkillProposal } from "../skills/workshop/store.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { createAppliedLegacyProposal } from "./doctor-skill-workshop-sqlite.test-support.js";

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

it("keeps core state paths anchored to the source view during mixed isolated lint", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-workshop-"));
  const stateDir = path.join(rootDir, "operator-state");
  const configPath = path.join(stateDir, "openclaw.json");
  const config = {
    gateway: { mode: "local" },
    memory: { search: { provider: "local", fallback: "none" } },
  } satisfies OpenClawConfig;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const env = {
    ...process.env,
    HOME: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  refreshPersistedInstalledPluginIndex({
    reason: "manual",
    candidates: [],
    config,
    env,
    stateDir,
  });
  const skillDir = path.join(resolveWorkshopSkillsDir(config, "main", env), "valid-skill");
  const skillContent =
    "---\nname: valid-skill\ndescription: Valid Workshop skill\n---\n\n# Valid\n";
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), skillContent);
  importLegacySkillProposal({
    record: createAppliedLegacyProposal({
      id: "valid-skill-20260905-1234567890",
      title: "Valid Workshop skill",
      description: "Valid Workshop skill",
      content: skillContent,
      target: { skillKey: "valid-skill", skillDir },
    }),
    ownerAgentId: "main",
    store: { env },
  });
  const databasePath = resolveOpenClawStateSqlitePath(env);
  await closeOpenClawStateDatabaseByPathAsync(databasePath);
  const originalEnv = {
    HOME: process.env.HOME,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  };
  process.env.HOME = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;

  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await expect(
      runDoctorLintCli(runtime, {
        json: true,
        severityMin: "warning",
        onlyIds: [
          "memory-core/managed-local-embedding-setup",
          "core/doctor/skill-workshop-relocation",
        ],
      }),
    ).resolves.toBe(0);
    expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: true,
      checksRun: 2,
      findings: [],
    });
  } finally {
    stdout.mockRestore();
    restoreEnv(originalEnv);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function restoreEnv(values: {
  HOME: string | undefined;
  OPENCLAW_CONFIG_PATH: string | undefined;
  OPENCLAW_STATE_DIR: string | undefined;
}): void {
  for (const key of ["HOME", "OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"] as const) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
