/**
 * Thin wrapper around `agent-swarm-director` v2.3.2 exports (ADR-01 & Section 2 / 4 / 6.1).
 * Centralizes all core imports in one module and enforces explicit `sessionId`
 * on session-scoped orchestration handlers.
 */

import {
  ASD_VERSION,
  AsdMcpServer,
  approvePendingTask,
  atomicWriteFileSync,
  attachDriver,
  buildDriverBriefing,
  buildInteractiveResumeHarnessCommand as rawBuildInteractiveResumeHarnessCommand,
  buildResumeHarnessCommand as rawBuildResumeHarnessCommand,
  collectDashboardSnapshot,
  computeProjectHash,
  detachDriver,
  discoverHarnessModels,
  ensureProjectInitialized,
  executeHarnessProcess,
  extractHarnessSessionIdFromOutput,
  extractHookSessionInfo,
  finalizeSubagentArtifacts,
  generateAsdSessionId,
  generateDriverId,
  getActiveDriver,
  getAdapter,
  getCommittedWorktreeChanges,
  getForegroundSessionId,
  getLatestSession,
  getWorktreeDiff,
  handleDebate as rawHandleDebate,
  handleDispatch as rawHandleDispatch,
  handlePlan as rawHandlePlan,
  handleVerify as rawHandleVerify,
  isValidAsdSessionId,
  killProcessTree,
  linkHarnessSessionToAsdSession,
  listDrivers,
  listKnownProjects,
  loadRoutingConfig,
  locateHarnessTranscript,
  openProjectDb,
  parsePlanMd,
  readCliRecentSessions,
  readHarnessTranscript,
  recordCliRecentSession,
  recoverOrphanedTasks,
  redactSecrets,
  rejectPendingTask,
  renderPlanMd,
  renderProgressBoard,
  renderSessionSummaryMd,
  resolveAsdPaths,
  resolveRoute,
  resolveSpawnCommand,
  rollbackLightChanges,
  runAsdClean,
  runAsdDoctor,
  runAsdLogs,
  runDriverTurn,
  runGit,
  runSubagentControlAction,
  saveProjectRoutingConfig,
  saveSessionMemo,
  scanSubagentLogs,
  setDriverHarnessSessionId,
  setForegroundSession,
  spawnSubagent,
  syncLocalHarnessTranscripts,
  syncPlanFromMd,
  syncSessionDriversToMainJson,
  withMergeLock,
  type AgentRole,
  type AsdDebateInput,
  type AsdDebateOutput,
  type AsdDispatchInput,
  type AsdDispatchOutput,
  type AsdPlanInput,
  type AsdPlanOutput,
  type AsdVerifyInput,
  type AsdVerifyOutput,
  type CommandRunner,
  type DashboardSnapshot,
  type DifficultyTier,
  type DriverDetachReason,
  type DriverRow,
  type DriverRunResult,
  type DriverSource,
  type HarnessId,
  type HarnessModelCatalog,
  type HarnessTranscript,
  type KnownProjectSummary,
  type MainSessionMeta,
  type RoutingConfig,
  type SessionPhase,
  type SessionRow,
  type SqliteDriver,
  type SubagentLogRecord,
  type TaskRow,
  type TaskStatus,
  type TaskTrack,
  type TranscriptLocation,
  type TranscriptMessage,
  type WorktreeDiffSnapshot,
} from "agent-swarm-director";

export {
  ASD_VERSION,
  AsdMcpServer,
  approvePendingTask,
  atomicWriteFileSync,
  attachDriver,
  buildDriverBriefing,
  collectDashboardSnapshot,
  computeProjectHash,
  detachDriver,
  discoverHarnessModels,
  ensureProjectInitialized,
  executeHarnessProcess,
  extractHarnessSessionIdFromOutput,
  extractHookSessionInfo,
  finalizeSubagentArtifacts,
  generateAsdSessionId,
  generateDriverId,
  getActiveDriver,
  getAdapter,
  getCommittedWorktreeChanges,
  getForegroundSessionId,
  getLatestSession,
  getWorktreeDiff,
  isValidAsdSessionId,
  killProcessTree,
  linkHarnessSessionToAsdSession,
  listDrivers,
  listKnownProjects,
  loadRoutingConfig,
  locateHarnessTranscript,
  openProjectDb,
  parsePlanMd,
  readCliRecentSessions,
  readHarnessTranscript,
  recordCliRecentSession,
  recoverOrphanedTasks,
  redactSecrets,
  rejectPendingTask,
  renderPlanMd,
  renderProgressBoard,
  renderSessionSummaryMd,
  resolveAsdPaths,
  resolveRoute,
  resolveSpawnCommand,
  rollbackLightChanges,
  runAsdClean,
  runAsdDoctor,
  runAsdLogs,
  runDriverTurn,
  runGit,
  runSubagentControlAction,
  saveProjectRoutingConfig,
  saveSessionMemo,
  scanSubagentLogs,
  setDriverHarnessSessionId,
  setForegroundSession,
  spawnSubagent,
  syncLocalHarnessTranscripts,
  syncPlanFromMd,
  syncSessionDriversToMainJson,
  withMergeLock,
  type AgentRole,
  type AsdDebateInput,
  type AsdDebateOutput,
  type AsdDispatchInput,
  type AsdDispatchOutput,
  type AsdPlanInput,
  type AsdPlanOutput,
  type AsdVerifyInput,
  type AsdVerifyOutput,
  type CommandRunner,
  type DashboardSnapshot,
  type DifficultyTier,
  type DriverDetachReason,
  type DriverRow,
  type DriverRunResult,
  type DriverSource,
  type HarnessId,
  type HarnessModelCatalog,
  type HarnessTranscript,
  type KnownProjectSummary,
  type MainSessionMeta,
  type RoutingConfig,
  type SessionPhase,
  type SessionRow,
  type SqliteDriver,
  type SubagentLogRecord,
  type TaskRow,
  type TaskStatus,
  type TaskTrack,
  type TranscriptLocation,
  type TranscriptMessage,
  type WorktreeDiffSnapshot,
};

