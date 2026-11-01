/**
 * asd-gui REST API client — replaces Elysium's Tauri invoke with fetch(REST).
 * Covers 24 endpoints across Projects, Sessions, Drivers, Transcripts, Tasks.
 * Types re-exported from src/shared/protocol.ts (sourced from agent-swarm-director).
 * Error envelope: { ok:false, error:{code,message} } with codes:
 * AUTH_REQUIRED | FORBIDDEN_ORIGIN | INVALID_PATH | INVALID_SESSION_ID | NOT_FOUND | CONFLICT | LOCKED | CORE_ERROR
 * Auth: credentials:"include" (asd_token cookie handled by server). No Bearer needed.
 */

import type {
  // Error
  ApiErrorEnvelope,
  ErrorCode,
  // Projects
  GetProjectsResponse,
  BrowseDirsResponse,
  OpenProjectRequest,
  OpenProjectResponse,
  GetProjectModelsResponse,
  GetProjectRoutingResponse,
  PutProjectRoutingRequest,
  PutProjectRoutingResponse,
  // Sessions
  CreateSessionRequest,
  CreateSessionResponse,
  SaveSessionMemoRequest,
  SaveSessionMemoResponse,
  SetForegroundSessionRequest,
  SetForegroundSessionResponse,
  UpdateSessionPhaseRequest,
  UpdateSessionPhaseResponse,
  UpdateSessionPlanRequest,
  UpdateSessionPlanResponse,
  StartDebateRequest,
  StartDebateResponse,
  SubagentActionRequest,
  SubagentActionResponse,
  // Drivers
  GetDriversResponse,
  AttachDriverRequest,
  AttachDriverResponse,
  DriverPromptRequest,
  DriverPromptResponse,
  CancelDriverRequest,
  CancelDriverResponse,
  // Transcripts
  GetTranscriptResponse,
  GetResumeCommandResponse,
  // Tasks
  GetPlanMdResponse,
  PutPlanMdRequest,
  PutPlanMdResponse,
  DispatchTasksRequest,
  DispatchTasksResponse,
  GetTaskDiffResponse,
  ApproveTaskRequest,
  ApproveTaskResponse,
  RejectTaskRequest,
  RejectTaskResponse,
  ResolveConflictRequest,
  ResolveConflictResponse,
} from "../shared/protocol.ts";

const API_BASE = ""; // same-origin, vite proxies /api → 4173 in dev

function err(code: ErrorCode, message: string): ApiErrorEnvelope {
  return { ok: false, error: { code, message } };
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    credentials: "include",
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const env = data as ApiErrorEnvelope;
    const code = env.error?.code ?? "CORE_ERROR";
    const msg = env.error?.message ?? `HTTP ${res.status}`;
    throw err(code as ErrorCode, msg);
  }
  return data as T;
}

// ============================================================================
// Projects (/api/projects)
// ============================================================================

export async function getProjects(): Promise<GetProjectsResponse> {
  return fetchJson("/api/projects");
}

export async function browseDirs(
  dir?: string,
  includeHidden = false
): Promise<BrowseDirsResponse> {
  const params = new URLSearchParams();
  if (dir) params.set("dir", dir);
  if (includeHidden) params.set("hidden", "1");
  return fetchJson(`/api/projects/browse-dirs?${params}`);
}

export async function openProject(
  projectRoot: string
): Promise<OpenProjectResponse> {
  return fetchJson("/api/projects/open", {
    method: "POST",
    body: JSON.stringify({ projectRoot }),
  });
}

export async function getProjectModels(
  projectRoot: string,
  opts?: { forceRefresh?: boolean; skipCliSpawn?: boolean }
): Promise<GetProjectModelsResponse> {
  const params = new URLSearchParams();
  params.set("projectRoot", projectRoot);
  if (opts?.forceRefresh) params.set("refresh", "1");
  if (opts?.skipCliSpawn) params.set("skipCliSpawn", "1");
  return fetchJson(`/api/projects/models?${params}`);
}

