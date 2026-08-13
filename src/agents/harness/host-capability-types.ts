import type { AnyAgentTool } from "../tools/common.js";

type AgentHarnessHostApprovalDecision = "allow-once" | "allow-always" | "deny";

export type AgentHarnessHostCapabilities = Readonly<{
  kind: "agent-harness-host-capability";
  version: 1;
  /** Fails closed unless this exact admitted run capability remains active. */
  assertActive: () => void;
  /** Applies the exact host caller binding to a plugin-built tool surface. */
  bindToolSurface: (tools: AnyAgentTool[], options?: Readonly<{ cwd?: string }>) => AnyAgentTool[];
  /** Runs policy with host-fixed HookContext; callers provide only the native action tuple. */
  runBeforeToolCall: (
    request: Omit<
      Parameters<(typeof import("../agent-tools.before-tool-call.js"))["runBeforeToolCallHook"]>[0],
      "approvalMode" | "ctx"
    > & {
      /** Native relays may defer approval for a correlated app-server callback. */
      approvalMode?: "request" | "defer";
      /** Action-local facts from the native runtime; host authority remains closure-bound. */
      nativeOperation?: Readonly<{ cwd?: string }>;
    },
  ) => ReturnType<(typeof import("../agent-tools.before-tool-call.js"))["runBeforeToolCallHook"]>;
  requestApproval: (request: {
    title: string;
    description: string;
    severity: "info" | "warning";
    toolName: string;
    toolCallId?: string;
    allowedDecisions?: AgentHarnessHostApprovalDecision[];
    timeoutMs: number;
    transportTimeoutMs?: number;
  }) => Promise<{ id?: string; decision?: AgentHarnessHostApprovalDecision | null } | undefined>;
  waitForApproval: (request: {
    approvalId: string;
    timeoutMs: number;
    transportTimeoutMs?: number;
    signal?: AbortSignal;
  }) => Promise<AgentHarnessHostApprovalDecision | null | undefined>;
  /**
   * Attempt-local diagnostic sink owned by the host. The wrapper is revoked
   * with the rest of the harness capability, so a plugin cannot retain SQLite
   * write access after its admitted run has ended.
   */
  trajectoryRecorder?: Readonly<{
    recordEvent: (type: string, data?: Record<string, unknown>) => void;
    flush: () => Promise<void>;
  }>;
}>;
