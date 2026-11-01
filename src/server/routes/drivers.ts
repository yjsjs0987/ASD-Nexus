/**
 * Driver routes (/api/drivers/*) — GUI_ARCHITECTURE.md 6.2.3.
 */

import type * as http from "node:http";
import * as path from "node:path";
import {
  attachDriver,
  getActiveDriver,
  listDrivers,
  recordCliRecentSession,
  runDriverTurn,
  type HarnessId,
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
  AttachDriverRequest,
  AttachDriverResponse,
  CancelDriverRequest,
  CancelDriverResponse,
  DriverPromptRequest,
  DriverPromptResponse,
  GetDriversResponse,
} from "../../shared/protocol.ts";

interface ActiveSessionDriverTurn {
  jobId: string;
  runId: string;
  driverId: string;
  abortController: AbortController;
}

const activeSessionTurns = new Map<string, ActiveSessionDriverTurn>();

function makeSessionTurnKey(projectRoot: string, sessionId: string): string {
  const normRoot =
    process.platform === "win32"
      ? path.resolve(projectRoot).toLowerCase()
      : path.resolve(projectRoot);
  return `${normRoot}::${sessionId}`;
}

export async function handleDriversRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  context: ServerContext,
  watcher: StateWatcher,
  jobRegistry: JobRegistry
): Promise<boolean> {
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/api/drivers") {
    const projectRoot = validateProjectRoot(
      parsedUrl.searchParams.get("projectRoot")
    );
    const sessionId = validateSessionId(
      parsedUrl.searchParams.get("sessionId")
    );
    const db = context.getDb(projectRoot);
    const drivers = listDrivers(db, sessionId);
    const active = getActiveDriver(db, sessionId);
    const response: GetDriversResponse = {
      activeDriverId: active?.driver_id ?? null,
      drivers,
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/drivers/attach") {
    const body = await readJsonBody<AttachDriverRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const harness = (body.harness || "claude-code") as HarnessId;
    const source = body.source || "gui-headless";

    const db = context.getDb(projectRoot);
    if (!db.getSession(sessionId)) {
      throw new HttpApiError(
        404,
        "NOT_FOUND",
        `Session not found: ${sessionId}`
      );
    }

    const attached = attachDriver(db, {
      projectRoot,
      sessionId,
      harness,
      model: body.model?.trim() || null,
      harnessSessionId: body.harnessSessionId?.trim() || null,
      source,
    });

    if (body.harnessSessionId?.trim()) {
      try {
        recordCliRecentSession(
          projectRoot,
          {
            harnessSessionId: body.harnessSessionId.trim(),
            harness,
            model: body.model?.trim() || null,
            asdSessionId: sessionId,
          },
          { forceCreateDir: true }
        );
      } catch {
        // Ignore cli-recent update errors
      }
    }

    await watcher.forceBroadcastProject(projectRoot);
    const response: AttachDriverResponse = {
      ok: true,
      driver: attached.driver,
      previousDriverId: attached.previousDriverId,
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/drivers/prompt") {
    const body = await readJsonBody<DriverPromptRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);
    const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!rawPrompt) {
      throw new HttpApiError(400, "INVALID_PATH", "prompt is required");
    }

    const db = context.getDb(projectRoot);
    const activeDriver = getActiveDriver(db, sessionId);
    if (!activeDriver) {
      throw new HttpApiError(
        409,
        "CONFLICT",
        "드라이버를 먼저 선택하세요 (NO_ACTIVE_DRIVER)"
      );
    }

    const turnKey = makeSessionTurnKey(projectRoot, sessionId);
    if (activeSessionTurns.has(turnKey)) {
      throw new HttpApiError(
        409,
        "CONFLICT",
        "이미 실행 중인 드라이버 턴이 있습니다 (DRIVER_BUSY)"
      );
    }

    const effectivePrompt =
      body.mode === "plan"
        ? `asd_plan MCP 도구로 태스크 계획을 작성하라 (sessionId: ${sessionId}).\n\n${rawPrompt}`
        : rawPrompt;

    const placeholderRunId = `run-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    let streamOffset = 0;

    // Reserve turnKey synchronously before starting async job so concurrent HTTP calls get 409 immediately
    const placeholderAbort = new AbortController();
    activeSessionTurns.set(turnKey, {
      jobId: "",
      runId: placeholderRunId,
      driverId: activeDriver.driver_id,
      abortController: placeholderAbort,
    });

    const jobId = jobRegistry.startJob({
      kind: "driver_turn",
      projectRoot,
      sessionId,
      runId: placeholderRunId,
      run: async ({ signal }) => {
        const combinedAbort = new AbortController();
        const onAbort = () => combinedAbort.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        placeholderAbort.signal.addEventListener("abort", onAbort, {
          once: true,
        });

        try {
          const result = await runDriverTurn({
            projectRoot,
            homeDir: context.homeDir,
            db,
            sessionId,
            prompt: effectivePrompt,
            driverId: activeDriver.driver_id,
            injectBriefing: "auto",
            signal: combinedAbort.signal,
            commandRunner: context.commandRunner,
            onOutput: (chunk) => {
              const prevOffset = streamOffset;
              streamOffset += Buffer.byteLength(chunk, "utf8");
              watcher.broadcastToProject(projectRoot, {
                type: "driver_output_chunk",
                projectRoot,
                sessionId,
                runId: placeholderRunId,
                offset: prevOffset,
                chunk,
              });
            },
          });

          watcher.broadcastToProject(projectRoot, {
            type: "log_closed",
            projectRoot,
            sessionId,
            runId: placeholderRunId,
            reason: "deleted",
          });
          await watcher.forceBroadcastProject(projectRoot);
          return {
            runId: result.runId,
            exitCode: result.exitCode,
            harnessSessionId: result.harnessSessionId,
          };
        } finally {
          signal.removeEventListener("abort", onAbort);
          placeholderAbort.signal.removeEventListener("abort", onAbort);
          activeSessionTurns.delete(turnKey);
        }
      },
    });

    const existingTurn = activeSessionTurns.get(turnKey);
    if (existingTurn) {
      existingTurn.jobId = jobId;
    }

    const response: DriverPromptResponse = {
      ok: true,
      jobId,
      runId: placeholderRunId,
      driverId: activeDriver.driver_id,
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/drivers/cancel") {
    const body = await readJsonBody<CancelDriverRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = validateSessionId(body.sessionId);

    const turnKey = makeSessionTurnKey(projectRoot, sessionId);
    const activeTurn = activeSessionTurns.get(turnKey);
    if (activeTurn) {
      activeTurn.abortController.abort();
      if (activeTurn.jobId) {
        jobRegistry.cancelJob(activeTurn.jobId);
      }
      activeSessionTurns.delete(turnKey);
    }

    const response: CancelDriverResponse = { ok: true };
    sendJson(res, 200, response);
    return true;
  }

  return false;
}
