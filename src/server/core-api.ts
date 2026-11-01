/**
 * Thin wrapper around `agent-swarm-director` exports (ADR-01 & Section 2 / 6.1).
 * Centralizes all core imports in one module and enforces explicit `sessionId`
 * on session-scoped orchestration handlers.
 */

import {
  ASD_VERSION,
  AsdMcpServer,
  approvePendingTask,
  atomicWriteFileSync,
  buildInteractiveResumeHarnessCommand,
  buildResumeHarnessCommand,
  collectDashboardSnapshot,
  computeProjectHash,
  discoverHarnessModels,
  ensureProjectInitialized,
  extractHarnessSessionIdFromOutput,
  extractHookSessionInfo,
  getAdapter,
  getLatestSession,
  getWorktreeDiff,
  handleDebate as rawHandleDebate,
  handleDispatch as rawHandleDispatch,
  handlePlan as rawHandlePlan,
  handleVerify as rawHandleVerify,
  killProcessTree,
  linkHarnessSessionToAsdSession,
  listKnownProjects,
  loadRoutingConfig,
  openProjectDb,
  parsePlanMd,
  readCliRecentSessions,
  recordCliRecentSession,
  redactSecrets,
  rejectPendingTask,
  renderPlanMd,
  renderProgressBoard,
  renderSessionSummaryMd,
  resolveAsdPaths,
  resolveRoute,
  resolveSpawnCommand,
  runAsdClean,
  runAsdDoctor,
  runAsdLogs,
  runSubagentControlAction,
  saveProjectRoutingConfig,
  saveSessionMemo,
  scanSubagentLogs,
  spawnSubagent,
  syncLocalHarnessTranscripts,
  syncPlanFromMd,
  withMergeLock,
  type AsdDebateInput,
  type AsdDebateOutput,
  type AsdDispatchInput,
  type AsdDispatchOutput,
  type AsdPlanInput,
  type AsdPlanOutput,
  type AsdVerifyInput,
  type AsdVerifyOutput,
  type DashboardSnapshot,
  type HarnessId,
  type HarnessModelCatalog,
  type KnownProjectSummary,
  type MainSessionMeta,
  type RoutingConfig,
  type SessionPhase,
  type SessionRow,
  type SqliteDriver,
  type SubagentLogRecord,
  type TaskRow,
  type TaskStatus,
  type WorktreeDiffSnapshot,
} from "agent-swarm-director";

export {
  ASD_VERSION,
  AsdMcpServer,
  approvePendingTask,
  atomicWriteFileSync,
  buildInteractiveResumeHarnessCommand,
  buildResumeHarnessCommand,
  collectDashboardSnapshot,
  computeProjectHash,
  discoverHarnessModels,
  ensureProjectInitialized,
  extractHarnessSessionIdFromOutput,
  extractHookSessionInfo,
  getAdapter,
  getLatestSession,
  getWorktreeDiff,
  killProcessTree,
  linkHarnessSessionToAsdSession,
  listKnownProjects,
  loadRoutingConfig,
  openProjectDb,
  parsePlanMd,
  readCliRecentSessions,
  recordCliRecentSession,
  redactSecrets,
  rejectPendingTask,
  renderPlanMd,
  renderProgressBoard,
  renderSessionSummaryMd,
  resolveAsdPaths,
  resolveRoute,
  resolveSpawnCommand,
  runAsdClean,
  runAsdDoctor,
  runAsdLogs,
  runSubagentControlAction,
  saveProjectRoutingConfig,
  saveSessionMemo,
  scanSubagentLogs,
  spawnSubagent,
  syncLocalHarnessTranscripts,
  syncPlanFromMd,
  withMergeLock,
  type AsdDebateInput,
  type AsdDebateOutput,
  type AsdDispatchInput,
  type AsdDispatchOutput,
  type AsdPlanInput,
  type AsdPlanOutput,
  type AsdVerifyInput,
  type AsdVerifyOutput,
  type DashboardSnapshot,
  type HarnessId,
  type HarnessModelCatalog,
  type KnownProjectSummary,
  type MainSessionMeta,
  type RoutingConfig,
  type SessionPhase,
  type SessionRow,
  type SqliteDriver,
  type SubagentLogRecord,
  type TaskRow,
  type TaskStatus,
  type WorktreeDiffSnapshot,
};

function requireExplicitSessionId(sessionId: string | undefined, fnName: string): string {
  const trimmed = sessionId?.trim() ?? "";
  if (!trimmed) {
    throw new Error(`${fnName} requires an explicit non-empty sessionId (GUI_ARCHITECTURE.md 6.1)`);
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
  ctx: { projectRoot: string; homeDir?: string; db?: SqliteDriver }
): Promise<AsdDispatchOutput> {
  const sessionId = requireExplicitSessionId(input.sessionId, "handleDispatch");
  return await rawHandleDispatch({ ...input, sessionId }, ctx);
}

/**
 * Invokes `handleVerify` with mandatory explicit `sessionId` (Section 6.1).
 */
export async function handleVerify(
  input: AsdVerifyInput,
  ctx: { projectRoot: string; homeDir?: string; db?: SqliteDriver }
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
  }
): Promise<AsdDebateOutput> {
  const sessionId = requireExplicitSessionId(input.sessionId, "handleDebate");
  return await rawHandleDebate({ ...input, sessionId }, ctx);
}
