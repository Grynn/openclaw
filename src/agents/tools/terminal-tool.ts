import { randomUUID } from "node:crypto";
import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { renderTerminalBufferText } from "../../gateway/terminal/buffer-text.js";
import type { TerminalAgentActionOutcome } from "../../gateway/terminal/session-manager.types.js";
import { getActiveAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import type { ExecMode } from "../../infra/exec-approvals.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import {
  registerExecApprovalRequestForHostOrThrow,
  resolveRegisteredExecApprovalDecision,
} from "../bash-tools.exec-approval-request.js";
import {
  resolveExecDefaults,
  type ExecPolicyOverrides,
  type ExecSessionDefaults,
} from "../exec-defaults.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNonNegativeIntegerParam,
  readPositiveIntegerParam,
  readToolStringParam,
  ToolInputError,
} from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { getInProcessGatewayToolContext } from "./in-process-gateway.js";

const ACTIONS = ["read", "list", "resize", "close", "input"] as const;
const MAX_DIMENSION = 2000;
const DEFAULT_READ_MAX_CHARS = 32 * 1024;
const MAX_READ_CHARS = 128 * 1024;

const TerminalToolSchema = Type.Object(
  {
    action: Type.String({ enum: [...ACTIONS], description: "Action" }),
    sessionId: Type.Optional(Type.String({ description: "Shared terminal session" })),
    data: Type.Optional(Type.String({ description: "Exact terminal input" })),
    cols: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIMENSION })),
    rows: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIMENSION })),
    cursor: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "For read: return output after this cursor from the prior read.",
      }),
    ),
    maxChars: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: MAX_READ_CHARS,
        description: `For read: raw output cap (default ${DEFAULT_READ_MAX_CHARS}).`,
      }),
    ),
  },
  { additionalProperties: false },
);

