/**
 * Task routes (/api/tasks/*) — GUI_ARCHITECTURE.md 6.2.5.
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import {
  approvePendingTask,
  atomicWriteFileSync,
  getForegroundSessionId,
  getWorktreeDiff,
  handleDispatch,
  rejectPendingTask,
  resolveAsdPaths,
  runGit,
  runSubagentControlAction,
  scanSubagentLogs,
  syncPlanFromMd,
} from "../core-api.ts";
import {
  HttpApiError,
  type ServerContext,
  validateProjectRoot,
  validateSessionId,
} from "../context.ts";
import { readJsonBody, sendJson } from "../index.ts";
import type { JobRegistry } from "../jobs/job-registry.ts";
import type { StateWatcher } from "../watcher/state-watcher.ts";
import type {
  ApproveTaskRequest,
  ApproveTaskResponse,
  DispatchTasksRequest,
  DispatchTasksResponse,
  GetPlanMdResponse,
  GetTaskDiffResponse,
  PutPlanMdRequest,
  PutPlanMdResponse,
  RejectTaskRequest,
  RejectTaskResponse,
  ResolveConflictRequest,
  ResolveConflictResponse,
} from "../../shared/protocol.ts";

export interface PtyCloseTabsProvider {
  closeTabsInPath(targetDir: string): Promise<number> | number;
}

export async function handleTasksRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  context: ServerContext,
  watcher: StateWatcher,
  jobRegistry: JobRegistry,
  ptyManager?: PtyCloseTabsProvider
): Promise<boolean> {
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/api/tasks/plan-md") {
    const projectRoot = validateProjectRoot(
      parsedUrl.searchParams.get("projectRoot")
    );
    const paths = resolveAsdPaths(projectRoot, context.homeDir);
    const content = fs.existsSync(paths.planMdPath)
      ? fs.readFileSync(paths.planMdPath, "utf8")
      : "";
    const foregroundSessionId = getForegroundSessionId(
      projectRoot,
      paths.planMdPath
    );
    let stateVersion: number | undefined;
    if (foregroundSessionId) {
      const db = context.getDb(projectRoot);
      stateVersion = db.getSession(foregroundSessionId)?.state_version;
    }
    const response: GetPlanMdResponse = {
      content,
      foregroundSessionId,
      ...(stateVersion !== undefined ? { stateVersion } : {}),
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "PUT" && pathname === "/api/tasks/plan-md") {
    const body = await readJsonBody<PutPlanMdRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const content = typeof body.content === "string" ? body.content : "";
    const baseVersion =
      typeof body.baseVersion === "number" ? body.baseVersion : -1;

    const paths = resolveAsdPaths(projectRoot, context.homeDir);
    const fgId = getForegroundSessionId(projectRoot, paths.planMdPath);
    if (fgId && fgId !== sessionId) {
      throw new HttpApiError(
        409,
        "CONFLICT",
        `전경 세션(${fgId})이 아닌 세션(${sessionId})에서는 PLAN.md를 직접 저장할 수 없습니다 (NOT_FOREGROUND_SESSION)`
      );
    }

    const db = context.getDb(projectRoot);
    const sessionRow = db.getSession(sessionId);
    if (!sessionRow) {
      throw new HttpApiError(404, "NOT_FOUND", `Session not found: ${sessionId}`);
    }

    if (sessionRow.state_version !== baseVersion) {
      throw new HttpApiError(
        409,
        "CONFLICT",
        `PLAN.md state_version 불일치 (요청 baseVersion=${baseVersion}, 현재=${sessionRow.state_version})`
      );
    }

    fs.mkdirSync(path.dirname(paths.planMdPath), { recursive: true });
    atomicWriteFileSync(paths.planMdPath, content);
    const syncedTasks = syncPlanFromMd(db, sessionId, paths.planMdPath);
    const updatedSession = db.getSession(sessionId);

    await watcher.forceBroadcastProject(projectRoot);
    const response: PutPlanMdResponse = {
      ok: true,
      stateVersion: updatedSession?.state_version ?? sessionRow.state_version + 1,
      tasks: syncedTasks,
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks/dispatch") {
    const body = await readJsonBody<DispatchTasksRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const db = context.getDb(projectRoot);
    if (!db.getSession(sessionId)) {
      throw new HttpApiError(404, "NOT_FOUND", `Session not found: ${sessionId}`);
    }

    const jobId = jobRegistry.startJob({
      kind: "dispatch",
      projectRoot,
      sessionId,
      taskIds: body.taskIds,
      run: async ({ signal }) => {
        const out = await handleDispatch(
          {
            sessionId,
            turn: body.turn,
            taskIds: body.taskIds,
            mode: "parallel_spawn",
          },
          {
            projectRoot,
            homeDir: context.homeDir,
            signal,
            commandRunner: context.commandRunner,
          }
        );
        await watcher.forceBroadcastProject(projectRoot);
        return out;
      },
    });

    const response: DispatchTasksResponse = {
      ok: true,
      jobId,
      sessionId,
      ...(body.turn !== undefined ? { turn: body.turn } : {}),
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/tasks/diff") {
    const projectRoot = validateProjectRoot(
      parsedUrl.searchParams.get("projectRoot")
    );
    const sessionId = validateSessionId(
      parsedUrl.searchParams.get("sessionId")
    );
    const taskId = parsedUrl.searchParams.get("taskId")?.trim() ?? "";
    if (!taskId) {
      throw new HttpApiError(400, "INVALID_PATH", "taskId is required");
    }

    const db = context.getDb(projectRoot);
    const task = db.getTask(sessionId, taskId);
    if (!task) {
      throw new HttpApiError(
        404,
        "NOT_FOUND",
        `Task not found: ${sessionId}/${taskId}`
      );
    }

    const diffSnap = getWorktreeDiff(projectRoot, {
      wtPath: task.worktree_path ?? undefined,
      turn: task.turn,
      taskId: task.task_id,
      useMergeBase: task.status === "merge_conflict",
    });
    const response: GetTaskDiffResponse = {
      ...diffSnap,
      mode: diffSnap.mode ?? (task.status === "merge_conflict" ? "committed" : "working"),
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks/approve") {
    const body = await readJsonBody<ApproveTaskRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const taskId = body.taskId?.trim() ?? "";
    if (!taskId) {
      throw new HttpApiError(400, "INVALID_PATH", "taskId is required");
    }

    const db = context.getDb(projectRoot);
    const task = db.getTask(sessionId, taskId);
    if (!task) {
      throw new HttpApiError(
        404,
        "NOT_FOUND",
        `Task not found: ${sessionId}/${taskId}`
      );
    }
    if (task.status !== "merge_conflict") {
      throw new HttpApiError(
        409,
        "CONFLICT",
        `GUI v1에서는 merge_conflict 상태의 태스크만 재검증·병합(approve)할 수 있습니다 (현재: ${task.status})`
      );
    }

    const wtPath =
      task.worktree_path ||
      path.join(projectRoot, ".asd", "wt", `${task.turn}-${task.task_id}`);
    if (ptyManager && fs.existsSync(wtPath)) {
      await ptyManager.closeTabsInPath(wtPath);
    }

    const result = await approvePendingTask({
      projectRoot,
      sessionId,
      taskId,
      db,
      smokeCmd: body.smokeCmd ?? null,
    });
    await watcher.forceBroadcastProject(projectRoot);
    const response: ApproveTaskResponse = result;
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks/reject") {
    const body = await readJsonBody<RejectTaskRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const taskId = body.taskId?.trim() ?? "";
    if (!taskId) {
      throw new HttpApiError(400, "INVALID_PATH", "taskId is required");
    }

    const db = context.getDb(projectRoot);
    const task = db.getTask(sessionId, taskId);
    if (!task) {
      throw new HttpApiError(
        404,
        "NOT_FOUND",
        `Task not found: ${sessionId}/${taskId}`
      );
    }
    if (task.status !== "merge_conflict") {
      throw new HttpApiError(
        409,
        "CONFLICT",
        `GUI v1에서는 merge_conflict 상태의 태스크만 반려(reject)할 수 있습니다 (현재: ${task.status})`
      );
    }

    const wtPath =
      task.worktree_path ||
      path.join(projectRoot, ".asd", "wt", `${task.turn}-${task.task_id}`);
    if (ptyManager && fs.existsSync(wtPath)) {
      await ptyManager.closeTabsInPath(wtPath);
    }

    const result = rejectPendingTask({
      projectRoot,
      sessionId,
      taskId,
      db,
    });
    await watcher.forceBroadcastProject(projectRoot);
    const response: RejectTaskResponse = {
      ok: result.ok,
      status: "failed",
      ...(result.untouchedFiles ? { untouchedFiles: result.untouchedFiles } : {}),
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/tasks/resolve-conflict") {
    const body = await readJsonBody<ResolveConflictRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const taskId = body.taskId?.trim() ?? "";
    if (!taskId) {
      throw new HttpApiError(400, "INVALID_PATH", "taskId is required");
    }

    const db = context.getDb(projectRoot);
    const task = db.getTask(sessionId, taskId);
    if (!task) {
      throw new HttpApiError(
        404,
        "NOT_FOUND",
        `Task not found: ${sessionId}/${taskId}`
      );
    }
    if (task.status !== "merge_conflict") {
      throw new HttpApiError(
        409,
        "CONFLICT",
        `merge_conflict 상태의 태스크만 AI 충돌 해결을 실행할 수 있습니다 (현재: ${task.status})`
      );
    }

    const logs = scanSubagentLogs(projectRoot).filter(
      (l) => l.sessionId === sessionId && l.taskId === taskId
    );
    const subSessionId = task.sub_session_id || logs[0]?.subSessionId || "";
    if (!subSessionId) {
      throw new HttpApiError(
        404,
        "NOT_FOUND",
        `Subagent session not found for task ${taskId}`
      );
    }

    let allowedFiles: string[] = [];
    try {
      allowedFiles = JSON.parse(task.target_files_json || "[]");
    } catch {
      allowedFiles = [];
    }
    const baseBranchRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
    });
    const baseRef =
      baseBranchRes.exitCode === 0 && baseBranchRes.stdout.trim()
        ? baseBranchRes.stdout.trim()
        : "HEAD";

    const conflictPrompt = `현재 브랜치 asd/wt-${task.turn}-${task.task_id}에 메인 브랜치 ${baseRef}를 git merge하고 충돌을 해결한 뒤 커밋하라. 허용 파일 ${
      allowedFiles.length > 0 ? allowedFiles.join(", ") : "(전체)"
    } 밖은 수정하지 말라.`;

    const jobId = jobRegistry.startJob({
      kind: "resolve_conflict",
      projectRoot,
      sessionId,
      taskIds: [taskId],
      run: async () => {
        const resResolve = await runSubagentControlAction({
          projectRoot,
          homeDir: context.homeDir,
          sessionId,
          subSessionId,
          action: "resume",
          prompt: conflictPrompt,
          waitForCompletion: true,
          commandRunner: context.commandRunner,
        });
        await watcher.forceBroadcastProject(projectRoot);
        return resResolve;
      },
    });

    const response: ResolveConflictResponse = { ok: true, jobId };
    sendJson(res, 200, response);
    return true;
  }

  return false;
}
