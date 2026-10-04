export const WORKSPACE_FIELD_LABELS: Record<string, string> = {
  worktreeRoot: "Worktree Root",
  worktreeAcceleration: "Worktree Acceleration",
  worktreeMaxCount: "Maximum Managed Worktrees",
  "agents.defaults.workspace": "Workspace",
  "agents.defaults.cwd": "Working Directory",
  "agents.defaults.repoRoot": "Repo Root",
  "agents.defaults.skipBootstrap": "Skip Workspace Bootstrap Creation",
  "agents.defaults.skipOptionalBootstrapFiles": "Skipped Optional Bootstrap Files",
  "agents.defaults.contextInjection": "Context Injection",
  "agents.defaults.bootstrapMaxChars": "Bootstrap Max Chars",
  "agents.defaults.bootstrapTotalMaxChars": "Bootstrap Total Max Chars",
};

export const DEFAULT_AGENT_CONTEXT_FIELD_LABELS: Record<string, string> = {
  "agents.defaults.contextLimits": "Default Context Limits",
  "agents.defaults.contextLimits.contextProjectionMaxChars": "Default Context Projection Max Chars",
  "agents.defaults.heartbeat.skills": "Heartbeat Skills",
  "agents.defaults.heartbeat.tools": "Heartbeat Tools",
  "agents.defaults.contextLimits.memoryGetMaxChars": "Default memory_get Max Chars",
  "agents.defaults.contextLimits.postCompactionMaxChars": "Default Post-compaction Max Chars",
};

export const AGENT_CONTEXT_FIELD_LABELS: Record<string, string> = {
  "agents.entries.*.contextLimits": "Agent Context Limits",
  "agents.entries.*.contextLimits.contextProjectionMaxChars": "Agent Context Projection Max Chars",
  "agents.entries.*.heartbeat.skills": "Heartbeat Skills",
  "agents.entries.*.heartbeat.tools": "Heartbeat Tools",
  "agents.entries.*.contextLimits.memoryGetMaxChars": "Agent memory_get Max Chars",
  "agents.entries.*.contextLimits.postCompactionMaxChars": "Agent Post-compaction Max Chars",
};
