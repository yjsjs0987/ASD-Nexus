/**
 * Shared REST and WebSocket protocol types for asd-gui (server & web).
 * Synchronized with agent-swarm-director v2.3.2 (CORE_CHANGE_REPORT.md).
 */

import type {
  AsdDebateOutput,
  AsdDispatchOutput,
  AsdPlanInput,
  AsdPlanOutput,
  DashboardSnapshot,
  DriverDetachReason,
  DriverRow,
  DriverRunResult,
  DriverSource,
  HarnessId,
  HarnessModelCatalog,
  HarnessTranscript,
  KnownProjectSummary,
  RoutingConfig,
  SessionPhase,
  TaskStatus,
  TranscriptMessage,
  WorktreeDiffSnapshot,
} from "agent-swarm-director";

export type {
  DriverDetachReason,
  DriverRow,
  DriverRunResult,
  DriverSource,
  HarnessTranscript,
  TranscriptMessage,
};

// ============================================================================
// Standard Error Codes & Envelope (Section 6.1)
// ============================================================================

export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "FORBIDDEN_ORIGIN",
  "INVALID_PATH",
  "INVALID_SESSION_ID",
  "NOT_FOUND",
  "CONFLICT",
  "LOCKED",
  "CORE_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
  };
}

// ============================================================================
// Ready Signal (Section 6.1 & 8.1)
// ============================================================================

export interface ServerReadyMessage {
  type: "asd-gui-ready";
  port: number;
  token: string;
}

// ============================================================================
// REST API Request / Response Types (Section 6.2)
// ============================================================================

// 1) Projects (/api/projects)
export interface GetProjectsResponse {
  projects: KnownProjectSummary[];
}

export interface BrowseDirsResponse {
  currentDir: string;
  parentDir: string | null;
  directories: string[];
  isGitRepo: boolean;
}

export interface OpenProjectRequest {
  projectRoot: string;
}

export type OpenProjectResponse = DashboardSnapshot & {
  isGitRepo?: boolean;
  gitBranch?: string | null;
  gitHeadSha?: string | null;
  foregroundSessionId?: string | null;
  recoveredOrphans?: Array<{
    sessionId: string;
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    reason: string;
  }>;
};

export interface GetProjectModelsResponse {
  models: HarnessModelCatalog;
}

export interface GetProjectRoutingResponse {
  config: RoutingConfig;
  hasLocalRouting: boolean;
}

export interface PutProjectRoutingRequest {
  projectRoot: string;
  action?: "save" | "reset";
  routingConfig?: RoutingConfig;
}

export interface PutProjectRoutingResponse {
  ok: boolean;
  hasLocalRouting: boolean;
  localRoutingPath: string;
  routingConfig: RoutingConfig;
}

// 2) Sessions (/api/sessions)
export interface CreateSessionRequest {
  projectRoot: string;
  harness: HarnessId;
  model?: string;
  memo?: string;
  makeForeground?: boolean;
}

export interface CreateSessionResponse {
  ok: true;
  sessionId: string;
  driver: DriverRow;
  foregroundSessionId: string | null;
}

export interface SaveSessionMemoRequest {
  projectRoot: string;
  sessionId: string;
  memo: string;
}

export interface SaveSessionMemoResponse {
  ok: true;
  sessionId: string;
  memo: string;
}

export interface SetForegroundSessionRequest {
  projectRoot: string;
  sessionId: string;
}

export interface SetForegroundSessionResponse {
  ok: true;
  sessionId: string;
  planMdPath: string;
}

export interface UpdateSessionPhaseRequest {
  projectRoot: string;
  sessionId: string;
  phase: Extract<SessionPhase, "paused" | "running" | "done">;
}

export interface UpdateSessionPhaseResponse {
  ok: true;
  phase: SessionPhase;
}

export interface UpdateSessionPlanRequest {
  projectRoot: string;
  sessionId: string;
  autoApprove?: boolean;
  tasks: NonNullable<AsdPlanInput["tasks"]>;
}

export type UpdateSessionPlanResponse = AsdPlanOutput;

export interface StartDebateRequest {
  projectRoot: string;
  sessionId: string;
  taskId?: string;
  topic: string;
  proposal: string;
  files?: string[];
  includeDiff?: boolean;
  harness?: HarnessId;
}

export interface StartDebateResponse {
  ok: true;
  jobId: string;
  sessionId: string;
}

export type SubagentControlActionType =
  | "kill"
  | "retry"
  | "fallback"
  | "custom"
  | "resume";

export interface SubagentActionRequest {
  projectRoot: string;
  sessionId: string;
  subSessionId: string;
  action: SubagentControlActionType;
  prompt?: string;
  harness?: HarnessId;
  model?: string;
}

export interface SubagentActionResponse {
  ok: true;
  jobId: string;
  action: SubagentControlActionType;
  newSubSessionId?: string;
  taskId?: string;
  followUpTaskId?: string;
}

// 3) Drivers (/api/drivers)
export interface GetDriversResponse {
  activeDriverId: string | null;
  drivers: DriverRow[];
}

export interface AttachDriverRequest {
  projectRoot: string;
  sessionId: string;
  harness: HarnessId;
  model?: string;
  harnessSessionId?: string;
  source: "gui-headless" | "gui-link" | "gui-pty";
}

