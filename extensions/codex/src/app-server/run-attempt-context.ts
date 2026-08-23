import {
  bootstrapHarnessContextEngine,
  buildHarnessContextEngineRuntimeContext,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  getAgentHarnessHookRunner,
  isHostScopedAgentToolActive,
  resolveContextEngineOwnerPluginId,
  runHarnessContextEngineMaintenance,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  buildCodexOpenClawPromptContext,
  buildCodexWatchedSessionsContext,
  buildCodexWorkspaceBootstrapContext,
  getCodexWorkspaceMemoryToolNames,
  readMirroredSessionHistoryMessages,
  renderCodexSkillsCollaborationInstructions,
} from "./attempt-context.js";
import {
  resolveCodexContinuityProjectionMaxChars,
  type CodexProjectedContextRange,
} from "./context-engine-projection.js";
import { isSystemAgentOnlyCodexDynamicToolAllowlist } from "./dynamic-tool-profile.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { joinPresentSections } from "./run-attempt-state.js";
import type { CodexAttemptTools } from "./run-attempt-tool-setup.js";
import {
  buildDeveloperInstructions,
  resolveCodexContextEngineProjectionMaxCharsForAttempt,
  type CodexContextEngineThreadBootstrapProjection,
} from "./thread-lifecycle.js";

const CODEX_BOOTSTRAP_FILE_TOOL_NAMES = new Set([
  "apply_patch",
  "edit",
  "exec",
  "exec_command",
  "read",
  "write",
]);

