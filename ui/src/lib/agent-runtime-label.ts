// Browser-safe agent-runtime labels shared by catalog and credential views.
const AGENT_RUNTIME_LABELS: Readonly<Record<string, string>> = {
  "claude-cli": "Claude CLI",
  codex: "Codex",
  "codex-cli": "Codex",
  "google-gemini-cli": "Gemini CLI",
  openclaw: "OpenClaw",
};

export function formatAgentRuntimeLabel(id: string): string {
  const normalized = id.trim().toLowerCase();
  return (
    AGENT_RUNTIME_LABELS[normalized] ??
    `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`
  );
}