export async function getProjectRouting(
  projectRoot: string
): Promise<GetProjectRoutingResponse> {
  return fetchJson(`/api/projects/routing?projectRoot=${encodeURIComponent(projectRoot)}`);
}

export async function putProjectRouting(
  req: PutProjectRoutingRequest
): Promise<PutProjectRoutingResponse> {
  return fetchJson("/api/projects/routing", {
    method: "PUT",
    body: JSON.stringify(req),
  });
}

// ============================================================================
// Sessions (/api/sessions)
// ============================================================================

export async function getSessionState(
  projectRoot: string
): Promise<OpenProjectResponse> {
  // Returns raw DashboardSnapshot (no wrapper) — matches server GET /api/sessions/state
  return fetchJson(`/api/sessions/state?projectRoot=${encodeURIComponent(projectRoot)}`);
}

export async function createSession(
  req: CreateSessionRequest
): Promise<CreateSessionResponse> {
  return fetchJson("/api/sessions/create", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function saveSessionMemo(
  req: SaveSessionMemoRequest
): Promise<SaveSessionMemoResponse> {
  return fetchJson("/api/sessions/memo", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function setForegroundSession(
  req: SetForegroundSessionRequest
): Promise<SetForegroundSessionResponse> {
  return fetchJson("/api/sessions/foreground", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function updateSessionPhase(
  req: UpdateSessionPhaseRequest
): Promise<UpdateSessionPhaseResponse> {
  return fetchJson("/api/sessions/phase", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function updateSessionPlan(
  req: UpdateSessionPlanRequest
): Promise<UpdateSessionPlanResponse> {
  return fetchJson("/api/sessions/plan", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function startDebate(
  req: StartDebateRequest
): Promise<StartDebateResponse> {
  return fetchJson("/api/sessions/debate", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function subagentAction(
  req: SubagentActionRequest
): Promise<SubagentActionResponse> {
  return fetchJson("/api/sessions/subagent-action", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// ============================================================================
// Drivers (/api/drivers)
// ============================================================================

export async function getDrivers(
  projectRoot: string,
  sessionId: string
): Promise<GetDriversResponse> {
  const params = new URLSearchParams();
  params.set("projectRoot", projectRoot);
  params.set("sessionId", sessionId);
  return fetchJson(`/api/drivers?${params}`);
}

export async function attachDriver(
  req: AttachDriverRequest
): Promise<AttachDriverResponse> {
  return fetchJson("/api/drivers/attach", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function driverPrompt(
  req: DriverPromptRequest
): Promise<DriverPromptResponse> {
  return fetchJson("/api/drivers/prompt", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function cancelDriver(
  req: CancelDriverRequest
): Promise<CancelDriverResponse> {
  return fetchJson("/api/drivers/cancel", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// ============================================================================
// Transcripts (/api/transcripts)
// ============================================================================

export async function getTranscript(params: {
  projectRoot?: string;
  harness: "claude-code" | "codex" | "opencode" | "antigravity" | "cursor";
  harnessSessionId: string;
  transcriptPath?: string;
  limit?: number;
  before?: number;
}): Promise<GetTranscriptResponse> {
  const sp = new URLSearchParams();
  if (params.projectRoot) sp.set("projectRoot", params.projectRoot);
  sp.set("harness", params.harness);
  sp.set("harnessSessionId", params.harnessSessionId);
  if (params.transcriptPath) sp.set("transcriptPath", params.transcriptPath);
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.before) sp.set("before", String(params.before));
  return fetchJson(`/api/transcripts?${sp}`);
}

export async function getResumeCommand(params: {
  harness: "claude-code" | "codex" | "opencode" | "antigravity" | "cursor";
  harnessSessionId?: string;
  model?: string;
}): Promise<GetResumeCommandResponse> {
  const sp = new URLSearchParams();
  sp.set("harness", params.harness);
  if (params.harnessSessionId) sp.set("harnessSessionId", params.harnessSessionId);
  if (params.model) sp.set("model", params.model);
  return fetchJson(`/api/transcripts/resume-command?${sp}`);
}

// ============================================================================
// Tasks (/api/tasks)
// ============================================================================

export async function getPlanMd(
  projectRoot: string
): Promise<GetPlanMdResponse> {
  return fetchJson(`/api/tasks/plan-md?projectRoot=${encodeURIComponent(projectRoot)}`);
}

export async function putPlanMd(
  req: PutPlanMdRequest
): Promise<PutPlanMdResponse> {
  return fetchJson("/api/tasks/plan-md", {
    method: "PUT",
    body: JSON.stringify(req),
  });
}

export async function dispatchTasks(
  req: DispatchTasksRequest
): Promise<DispatchTasksResponse> {
  return fetchJson("/api/tasks/dispatch", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function getTaskDiff(params: {
  projectRoot: string;
  sessionId: string;
  taskId: string;
}): Promise<GetTaskDiffResponse> {
  const sp = new URLSearchParams();
  sp.set("projectRoot", params.projectRoot);
  sp.set("sessionId", params.sessionId);
  sp.set("taskId", params.taskId);
  return fetchJson(`/api/tasks/diff?${sp}`);
}

export async function approveTask(
  req: ApproveTaskRequest
): Promise<ApproveTaskResponse> {
  return fetchJson("/api/tasks/approve", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function rejectTask(
  req: RejectTaskRequest
): Promise<RejectTaskResponse> {
  return fetchJson("/api/tasks/reject", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function resolveConflict(
  req: ResolveConflictRequest
): Promise<ResolveConflictResponse> {
  return fetchJson("/api/tasks/resolve-conflict", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

// ============================================================================
// Re-export types for consumers (components, hooks, store)
// ============================================================================

export type {
  ApiErrorEnvelope,
  ErrorCode,
  // Projects
  GetProjectsResponse,
  BrowseDirsResponse,
  OpenProjectRequest,
  OpenProjectResponse,
  GetProjectModelsResponse,
  GetProjectRoutingResponse,
  PutProjectRoutingRequest,
  PutProjectRoutingResponse,
  // Sessions
  CreateSessionRequest,
  CreateSessionResponse,
  SaveSessionMemoRequest,
  SaveSessionMemoResponse,
  SetForegroundSessionRequest,
  SetForegroundSessionResponse,
  UpdateSessionPhaseRequest,
  UpdateSessionPhaseResponse,
  UpdateSessionPlanRequest,
  UpdateSessionPlanResponse,
  StartDebateRequest,
  StartDebateResponse,
  SubagentActionRequest,
  SubagentActionResponse,
  // Drivers
  GetDriversResponse,
  AttachDriverRequest,
  AttachDriverResponse,
  DriverPromptRequest,
  DriverPromptResponse,
  CancelDriverRequest,
  CancelDriverResponse,
  // Transcripts
  GetTranscriptResponse,
  GetResumeCommandResponse,
  // Tasks
  GetPlanMdResponse,
  PutPlanMdRequest,
  PutPlanMdResponse,
  DispatchTasksRequest,
  DispatchTasksResponse,
  GetTaskDiffResponse,
  ApproveTaskRequest,
  ApproveTaskResponse,
  RejectTaskRequest,
  RejectTaskResponse,
  ResolveConflictRequest,
  ResolveConflictResponse,
};

// ============================================================================
// Utility: baseName (kept for compat with T1.1 stub consumers)
// ============================================================================

/** 경로의 마지막 폴더 이름(세션 카드의 작업 폴더 표시) */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 에러를 사람이 읽을 수 있는 문자열로 변환 */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "error" in e) {
    const env = e as ApiErrorEnvelope;
    return `${env.error.code}: ${env.error.message}`;
  }
  return JSON.stringify(e);
}