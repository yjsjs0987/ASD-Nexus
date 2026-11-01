/**
 * Session routes (/api/sessions/*) — GUI_ARCHITECTURE.md 6.2.2.
 */

import type * as http from "node:http";
import {
  attachDriver,
  detachDriver,
  generateAsdSessionId,
  getActiveDriver,
  handleDebate,
  handlePlan,
  resolveAsdPaths,
  runSubagentControlAction,
  saveSessionMemo,
  setForegroundSession,
  syncSessionDriversToMainJson,
  type HarnessId,
  type SessionPhase,
} from "../core-api.ts";
import {
  HttpApiError,
  type ServerContext,
  validateProjectRoot,
  validateSessionId,
} from "../context.ts";
import { readJsonBody, sendJson } from "../index.ts";
import type { JobRegistry } from "../jobs/job-registry.ts";
import {
  collectEnrichedSnapshot,
  type StateWatcher,
} from "../watcher/state-watcher.ts";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  SaveSessionMemoRequest,
  SaveSessionMemoResponse,
  SetForegroundSessionRequest,
  SetForegroundSessionResponse,
  StartDebateRequest,
  StartDebateResponse,
  SubagentActionRequest,
  SubagentActionResponse,
  UpdateSessionPhaseRequest,
  UpdateSessionPhaseResponse,
  UpdateSessionPlanRequest,
} from "../../shared/protocol.ts";