export async function prepareCodexAttemptContext(
  runtime: CodexAttemptRuntime,
  attemptTools: CodexAttemptTools,
) {
  const {
    connection,
    runtimeParams,
    activeSessionId,
    activeSessionFile,
    buildActiveRunAttemptParams,
    effectiveContextWindowInfo,
    effectiveContextTokenBudget,
    effectiveRuntimeProviderId,
    effectiveRuntimeModelId,
    hookChannelId,
  } = runtime;
  const {
    params,
    sessionAgentId,
    contextSessionKey,
    activeContextEngine,
    initialStartupBindingHadInactiveThreadBootstrap,
    sandboxSessionKey,
    effectiveWorkspace,
    effectiveCwd,
    agentDir,
    usesSupervisionConnection,
    resolvedWorkspace,
    initialInactiveThreadBootstrapBindingForcedFreshStart,
    sandbox,
  } = connection;
  const { toolBridge } = attemptTools;
  const activeTranscriptTarget = {
    agentId: sessionAgentId,
    sessionFile: activeSessionFile,
    sessionId: activeSessionId,
    sessionKey: contextSessionKey,
    sessionTarget: params.sessionTarget,
  };
  // This exact admitted row fences every history read used to build turn/start.
  // Keep it immutable for the attempt even if later steering rewrites the transcript.
  const transcriptReadFence = params.userTurnTranscriptRecorder?.getAdmissionReceipt();
  const readFencedHistory = async () => {
    return await readMirroredSessionHistoryMessages({
      ...activeTranscriptTarget,
      ...(transcriptReadFence ? { admission: transcriptReadFence } : {}),
    });
  };
  // Exact resumes normally need only the indexed admission delta. Keep the
  // transcript-start scan cached and lazy for the conservative paths that do.
  let historyReadPromise: Promise<AgentMessage[]> | undefined;
  const historyState: {
    messages: AgentMessage[];
    loaded: boolean;
    ensureLoaded: () => Promise<AgentMessage[]>;
    reload: () => Promise<AgentMessage[]>;
  } = {
    messages: [],
    loaded: false,
    ensureLoaded: async () => historyState.messages,
    reload: async () => historyState.messages,
  };
  const loadFencedHistory = async (force: boolean): Promise<AgentMessage[]> => {
    if (!activeContextEngine && initialStartupBindingHadInactiveThreadBootstrap) {
      historyState.loaded = true;
      return historyState.messages;
    }
    if (!force && historyState.loaded) {
      return historyState.messages;
    }
    if (!force && historyReadPromise) {
      return await historyReadPromise;
    }
    const readPromise = readFencedHistory()
      .then((messages) => {
        if (messages) {
          historyState.messages = messages;
        }
        historyState.loaded = true;
        return historyState.messages;
      })
      .finally(() => {
        if (historyReadPromise === readPromise) {
          historyReadPromise = undefined;
        }
      });
    historyReadPromise = readPromise;
    return await readPromise;
  };
  historyState.ensureLoaded = async () => await loadFencedHistory(false);
  historyState.reload = async () => await loadFencedHistory(true);
  const hookContextWindowFields = {
    ...(effectiveContextWindowInfo?.tokens
      ? { contextTokenBudget: effectiveContextWindowInfo.tokens }
      : effectiveContextTokenBudget
        ? { contextTokenBudget: effectiveContextTokenBudget }
        : {}),
    ...(effectiveContextWindowInfo?.source
      ? { contextWindowSource: effectiveContextWindowInfo.source }
      : {}),
    ...(effectiveContextWindowInfo?.referenceTokens
      ? { contextWindowReferenceTokens: effectiveContextWindowInfo.referenceTokens }
      : {}),
  };
  const hookContext = {
    runId: params.runId,
    agentId: sessionAgentId,
    sessionKey: sandboxSessionKey,
    sessionId: params.sessionId,
    workspaceDir: params.workspaceDir,
    messageProvider: params.messageProvider ?? undefined,
    trigger: params.trigger,
    channelId: hookChannelId,
    ...hookContextWindowFields,
  };
  const hookRunner = getAgentHarnessHookRunner();
  const buildActiveContextEngineRuntimeContext = () =>
    buildHarnessContextEngineRuntimeContext({
      attempt: buildActiveRunAttemptParams(),
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd,
      agentDir,
      activeAgentId: sessionAgentId,
      contextEnginePluginId: resolveContextEngineOwnerPluginId(activeContextEngine),
      tokenBudget: effectiveContextTokenBudget,
    });
  if (activeContextEngine) {
    await historyState.ensureLoaded();
    await bootstrapHarnessContextEngine({
      hadSessionFile: historyState.messages.length > 0,
      contextEngine: activeContextEngine,
      sessionId: activeSessionId,
      sessionKey: contextSessionKey,
      sessionFile: activeSessionFile,
      sessionTarget: params.sessionTarget,
      runtimeContext: buildActiveContextEngineRuntimeContext(),
      transcriptReadFence,
      contextEngineHostSupport: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
      providerId: effectiveRuntimeProviderId,
      requestedModelId: usesSupervisionConnection ? undefined : params.requestedModelId,
      modelId: effectiveRuntimeModelId,
      fallbackReason: usesSupervisionConnection ? undefined : params.fallbackReason,
      degradedReason: usesSupervisionConnection ? undefined : params.degradedReason,
      runMaintenance: runHarnessContextEngineMaintenance,
      config: params.config,
      warn: (message) => embeddedAgentLog.warn(message),
    });
    await historyState.reload();
  }
  const memoryToolNames = getCodexWorkspaceMemoryToolNames(toolBridge.availableSpecs);
  const hasBootstrapFileAccess =
    runtime.nativeToolSurfaceEnabled ||
    flattenCodexDynamicToolFunctions(toolBridge.availableSpecs).some((tool) =>
      CODEX_BOOTSTRAP_FILE_TOOL_NAMES.has(tool.name.trim().toLowerCase()),
    );
  const workspaceBootstrapContext = await buildCodexWorkspaceBootstrapContext({
    params: runtimeParams,
    resolvedWorkspace: runtimeParams.bootstrapWorkspaceDir ?? resolvedWorkspace,
    executionWorkspace: resolvedWorkspace,
    effectiveWorkspace,
    sessionKey: contextSessionKey,
    sessionAgentId,
    memoryToolNames,
    ringZeroActive:
      isHostScopedAgentToolActive("openclaw") &&
      isSystemAgentOnlyCodexDynamicToolAllowlist(runtimeParams.toolsAllow),
    hasBootstrapFileAccess,
    sandboxed: sandbox?.enabled === true,
  });
  // A thread keeps the bounded agent-workspace snapshot captured at creation.
  // Workspace edits take effect only in the next session.
  const agentWorkspaceDeveloperInstructions = workspaceBootstrapContext.threadDeveloperInstructions
    ? (connection.mutable.startupBinding?.agentWorkspaceDeveloperInstructions ??
      workspaceBootstrapContext.threadDeveloperInstructions)
    : undefined;
  const baseDeveloperInstructions = joinPresentSections(
    buildDeveloperInstructions(runtimeParams, {
      dynamicTools: toolBridge.availableSpecs,
    }),
    agentWorkspaceDeveloperInstructions,
  );
  const openClawPromptContext = buildCodexOpenClawPromptContext({
    params: runtimeParams,
    workspacePromptContext: workspaceBootstrapContext.promptContext,
    watchedSessionsContext: buildCodexWatchedSessionsContext({
      attempt: runtimeParams,
      dynamicTools: toolBridge.availableSpecs,
      sessionKey: contextSessionKey,
      sandboxed: sandbox?.enabled === true,
    }),
  });
  const skillsCollaborationInstructions = renderCodexSkillsCollaborationInstructions({
    attempt: runtimeParams,
    skillsPrompt: params.skillsSnapshot?.prompt,
    dynamicTools: toolBridge.availableSpecs,
  });
  const promptState = {
    promptText: params.prompt,
    promptContextRange: undefined as CodexProjectedContextRange | undefined,
    developerInstructions: baseDeveloperInstructions,
    prePromptMessageCount: 0,
    contextEngineProjection: undefined as CodexContextEngineThreadBootstrapProjection | undefined,
    precomputedStaleBindingContinuityProjectionResolved: false,
    precomputedStaleBindingContinuityProjectionApplied: false,
    // SAFETY: This mutable slot starts absent and later receives only a thread id string.
    precomputedStaleBindingContinuityProjectionThreadId: undefined as string | undefined,
    staleBindingContinuityForcedFreshStart: false,
    // Set by the no-engine continuity appliers; gates calibration recording so a
    // dense direct or active-engine prompt can never persist a density sample
    // that later shrinks continuity history it did not measure.
    noEngineContinuityProjectionApplied: false,
    inactiveThreadBootstrapBindingForcedFreshStart:
      initialInactiveThreadBootstrapBindingForcedFreshStart,
  };
  const codexContextProjectionMaxChars = resolveCodexContextEngineProjectionMaxCharsForAttempt(
    runtimeParams,
    sessionAgentId,
  );
  const codexContinuityProjectionMaxChars = Math.min(
    resolveCodexContinuityProjectionMaxChars({
      contextTokenBudget: effectiveContextTokenBudget,
      calibration: connection.mutable.continuityCalibration,
    }),
    codexContextProjectionMaxChars,
  );
  return {
    runtime,
    attemptTools,
    activeTranscriptTarget,
    transcriptReadFence,
    historyState,
    hookContext,
    hookContextWindowFields,
    hookRunner,
    buildActiveContextEngineRuntimeContext,
    workspaceBootstrapContext,
    agentWorkspaceDeveloperInstructions,
    baseDeveloperInstructions,
    openClawPromptContext,
    skillsCollaborationInstructions,
    promptState,
    codexContextProjectionMaxChars,
    codexContinuityProjectionMaxChars,
  };
}

export type CodexAttemptContext = Awaited<ReturnType<typeof prepareCodexAttemptContext>>;
