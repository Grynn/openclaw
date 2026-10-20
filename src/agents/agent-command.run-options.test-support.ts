import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { agentCommand } from "./agent-command.js";

export function registerAgentCommandRunOptionCases(params: {
  state: {
    runtimeConfigMock: unknown;
    defaultRuntimeConfig: OpenClawConfig;
    acpResolveSessionMock: Mock;
    runAgentAttemptMock: Mock;
  };
  setupSuccessfulAttempt: (provider?: string, model?: string) => void;
  setupAdmittedSuccessfulAttempt: () => void;
  runBasicAgentCommand: (
    overrides?: Partial<Parameters<typeof agentCommand>[0]>,
  ) => ReturnType<typeof agentCommand>;
}) {
  const { state, setupSuccessfulAttempt, setupAdmittedSuccessfulAttempt, runBasicAgentCommand } =
    params;
  it("keeps an explicit run speed off when Anthropic provider policy forbids it", async () => {
    state.runtimeConfigMock = {
      agents: { defaults: { model: { primary: "anthropic/claude" } } },
      models: {
        providers: {
          anthropic: { baseUrl: "", models: [], params: { fastModeAllowed: false } },
        },
      },
    };
    setupSuccessfulAttempt("anthropic", "claude");
    await runBasicAgentCommand({ fastMode: true });
    expect(state.runAgentAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ fastMode: false }),
    );
  });

  it("applies the configured run cwd to ordinary (non-ACP) command sessions", async () => {
    state.runtimeConfigMock = {
      ...state.defaultRuntimeConfig,
      agents: {
        ...state.defaultRuntimeConfig.agents,
        defaults: { ...state.defaultRuntimeConfig.agents?.defaults, cwd: "/tmp/task-repo" },
      },
    };
    // Ordinary sessions resolve to a truthy { kind: "none" }; only a real ACP
    // placement may keep the configured cwd away from the run.
    state.acpResolveSessionMock.mockReturnValue({ kind: "none" });
    setupAdmittedSuccessfulAttempt();

    await runBasicAgentCommand();

    expect(state.runAgentAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/tmp/task-repo", workspaceDir: "/tmp/workspace" }),
    );
  });
}
