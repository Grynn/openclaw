import type { SessionBranch } from "../../api/types.ts";
import { scopedAgentParamsForSession, visibleSessionMatches } from "../../lib/sessions/index.ts";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import type { ChatState } from "./chat-state-contract.ts";

export function retireChatBranchRequests(state: ChatState): void {
  chatHistoryRequests(state).branchVersion += 1;
}

/** Branches for the current pane; equivalence covers alias-canonicalization windows (#124020 class). */
export function displayedChatSessionBranches(
  state: Pick<ChatState, "chatBranches" | "chatBranchesSessionKey" | "sessionKey">,
): SessionBranch[] {
  return areUiSessionKeysEquivalent(state.chatBranchesSessionKey, state.sessionKey)
    ? (state.chatBranches ?? [])
    : [];
}

export async function loadChatBranches(state: ChatState): Promise<void> {
  const sessions = state.sessions;
  const client = state.client;
  const sessionKey = state.sessionKey;
  if (!sessions?.listBranches || !client || !state.connected) {
    return;
  }
  const listBranches = sessions.listBranches;
  const requests = chatHistoryRequests(state);
  const connectionEpoch = state.connectionEpoch;
  const agentParams = scopedAgentParamsForSession(state, sessionKey);
  const requestKey = `${connectionEpoch}\u0000${sessionKey}\u0000${agentParams.agentId ?? ""}`;
  const inFlight = requests.inFlightBranches;
  if (
    inFlight?.key === requestKey &&
    inFlight.client === client &&
    inFlight.connectionEpoch === connectionEpoch
  ) {
    return inFlight.promise;
  }
  const version = ++requests.branchVersion;
  state.chatBranchesLoading = true;
  const promise = (async () => {
    try {
      const branches = await listBranches(sessionKey, agentParams);
      if (
        requests.branchVersion !== version ||
        state.client !== client ||
        !state.connected ||
        state.connectionEpoch !== connectionEpoch ||
        !visibleSessionMatches(state, sessionKey, agentParams.agentId)
      ) {
        return;
      }
      state.chatBranches = branches;
      state.chatBranchesSessionKey = sessionKey;
      state.chatBranchesConnectionEpoch = connectionEpoch;
    } catch {
      // Leave chatBranchesSessionKey unset so the next history load retries;
      // recording success here latches transient failures into a hidden dropdown.
    } finally {
      if (requests.branchVersion === version) {
        state.chatBranchesLoading = false;
        state.requestUpdate?.();
      }
    }
  })().finally(() => {
    if (requests.inFlightBranches?.promise === promise) {
      requests.inFlightBranches = undefined;
    }
  });
  requests.inFlightBranches = {
    client,
    connectionEpoch,
    key: requestKey,
    promise,
  };
  return promise;
}
