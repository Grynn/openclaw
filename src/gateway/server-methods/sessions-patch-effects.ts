import type {
  ErrorShape,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMetaForEntries } from "../../acp/runtime/session-meta-readonly.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionEntryCommitContext } from "../../config/sessions/session-accessor.types.js";
import type { SessionAcpMeta } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { disableCronJobsBoundToSessions } from "../../cron/job-session-bindings.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { triggerSessionPatchHook } from "../session-patch-hooks.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { registerCommittedSessionCategory } from "./session-create-category.js";
import {
  needsSessionPatchAcpModelSelectionMetadata,
  persistSessionPatchModelSelection,
} from "./sessions-patch-model-selection.js";
import type {
  GroupAdmissionResult,
  MutationOutcome,
  PreparedPatchTarget,
} from "./sessions-patch-types.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

type CommittedSessionPatchEffect = {
  accessChanged: boolean;
  entry: SessionEntry;
  target: PreparedPatchTarget;
  acpMeta?: SessionAcpMeta | null;
  stickyUnavailable?: true;
  stickyGuard?: () => ErrorShape | undefined;
};

function validateStickyEffect(effect: CommittedSessionPatchEffect): boolean {
  if (effect.stickyUnavailable) {
    return false;
  }
  const error = effect.stickyGuard?.();
  if (error) {
    effect.stickyUnavailable = true;
    sessionLog.warn(
      `sessions.patch: skipped stale sticky model selection for ${effect.target.canonicalKey}: ${error.message}`,
    );
    return false;
  }
  return true;
}

/** Prepare ACP classification inside the retained mutation lane; publication stays ordered. */
export async function prepareSessionPatchEffects(params: {
  cfg: OpenClawConfig;
  callerScopes: readonly string[];
  prepared: readonly PreparedPatchTarget[];
  outcomes: readonly (MutationOutcome | undefined)[];
  prepareCommittedGuard: (
    index: number,
    entry: SessionEntry,
  ) => Promise<() => ErrorShape | undefined>;
}): Promise<CommittedSessionPatchEffect[]> {
  const effects: CommittedSessionPatchEffect[] = params.prepared.flatMap((target) => {
    const outcome = params.outcomes[target.index];
    return outcome?.ok && outcome.applied
      ? [{ target, entry: outcome.entry, accessChanged: outcome.accessChanged }]
      : [];
  });
  const linked = effects.filter(({ target, entry }) =>
    needsSessionPatchAcpModelSelectionMetadata({
      cfg: params.cfg,
      callerScopes: params.callerScopes,
      entry,
      patch: target.fullPatch,
      sessionKey: target.canonicalKey,
      targetAgentId: target.targetAgentId,
    }),
  );
  if (linked.length === 0) {
    return effects;
  }
  // Every target shares this yield, including newly created operator roots.
  // Bind each guard to its successful committed lifecycle before yielding.
  await Promise.all(
    effects.map(async (effect) => {
      effect.stickyGuard = await params.prepareCommittedGuard(effect.target.index, effect.entry);
    }),
  );
  for (const effect of effects) {
    validateStickyEffect(effect);
  }
  const metadataTargets = linked.filter((effect) => !effect.stickyUnavailable);
  if (metadataTargets.length === 0) {
    return effects;
  }
  try {
    const metadata = await readAcpSessionMetaForEntries(
      {
        cfg: params.cfg,
        entries: metadataTargets.map(({ target, entry }) => ({
          agentId: target.targetAgentId,
          sessionKey: target.canonicalKey,
          entry,
        })),
      },
      { current: true },
    );
    for (const [index, effect] of metadataTargets.entries()) {
      effect.acpMeta = metadata[index] ?? null;
    }
  } catch (error) {
    // The session writes already committed. Deny only unverified sticky writes;
    // their hooks, catalog invalidations and archive effects must still publish.
    for (const effect of metadataTargets) {
      effect.stickyUnavailable = true;
    }
    sessionLog.warn(
      `sessions.patch: skipped sticky model selection after ACP metadata read failed: ${formatErrorMessage(error)}`,
    );
  }
  for (const effect of effects) {
    validateStickyEffect(effect);
  }
  return effects;
}

/** Publish committed patch effects even when active-runtime application later reports an error. */
export async function publishSessionPatchEffects(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  callerScopes: readonly string[];
  callerCanManageCron: boolean;
  targets: CommittedSessionPatchEffect[];
}): Promise<void> {
  const archivedSessionKeys = new Set<string>();
  for (const effect of params.targets) {
    const { target, entry, accessChanged } = effect;
    triggerSessionPatchHook({
      cfg: params.cfg,
      sessionEntry: entry,
      sessionKey: target.canonicalKey,
      patch: target.fullPatch,
    });
    if (validateStickyEffect(effect)) {
      persistSessionPatchModelSelection({
        cfg: params.cfg,
        callerScopes: params.callerScopes,
        entry,
        patch: target.fullPatch,
        sessionKey: target.canonicalKey,
        targetAgentId: target.targetAgentId,
        acpMeta: effect.acpMeta,
      });
    }
    emitSessionsChanged(
      params.context,
      {
        sessionKey: target.canonicalKey,
        ...(target.requestedAgentId ? { agentId: target.requestedAgentId } : {}),
        reason: "patch",
        ...(target.fullPatch.model !== undefined || target.fullPatch.agentRuntime !== undefined
          ? { catalogChanged: true }
          : {}),
      },
      { accessChanged },
    );
    if (typeof target.fullPatch.archived === "boolean") {
      params.context.sessionActivitySummaries?.handleLifecycle({
        sessionKey: target.canonicalKey,
        agentId: target.targetAgentId,
        reason: target.fullPatch.archived ? "archive" : "unarchive",
      });
    }
    if (target.fullPatch.archived === true) {
      archivedSessionKeys.add(target.canonicalKey);
    }
  }

  if (params.callerCanManageCron && archivedSessionKeys.size > 0) {
    try {
      const disabledBySession = await disableCronJobsBoundToSessions({
        cron: params.context.cron,
        cfg: params.cfg,
        sessionKeys: [...archivedSessionKeys],
      });
      for (const [sessionKey, disabledJobIds] of disabledBySession) {
        if (disabledJobIds.length > 0) {
          sessionLog.info(
            `sessions.patch: disabled cron jobs bound to archived session ${sessionKey}: ${disabledJobIds.join(", ")}`,
          );
        }
      }
    } catch (error) {
      sessionLog.warn(
        `sessions.patch: failed to disable cron jobs for archived sessions: ${formatErrorMessage(error)}`,
      );
    }
  }
}

/** Report runtime application failures only after every committed effect publishes. */
export function finalizeSessionPatchOutcomes(
  outcomes: Array<MutationOutcome | undefined>,
  permissionErrors: ReadonlyMap<number, ErrorShape>,
): MutationOutcome[] {
  for (const [index, error] of permissionErrors) {
    outcomes[index] = { ok: false, error };
  }
  return outcomes as MutationOutcome[];
}

/** Only applied assignments may repair the catalog; detached and status-model no-ops cannot. */
export function createSessionPatchCategoryRegistration(params: {
  patch: { category?: SessionsPatchParams["category"] };
  context: GatewayRequestContext;
}) {
  const category = params.patch.category;
  return async (result: GroupAdmissionResult, source: SessionEntryCommitContext): Promise<void> => {
    if (
      typeof category === "string" &&
      result.kind === "complete" &&
      result.outcomes.some(
        (outcome) => outcome.ok && outcome.applied && outcome.entry.category === category.trim(),
      )
    ) {
      await registerCommittedSessionCategory(category, params.context, source);
    }
  };
}
