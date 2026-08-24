type YieldCompletionClaim = () => boolean | Promise<boolean>;

export function createRequesterYieldCallback(params: {
  requesterSessionKey?: string;
  requesterAgentId: string;
  requesterTurnRunId?: string;
  claimYieldCompletion?: YieldCompletionClaim;
}): YieldCompletionClaim | undefined {
  // A subagent session key identifies who is waiting for this turn; it does not
  // prove this turn has a child completion that can wake it. Only the runtime or
  // durable child registry may authorize a yield.
  const hasRegistryClaim = Boolean(params.requesterSessionKey && params.requesterTurnRunId);
  if (!params.claimYieldCompletion && !hasRegistryClaim) {
    return undefined;
  }
  return async () => {
    // Runtime claims are observational. Check them before durable registry state
    // so a runtime failure cannot record a yield that never reaches onYield.
    const runtimeClaimed = (await params.claimYieldCompletion?.()) ?? false;
    if (!hasRegistryClaim) {
      return runtimeClaimed;
    }
    const { markRequesterTurnYielded } = await import("./subagents/registry/subagent-registry.js");
    const registryClaimed =
      markRequesterTurnYielded({
        requesterSessionKey: params.requesterSessionKey as string,
        requesterAgentId: params.requesterAgentId,
        requesterTurnRunId: params.requesterTurnRunId as string,
      }) > 0;
    return runtimeClaimed || registryClaimed;
  };
}
