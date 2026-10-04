import { expect, it, type Mock } from "vitest";
import {
  makeSuccessResult,
  runInitialFallbackAttempt,
  type FallbackRunnerParams,
} from "./agent-command.live-model-switch.test-helpers.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";

export function registerAgentCommandFastModeCases(support: {
  state: { runtimeConfigMock: unknown; runWithModelFallbackMock: Mock; runAgentAttemptMock: Mock };
  agentCommand: typeof import("./agent-command.js").agentCommand;
  runBasicAgentCommand: () => Promise<unknown>;
  setupSingleAttemptFallback: () => void;
  mockCallArg: (mock: Mock, callIndex?: number) => unknown;
  expectRecordFields: (value: unknown, expected: Record<string, unknown>) => void;
}): void {
  const {
    state,
    agentCommand,
    runBasicAgentCommand,
    setupSingleAttemptFallback,
    mockCallArg,
    expectRecordFields,
  } = support;
  it("keeps the fast mode cutoff timestamp across live model switch retries", async () => {
    let invocation = 0;
    state.runWithModelFallbackMock.mockImplementation(async (params: FallbackRunnerParams) => {
      invocation++;
      const result = await runInitialFallbackAttempt(params);
      if (invocation === 1) {
        throw new LiveSessionModelSwitchError({
          provider: "openai",
          model: "gpt-5.4",
        });
      }
      return {
        result,
        provider: params.provider,
        model: params.model,
        attempts: [],
      };
    });
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("openai", "gpt-5.4"));

    await runBasicAgentCommand();

    const firstAttempt = mockCallArg(state.runAgentAttemptMock, 0) as {
      fastModeStartedAtMs?: number;
    };
    const secondAttempt = mockCallArg(state.runAgentAttemptMock, 1) as {
      fastModeStartedAtMs?: number;
    };
    expect(firstAttempt.fastModeStartedAtMs).toBeTypeOf("number");
    expect(firstAttempt.fastModeStartedAtMs).toBe(secondAttempt.fastModeStartedAtMs);
  });

  it("blocks an explicit run fast mode when the selected model forbids it", async () => {
    state.runtimeConfigMock = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude" },
          models: {
            "anthropic/claude": { params: { fastModeAllowed: false } },
          },
        },
      },
    };
    setupSingleAttemptFallback();
    state.runAgentAttemptMock.mockResolvedValue(makeSuccessResult("anthropic", "claude"));

    await agentCommand({
      message: "hello",
      to: "+1234567890",
      fastMode: true,
    });

    expectRecordFields(mockCallArg(state.runAgentAttemptMock), { fastMode: false });
  });
}