export interface AttachDriverResponse {
  ok: true;
  driver: DriverRow;
  previousDriverId: string | null;
}

export interface DriverPromptRequest {
  projectRoot: string;
  sessionId: string;
  prompt: string;
  mode?: "chat" | "plan";
}

export interface DriverPromptResponse {
  ok: true;
  jobId: string;
  runId: string;
  driverId: string;
}

export interface CancelDriverRequest {
  projectRoot: string;
  sessionId: string;
  runId: string;
}

export interface CancelDriverResponse {
  ok: true;
}

// 4) Transcripts (/api/transcripts)
export type GetTranscriptResponse = HarnessTranscript;

export interface GetResumeCommandResponse {
  cliString: string;
  command: string;
  args: string[];
  ptyAvailable?: boolean;
}

// 5) Tasks (/api/tasks)
export interface GetPlanMdResponse {
  content: string;
  foregroundSessionId: string | null;
  stateVersion?: number;
}

export interface PutPlanMdRequest {
  projectRoot: string;
  sessionId: string;
  content: string;
  baseVersion: number;
}

export interface PutPlanMdResponse {
  ok: true;
  stateVersion: number;
  tasks: unknown[];
}

export interface DispatchTasksRequest {
  projectRoot: string;
  sessionId: string;
  turn?: number;
  taskIds?: string[];
}

export interface DispatchTasksResponse {
  ok: true;
  jobId: string;
  sessionId: string;
  turn?: number;
}

export type GetTaskDiffResponse = WorktreeDiffSnapshot & {
  mode: "working" | "committed";
};

export interface ApproveTaskRequest {
  projectRoot: string;
  sessionId: string;
  taskId: string;
  smokeCmd?: string;
}

export interface ApproveTaskResponse {
  ok: boolean;
  status: string;
  commitSha?: string;
  changedFiles?: string[];
  error?: string;
}

export interface RejectTaskRequest {
  projectRoot: string;
  sessionId: string;
  taskId: string;
}

export interface RejectTaskResponse {
  ok: boolean;
  status: "failed";
  untouchedFiles?: string[];
}

export interface ResolveConflictRequest {
  projectRoot: string;
  sessionId: string;
  taskId: string;
  strategy: "ai";
}

export interface ResolveConflictResponse {
  ok: true;
  jobId: string;
}

// ============================================================================
// WebSocket Messages (Section 6.3)
// ============================================================================

export type JobKind =
  | "dispatch"
  | "debate"
  | "driver_turn"
  | "subagent_action"
  | "resolve_conflict";

export type ClientWsMessage =
  | { type: "subscribe_project"; projectRoot: string }
  | { type: "unsubscribe_project"; projectRoot: string }
  | {
      type: "subscribe_log";
      projectRoot: string;
      sessionId: string;
      subSessionId?: string;
      runId?: string;
      fromOffset?: number;
    }
  | {
      type: "unsubscribe_log";
      projectRoot: string;
      sessionId: string;
      subSessionId?: string;
      runId?: string;
    }
  | {
      type: "pty_spawn";
      tabId: string;
      projectRoot: string;
      cwd?: string;
      harness?: HarnessId;
      harnessSessionId?: string;
      model?: string;
      asDriverOf?: { sessionId: string; driverId: string };
      cols: number;
      rows: number;
    }
  | { type: "pty_input"; tabId: string; data: string }
  | { type: "pty_resize"; tabId: string; cols: number; rows: number }
  | { type: "pty_kill"; tabId: string };

export type ServerWsMessage =
  | {
      type: "state_updated";
      projectRoot: string;
      snapshot: DashboardSnapshot & {
        isGitRepo?: boolean;
        gitBranch?: string | null;
        gitHeadSha?: string | null;
        foregroundSessionId?: string | null;
      };
    }
  | {
      type: "task_status_changed";
      projectRoot: string;
      sessionId: string;
      taskId: string;
      from: TaskStatus | null;
      to: TaskStatus;
      reason?: string;
    }
  | {
      type: "job_started";
      jobId: string;
      kind: JobKind;
      projectRoot: string;
      sessionId: string;
      taskIds?: string[];
      runId?: string;
    }
  | { type: "job_progress"; jobId: string; message: string }
  | {
      type: "job_finished";
      jobId: string;
      kind: JobKind;
      ok: boolean;
      result?:
        | AsdDispatchOutput
        | AsdDebateOutput
        | DriverRunResult
        | { runId: string; exitCode: number; harnessSessionId: string | null }
        | unknown;
      error?: string;
    }
  | {
      type: "subagent_log_chunk";
      projectRoot: string;
      sessionId: string;
      subSessionId: string;
      offset: number;
      chunk: string;
    }
  | {
      type: "driver_output_chunk";
      projectRoot: string;
      sessionId: string;
      runId: string;
      offset: number;
      chunk: string;
    }
  | {
      type: "log_closed";
      projectRoot: string;
      sessionId: string;
      subSessionId?: string;
      runId?: string;
      reason: "finished" | "deleted";
    }
  | { type: "pty_output"; tabId: string; data: string }
  | { type: "pty_exit"; tabId: string; exitCode: number }
  | { type: "pty_error"; tabId: string; message: string }
  | { type: "error"; code: string; message: string; sessionId?: string };