export async function handleSessionsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  context: ServerContext,
  watcher: StateWatcher,
  jobRegistry?: JobRegistry
): Promise<boolean> {
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/api/sessions/state") {
    const projectRoot = validateProjectRoot(
      parsedUrl.searchParams.get("projectRoot")
    );
    const snapshot = await collectEnrichedSnapshot(projectRoot, context.homeDir);
    sendJson(res, 200, snapshot);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/sessions/create") {
    const body = await readJsonBody<CreateSessionRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const harness = (body.harness || "claude-code") as HarnessId;
    const model = body.model?.trim() || null;
    const memo = body.memo?.trim() || "";
    const makeForeground = body.makeForeground ?? true;

    const db = context.getDb(projectRoot);
    const sessionId = generateAsdSessionId();
    db.createOrGetSession({
      sessionId,
      projectRoot,
      mainHarness: harness,
      mainModel: model,
      harnessSessionId: null,
      mainPid: process.pid,
    });
    if (memo) {
      db.updateSessionMemo(sessionId, memo);
    }

    const attached = attachDriver(db, {
      projectRoot,
      sessionId,
      harness,
      model,
      harnessSessionId: null,
      source: "gui-headless",
    });

    if (makeForeground) {
      setForegroundSession({ db, projectRoot, sessionId });
    } else {
      syncSessionDriversToMainJson(db, projectRoot, sessionId);
    }

    const snap = await watcher.forceBroadcastProject(projectRoot);
    const response: CreateSessionResponse = {
      ok: true,
      sessionId,
      driver: attached.driver,
      foregroundSessionId: snap?.foregroundSessionId ?? (makeForeground ? sessionId : null),
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/sessions/memo") {
    const body = await readJsonBody<SaveSessionMemoRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const memo = typeof body.memo === "string" ? body.memo.trim() : "";

    saveSessionMemo({
      projectRoot,
      homeDir: context.homeDir,
      sessionId,
      memo,
    });
    await watcher.forceBroadcastProject(projectRoot);
    const response: SaveSessionMemoResponse = { ok: true, sessionId, memo };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/sessions/foreground") {
    const body = await readJsonBody<SetForegroundSessionRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const db = context.getDb(projectRoot);
    if (!db.getSession(sessionId)) {
      throw new HttpApiError(404, "NOT_FOUND", `Session not found: ${sessionId}`);
    }
    const paths = resolveAsdPaths(projectRoot, context.homeDir);
    setForegroundSession({
      db,
      projectRoot,
      sessionId,
      planMdPath: paths.planMdPath,
    });
    await watcher.forceBroadcastProject(projectRoot);
    const response: SetForegroundSessionResponse = {
      ok: true,
      sessionId,
      planMdPath: paths.planMdPath,
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/sessions/phase") {
    const body = await readJsonBody<UpdateSessionPhaseRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const phase = body.phase as SessionPhase;
    if (phase !== "paused" && phase !== "running" && phase !== "done") {
      throw new HttpApiError(
        400,
        "CONFLICT",
        `Invalid phase transition target: ${String(body.phase)}`
      );
    }

    const db = context.getDb(projectRoot);
    if (!db.getSession(sessionId)) {
      throw new HttpApiError(404, "NOT_FOUND", `Session not found: ${sessionId}`);
    }
    db.updateSessionPhase(sessionId, phase);
    if (phase === "done") {
      const activeDriver = getActiveDriver(db, sessionId);
      if (activeDriver) {
        detachDriver(db, {
          projectRoot,
          driverId: activeDriver.driver_id,
          reason: "session_done",
        });
      }
    } else {
      syncSessionDriversToMainJson(db, projectRoot, sessionId);
    }
    await watcher.forceBroadcastProject(projectRoot);
    const response: UpdateSessionPhaseResponse = { ok: true, phase };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/sessions/plan") {
    const body = await readJsonBody<UpdateSessionPlanRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    if (!Array.isArray(body.tasks)) {
      throw new HttpApiError(400, "CORE_ERROR", "tasks array is required");
    }
    const planOut = await handlePlan(
      {
        action: "update",
        sessionId,
        tasks: body.tasks,
      },
      { projectRoot, homeDir: context.homeDir }
    );
    await watcher.forceBroadcastProject(projectRoot);
    sendJson(res, 200, planOut);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/sessions/debate") {
    if (!jobRegistry) {
      throw new HttpApiError(500, "CORE_ERROR", "JobRegistry not initialized");
    }
    const body = await readJsonBody<StartDebateRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    if (!body.topic?.trim() || !body.proposal?.trim()) {
      throw new HttpApiError(
        400,
        "CORE_ERROR",
        "topic and proposal are required for debate"
      );
    }

    const jobId = jobRegistry.startJob({
      kind: "debate",
      projectRoot,
      sessionId,
      taskIds: body.taskId ? [body.taskId] : undefined,
      run: async ({ signal, emitProgress }) => {
        const resDebate = await handleDebate(
          {
            sessionId,
            taskId: body.taskId,
            topic: body.topic,
            proposal: body.proposal,
            files: body.files,
            includeDiff: body.includeDiff,
            harness: body.harness,
          },
          {
            projectRoot,
            homeDir: context.homeDir,
            signal,
            onProgress: (msg) => emitProgress(msg),
          }
        );
        await watcher.forceBroadcastProject(projectRoot);
        return resDebate;
      },
    });

    const response: StartDebateResponse = { ok: true, jobId, sessionId };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/sessions/subagent-action") {
    if (!jobRegistry) {
      throw new HttpApiError(500, "CORE_ERROR", "JobRegistry not initialized");
    }
    const body = await readJsonBody<SubagentActionRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const subSessionId = body.subSessionId?.trim();
    if (!subSessionId) {
      throw new HttpApiError(400, "CORE_ERROR", "subSessionId is required");
    }

    // Immediate kill can run synchronously inside a short job or pre-validate resume rules (Section 6.6)
    const db = context.getDb(projectRoot);
    if (body.action === "resume") {
      const snap = await collectEnrichedSnapshot(projectRoot, context.homeDir);
      const subLog = snap.subagentLogs.find(
        (l) => l.subSessionId === subSessionId
      );
      if (!subLog) {
        throw new HttpApiError(
          404,
          "NOT_FOUND",
          `Subagent not found: ${subSessionId}`
        );
      }
      if (!subLog.harnessSessionId) {
        throw new HttpApiError(
          409,
          "CONFLICT",
          "이어할 세션 없음 — retry 사용 (NO_HARNESS_SESSION)"
        );
      }
      if (body.harness && body.harness !== subLog.harness) {
        throw new HttpApiError(
          400,
          "INVALID_PATH",
          "하네스 변경 Resume은 금지됩니다 (RESUME_HARNESS_MISMATCH)"
        );
      }
      if (subLog.taskId) {
        const taskRow = db.getTask(sessionId, subLog.taskId);
        if (taskRow?.status === "running") {
          throw new HttpApiError(
            409,
            "CONFLICT",
            "실행 중인 태스크는 먼저 중지(kill)해야 합니다 (TASK_RUNNING)"
          );
        }
      }
    }

    const jobId = jobRegistry.startJob({
      kind: "subagent_action",
      projectRoot,
      sessionId,
      run: async () => {
        const actionRes = await runSubagentControlAction({
          projectRoot,
          homeDir: context.homeDir,
          sessionId,
          subSessionId,
          action: body.action,
          prompt: body.prompt,
          harness: body.harness,
          model: body.model,
          waitForCompletion: true,
        });
        await watcher.forceBroadcastProject(projectRoot);
        return actionRes;
      },
    });

    const response: SubagentActionResponse = {
      ok: true,
      jobId,
      action: body.action,
    };
    sendJson(res, 200, response);
    return true;
  }

  return false;
}