/**
 * Antigravity CLI (`agy`) uses `--conversation <id>` (not `--resume <id>`) to resume
 * an existing conversation. Normalize any `--resume` flag on `agy` commands.
 */
export function buildInteractiveResumeHarnessCommand(
  harnessOrOptions:
    | HarnessId
    | {
        harness: HarnessId;
        harnessSessionId?: string | null;
        model?: string | null;
      },
  harnessSessionId?: string | null,
  model?: string | null
): { command: string; args: string[]; cliString: string } {
  const built = rawBuildInteractiveResumeHarnessCommand(
    harnessOrOptions as never,
    harnessSessionId,
    model
  );
  if (built.command === "agy") {
    const args = built.args.map((a) => (a === "--resume" ? "--conversation" : a));
    return {
      command: built.command,
      args,
      cliString: [built.command, ...args].join(" "),
    };
  }
  return built;
}

export function buildResumeHarnessCommand(
  harnessOrOptions:
    | HarnessId
    | {
        harness: HarnessId;
        harnessSessionId: string;
        prompt?: string;
        model?: string | null;
        thinkingEffort?: string | null;
      },
  harnessSessionId?: string,
  prompt?: string,
  model?: string | null,
  thinkingEffort?: string | null
): { command: string; args: string[] } {
  const built = rawBuildResumeHarnessCommand(
    harnessOrOptions as never,
    harnessSessionId as string,
    prompt,
    model,
    thinkingEffort
  );
  if (built.command === "agy") {
    return {
      command: built.command,
      args: built.args.map((a) => (a === "--resume" ? "--conversation" : a)),
    };
  }
  return built;
}

function requireExplicitSessionId(sessionId: string | undefined, fnName: string): string {
  const trimmed = sessionId?.trim() ?? "";
  if (!trimmed || !isValidAsdSessionId(trimmed)) {
    throw new Error(`${fnName} requires an explicit valid sessionId (GUI_ARCHITECTURE.md 6.1)`);
  }
  return trimmed;
}

/**
 * Invokes `handlePlan` with mandatory explicit `sessionId` (Section 6.1).
 */
export async function handlePlan(
  input: AsdPlanInput & { sessionId: string },
  ctx: { projectRoot: string; homeDir?: string; db?: SqliteDriver }
): Promise<AsdPlanOutput> {
  const sessionId = requireExplicitSessionId(input.sessionId, "handlePlan");
  return await rawHandlePlan({ ...input, sessionId }, ctx);
}

/**
 * Invokes `handleDispatch` with mandatory explicit `sessionId` (Section 6.1).
 */
export async function handleDispatch(
  input: AsdDispatchInput,
  ctx: {
    projectRoot: string;
    homeDir?: string;
    db?: SqliteDriver;
    signal?: AbortSignal;
    commandRunner?: CommandRunner;
  }
): Promise<AsdDispatchOutput> {
  const sessionId = requireExplicitSessionId(input.sessionId, "handleDispatch");
  return await rawHandleDispatch({ ...input, sessionId }, ctx);
}

/**
 * Invokes `handleVerify` with mandatory explicit `sessionId` (Section 6.1).
 */
export async function handleVerify(
  input: AsdVerifyInput,
  ctx: {
    projectRoot: string;
    homeDir?: string;
    db?: SqliteDriver;
    commandRunner?: CommandRunner;
  }
): Promise<AsdVerifyOutput> {
  const sessionId = requireExplicitSessionId(input.sessionId, "handleVerify");
  return await rawHandleVerify({ ...input, sessionId }, ctx);
}

/**
 * Invokes `handleDebate` with mandatory explicit `sessionId` (Section 6.1).
 */
export async function handleDebate(
  input: AsdDebateInput,
  ctx: {
    projectRoot: string;
    homeDir?: string;
    db?: SqliteDriver;
    signal?: AbortSignal;
    onProgress?: (msg: string) => void;
    commandRunner?: CommandRunner;
  }
): Promise<AsdDebateOutput> {
  const sessionId = requireExplicitSessionId(input.sessionId, "handleDebate");
  return await rawHandleDebate({ ...input, sessionId }, ctx);
}