const TerminalListSessionSchema = Type.Object(
  {
    sessionId: Type.String(),
    agentId: Type.String(),
    shell: Type.String(),
    cwd: Type.String(),
    attached: Type.Boolean(),
    owner: Type.String({ pattern: "^agent:.+" }),
    createdAtMs: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

const TerminalToolOutputSchema = Type.Union([
  Type.Object({ sessions: Type.Array(TerminalListSessionSchema) }, { additionalProperties: false }),
  Type.Object(
    {
      sessionId: Type.String(),
      text: Type.String(),
      startCursor: Type.Integer({ minimum: 0 }),
      cursor: Type.Integer({ minimum: 0 }),
      endCursor: Type.Integer({ minimum: 0 }),
      truncated: Type.Boolean(),
      hasMore: Type.Boolean(),
      running: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  Type.Object({ ok: Type.Literal(true) }, { additionalProperties: false }),
]);

const TERMINAL_RECOVERY_GUIDANCE =
  "Use action=list to find a shared terminal or ask the operator to open one in this chat.";
const TERMINAL_UNAVAILABLE_MESSAGE = `Terminal session unavailable. ${TERMINAL_RECOVERY_GUIDANCE}`;

type TerminalToolGatewayContext = Pick<GatewayRequestContext, "terminalSessions">;

type TerminalToolOptions = {
  agentId?: string;
  agentSessionKey?: string;
  sessionId?: string;
  config?: OpenClawConfig;
  execSession?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides & { mode?: ExecMode };
  runId?: string;
  approvalReviewerDeviceIds?: string[];
  getGatewayContext?: () => TerminalToolGatewayContext | undefined;
};

function terminalActionResult(
  action: "input" | "resize" | "close",
  outcome: TerminalAgentActionOutcome,
): ReturnType<typeof jsonResult> {
  if (!outcome.ok) {
    throw new ToolInputError(
      outcome.code === "session_unavailable"
        ? TERMINAL_UNAVAILABLE_MESSAGE
        : `Terminal ${action} failed. ${TERMINAL_RECOVERY_GUIDANCE}`,
    );
  }
  return jsonResult({ ok: true });
}

function readDimension(params: Record<string, unknown>, key: "cols" | "rows"): number {
  const value = readPositiveIntegerParam(params, key, {
    max: MAX_DIMENSION,
    message: `${key} must be an integer from 1 to ${MAX_DIMENSION}`,
  });
  if (value === undefined) {
    throw new ToolInputError(`${key} required`);
  }
  return value;
}

function cursorSlice(raw: string, start: number, maxChars: number) {
  let safeStart = start;
  const startCodeUnit = raw.charCodeAt(safeStart);
  const priorCodeUnit = raw.charCodeAt(safeStart - 1);
  if (
    safeStart > 0 &&
    startCodeUnit >= 0xdc00 &&
    startCodeUnit <= 0xdfff &&
    priorCodeUnit >= 0xd800 &&
    priorCodeUnit <= 0xdbff
  ) {
    safeStart += 1;
  }
  const end = avoidTrailingHighSurrogateBreak(
    raw,
    safeStart,
    Math.min(raw.length, safeStart + maxChars),
  );
  return { start: safeStart, end, value: raw.slice(safeStart, end) };
}

export function createTerminalTool(opts: TerminalToolOptions = {}): AnyAgentTool {
  return {
    label: "Terminal",
    name: "terminal",
    description:
      "Manage terminals the operator opened from this chat's Control UI panel. list discovers shared terminals; read returns at most 32K raw chars plus a cursor for incremental reads; resize and close manage an existing terminal; input requires one-time operator approval unless the execution policy permits unrestricted access.",
    parameters: TerminalToolSchema,
    outputSchema: TerminalToolOutputSchema,
    execute: async (toolCallId, rawArgs, signal) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      if (!ACTIONS.some((candidate) => candidate === action)) {
        throw new ToolInputError(
          "terminal action unavailable; use list, read, resize, close, or input",
        );
      }
      const agentSessionKey = opts.agentSessionKey?.trim();
      if (!agentSessionKey) {
        throw new ToolInputError("agent session required");
      }
      const agentSessionId = opts.sessionId?.trim();
      if (!agentSessionId) {
        throw new ToolInputError("agent session id required");
      }
      const agentId = opts.agentId?.trim() || resolveAgentIdFromSessionKey(agentSessionKey);
      const owner = { kind: "agent", agentSessionKey, agentSessionId, agentId } as const;
      const callerIdentity = getGatewayToolCallerIdentity();
      const admittedResolver = opts.getGatewayContext
        ? undefined
        : callerIdentity?.gatewayContextResolver;
      const getContext =
        opts.getGatewayContext ?? admittedResolver ?? getInProcessGatewayToolContext;
      const context = getContext();
      const manager = context?.terminalSessions;
      if (!context || !manager) {
        throw new ToolInputError("terminal unavailable");
      }

      if (action === "list") {
        return jsonResult({ sessions: manager.listAgent(owner) });
      }

      const sessionId = readToolStringParam(params, "sessionId", { required: true });
      if (action === "read") {
        const snapshot = manager.snapshotAgentRange(owner, sessionId);
        if (!snapshot) {
          throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
        }
        const requestedCursor = readNonNegativeIntegerParam(params, "cursor");
        if (requestedCursor !== undefined && requestedCursor > snapshot.endCursor) {
          throw new ToolInputError(
            `cursor ${requestedCursor} is beyond terminal end cursor ${snapshot.endCursor}`,
          );
        }
        const maxChars =
          readPositiveIntegerParam(params, "maxChars", {
            max: MAX_READ_CHARS,
            message: `maxChars must be an integer from 1 to ${MAX_READ_CHARS}`,
          }) ?? DEFAULT_READ_MAX_CHARS;
        const requestedStart = requestedCursor ?? snapshot.startCursor;
        const availableStart = Math.max(requestedStart, snapshot.startCursor);
        const relativeStart = availableStart - snapshot.startCursor;
        const initialStart =
          requestedCursor === undefined && snapshot.buffer.length > maxChars
            ? snapshot.buffer.length - maxChars
            : relativeStart;
        const slice = cursorSlice(snapshot.buffer, initialStart, maxChars);
        const startCursor = snapshot.startCursor + slice.start;
        const cursor = snapshot.startCursor + slice.end;
        return jsonResult({
          sessionId,
          text: renderTerminalBufferText(slice.value),
          startCursor,
          cursor,
          endCursor: snapshot.endCursor,
          truncated: requestedStart < snapshot.startCursor || startCursor > requestedStart,
          hasMore: cursor < snapshot.endCursor,
          running: true,
        });
      }
      if (action === "resize") {
        return terminalActionResult(
          "resize",
          manager.resizeAgent(
            owner,
            sessionId,
            readDimension(params, "cols"),
            readDimension(params, "rows"),
          ),
        );
      }
      if (action === "close") {
        return terminalActionResult("close", manager.closeAgent(owner, sessionId));
      }

      const data = readToolStringParam(params, "data", {
        required: true,
        trim: false,
        allowEmpty: true,
      });
      let execSession = opts.execSession;
      if (!execSession) {
        const { loadGatewaySessionEntryReadOnly } =
          await import("../../gateway/session-utils-store.js");
        const entry = loadGatewaySessionEntryReadOnly(agentSessionKey, {
          agentId,
          clone: false,
        }).entry;
        if (!entry || entry.sessionId?.trim() !== agentSessionId) {
          throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
        }
        execSession = entry;
        // A lazy policy read may cross Gateway retirement; the replacement
        // manager cannot inherit authority over this already-captured PTY.
        if (getContext()?.terminalSessions !== manager) {
          throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
        }
      }
      const policy = resolveExecDefaults({
        cfg: opts.config,
        sessionEntry: execSession,
        execOverrides: opts.execOverrides,
        agentId,
        sessionKey: agentSessionKey,
      });
      if (policy.mode === "deny") {
        throw new ToolInputError("Terminal input denied by execution policy");
      }
      const operationalRunInstance = callerIdentity?.operationalRunInstance;
      const delegatedAuthority = operationalRunInstance
        ? getActiveAgentRunDelegatedAuthority(operationalRunInstance)
        : undefined;
      if (
        !operationalRunInstance ||
        !delegatedAuthority ||
        callerIdentity?.receiptAuthority?.() === false
      ) {
        throw new ToolInputError("Terminal input denied: agent run is no longer active");
      }
      if (manager.snapshotAgent(owner, sessionId) === undefined) {
        throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
      }

      if (policy.mode !== "full") {
        const registration = await registerExecApprovalRequestForHostOrThrow({
          approvalId: randomUUID(),
          command: `Terminal input: ${JSON.stringify(data)}`,
          workdir: undefined,
          host: "gateway",
          security: policy.security,
          ask: "always",
          unavailableDecisions: ["allow-always"],
          warningText: "Allow the agent to send this exact input to an existing shared terminal.",
          agentId,
          sessionKey: agentSessionKey,
          sessionId: agentSessionId,
          runId: operationalRunInstance.runId,
          toolCallId,
          ...(opts.approvalReviewerDeviceIds?.length
            ? { approvalReviewerDeviceIds: opts.approvalReviewerDeviceIds }
            : {}),
          requireDeliveryRoute: true,
        });
        const decision = await resolveRegisteredExecApprovalDecision({
          approvalId: registration.id,
          preResolvedDecision: registration.finalDecision,
        });
        if (decision !== "allow-once") {
          throw new ToolInputError("Terminal input denied: operator approval required");
        }
      }
      signal?.throwIfAborted();
      // Every write, including unprompted Full access, is bound to its exact live
      // run and Gateway immediately before synchronous PTY I/O.
      if (
        getActiveAgentRunDelegatedAuthority(operationalRunInstance) !== delegatedAuthority ||
        callerIdentity.receiptAuthority?.() === false
      ) {
        throw new ToolInputError("Terminal input denied: agent run is no longer active");
      }
      if (getContext()?.terminalSessions !== manager) {
        throw new ToolInputError(TERMINAL_UNAVAILABLE_MESSAGE);
      }
      return terminalActionResult("input", manager.writeAgent(owner, sessionId, data));
    },
  };
}
