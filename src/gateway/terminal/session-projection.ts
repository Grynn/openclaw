import type { TerminalSession } from "./session-manager.types.js";
import type { TerminalAttachSummary, TerminalSessionSummary } from "./session-types.js";

export type TerminalSnapshotRange = {
  buffer: string;
  startCursor: number;
  endCursor: number;
};

export function terminalAttachSummary(session: TerminalSession): TerminalAttachSummary {
  const {
    attached: _attached,
    createdAtMs: _createdAtMs,
    ...summary
  } = terminalSessionSummary(session);
  return {
    ...summary,
    buffer: session.buffer.snapshot(),
    seq: session.output.endOffset,
  };
}

/** Raw scrollback plus its stable cumulative UTF-16 cursor range. */
export function terminalSnapshotRange(session: TerminalSession): TerminalSnapshotRange {
  const buffer = session.buffer.snapshot();
  const endCursor = session.output.endOffset;
  return { buffer, startCursor: endCursor - buffer.length, endCursor };
}

export function terminalSessionSummary(session: TerminalSession): TerminalSessionSummary {
  const owner: TerminalSessionSummary["owner"] =
    session.owner?.kind === "agent" ? `agent:${session.owner.agentSessionKey}` : "conn";
  return {
    sessionId: session.id,
    agentId: session.agentId,
    shell: session.shell,
    ...(session.title ? { title: session.title } : {}),
    cwd: session.cwd,
    attached:
      session.owner?.kind === "conn" ||
      (session.owner?.kind === "agent" && session.viewers.size > 0),
    owner,
    createdAtMs: session.createdAtMs,
  };
}

export function terminalSessionRecipientIds(session: TerminalSession): string[] {
  const connIds = [...session.viewers];
  if (session.owner?.kind === "conn" && !session.viewers.has(session.owner.connId)) {
    connIds.push(session.owner.connId);
  }
  return connIds;
}
