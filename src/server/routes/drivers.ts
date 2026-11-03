/**
 * Driver routes (/api/drivers/*) — GUI_ARCHITECTURE.md 6.2.3.
 */

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import {
  attachDriver,
  getActiveDriver,
  listDrivers,
  parseDriverStreamLine,
  readCliRecentSessions,
  recordCliRecentSession,
  resolveSpawnCommand,
  runDriverTurn,
  setDriverHarnessSessionId,
  setForegroundSession,
  type CommandRunner,
  type DriverRow,
  type DriverStreamEvent,
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
import { appendGuiTurnMessage } from "./transcripts.ts";
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

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeSessionTurnKey(projectRoot: string, sessionId: string): string {
  const normRoot =
    process.platform === "win32"
      ? path.resolve(projectRoot).toLowerCase()
      : path.resolve(projectRoot);
  return `${normRoot}::${sessionId}`;
}

function normalizeBaseSessionId(raw: unknown): string {
  const val = typeof raw === "string" ? raw.trim() : "";
  const idx = val.indexOf("::");
  return validateSessionId(idx !== -1 ? val.slice(0, idx) : val);
}

function normalizeModelSlug(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.includes(" ")) {
    return trimmed
      .toLowerCase()
      .replace(/[()[\]]/g, " ")
      .trim()
      .replace(/\s+/g, "-");
  }
  return trimmed;
}

function normalizeDriverRow(d: DriverRow): DriverRow {
  const fixedHarness =
    d.harness_session_id && d.harness_session_id.startsWith("ses_")
      ? "opencode"
      : d.harness;
  const fixedModel = normalizeModelSlug(d.model);
  return {
    ...d,
    harness: fixedHarness,
    model: fixedModel,
  };
}

/**
 * Resolves a CLI binary on Windows, including `.cmd` shims that wrap `.exe` or `.js` files,
 * so `shell: false` can be used safely with multiline prompts.
 */
function resolveWindowsCliBinary(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined>
): { command: string; args: string[]; shell: boolean } {
  const base = resolveSpawnCommand(cmd, args, env);
  if (process.platform !== "win32" || !base.shell) {
    return base;
  }

  // If resolveSpawnCommand returned a .cmd/.bat with shell: true, check if the .cmd wraps a .exe or .js
  if (/\.(cmd|bat)$/i.test(base.command) && fs.existsSync(base.command)) {
    try {
      const shimContent = fs.readFileSync(base.command, "utf8");
      const shimDir = path.dirname(base.command);

      // Check for .exe reference inside .cmd shim
      const exeMatch = shimContent.match(
        /"%(?:~)?dp0%?\\([^"]+\.exe)"\s+%\*/i
      );
      if (exeMatch?.[1]) {
        const exePath = path.resolve(shimDir, exeMatch[1]);
        if (fs.existsSync(exePath)) {
          return { command: exePath, args, shell: false };
        }
      }

      // Check for node_modules .js/.mjs/.cjs reference inside .cmd shim
      const jsMatch = shimContent.match(
        /"%(?:~)?dp0%?\\([^"]+\.(?:c?m?js))"\s+%\*/i
      );
      if (jsMatch?.[1]) {
        const jsPath = path.resolve(shimDir, jsMatch[1]);
        if (fs.existsSync(jsPath)) {
          return {
            command: process.execPath,
            args: [jsPath, ...args],
            shell: false,
          };
        }
      }
    } catch {
      // Fallback
    }
  }

  // If shell: true is unavoidable on Windows, sanitize newlines in args so cmd.exe doesn't truncate
  const safeArgs = base.args.map((a) =>
    a.includes("\n") || a.includes("\r") ? a.replace(/\r?\n+/g, " ") : a
  );
  return { command: base.command, args: safeArgs, shell: true };
}

/**
 * Production CommandRunner for GUI driver turns:
 * - Prevents hardcoded default models (`glm-5`, `claude-sonnet-4-6`) from overriding user's CLI config when driver.model is null
 * - Fixes `claude -p` argument ordering & passes prompt via stdin safely for any prompt length
 * - Parses JSON/JSONL output from `claude -p --output-format json` and `opencode run --format json`
 *   into clean human-readable assistant text for live streaming and transcript persistence
 */
function createGuiDriverCommandRunner(options: {
  harness: HarnessId;
  userExplicitModel: string | null;
  onStreamEvent: (ev: DriverStreamEvent) => void;
  onAssistantText: (textChunk: string) => void;
  onErrorText: (errChunk: string) => void;
  onSessionId: (sid: string) => void;
}): CommandRunner {
  return {
    run(cmd, rawArgs, opts) {
      return new Promise((resolve) => {
        let args = [...rawArgs];
        let stdinPayload: string | undefined;

        // 0. For Antigravity (`agy`), replace legacy `--resume` with `--conversation`
        if (cmd === "agy" || options.harness === "antigravity") {
          args = args.map((a) => (a === "--resume" ? "--conversation" : a));
        }

        // 1. Strip auto-injected fallback `--model` if the driver had no explicit model set,
        //    or if opencode was given a model without `provider/` prefix
        const mIdx = args.indexOf("--model");
        if (mIdx !== -1 && mIdx + 1 < args.length) {
          const passedModel = args[mIdx + 1] ?? "";
          const shouldStripModel =
            !options.userExplicitModel ||
            (options.harness === "opencode" && !passedModel.includes("/")) ||
            passedModel === "gemini-3.1-pro-high" ||
            passedModel.includes(" ");
          if (shouldStripModel) {
            args.splice(mIdx, 2);
          } else if (options.userExplicitModel) {
            args[mIdx + 1] = options.userExplicitModel;
          }
        }

        // 2. For Claude Code (`claude`), always pass prompt via stdin and put `--resume <id>` before `-p`
        if (cmd === "claude" || options.harness === "claude-code") {
          const pIdx = args.indexOf("-p");
          if (pIdx !== -1 && pIdx + 1 < args.length) {
            const nextArg = args[pIdx + 1] ?? "";
            if (!nextArg.startsWith("-")) {
              stdinPayload = nextArg;
              args.splice(pIdx + 1, 1);
            }
          }
          const pFlagIdx = args.indexOf("-p");
          if (pFlagIdx !== -1) {
            args.splice(pFlagIdx, 1);
            args.push("-p");
          }
          if (!args.includes("--dangerously-skip-permissions")) {
            args.push("--dangerously-skip-permissions");
          }
        }

        // 3. For Antigravity (`agy`), pass `--dangerously-skip-permissions` in headless mode
        if (cmd === "agy" || options.harness === "antigravity") {
          if (!args.includes("--dangerously-skip-permissions")) {
            args.push("--dangerously-skip-permissions");
          }
        }

        const resolved = resolveWindowsCliBinary(cmd, args, opts.env);
        const child = child_process.spawn(resolved.command, resolved.args, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: [
            stdinPayload !== undefined ? "pipe" : "ignore",
            "pipe",
            "pipe",
          ],
          windowsHide: true,
          shell: resolved.shell,
          detached: process.platform !== "win32",
        });

        if (stdinPayload !== undefined && child.stdin) {
          try {
            child.stdin.write(stdinPayload, "utf8");
            child.stdin.end();
          } catch {
            // Ignore broken pipe
          }
        }

        opts.onSpawn?.(child.pid ?? 0);
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");

        let stdoutLineBuf = "";
        const processStdoutLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
            try {
              const obj = JSON.parse(trimmed) as Record<string, unknown>;
              const sid =
                (typeof obj.session_id === "string" && obj.session_id) ||
                (typeof obj.sessionID === "string" && obj.sessionID) ||
                (typeof obj.sessionId === "string" && obj.sessionId) ||
                (typeof obj.conversation_id === "string" && obj.conversation_id) ||
                (typeof obj.conversationId === "string" && obj.conversationId) ||
                (typeof obj.thread_id === "string" && obj.thread_id) ||
                (typeof obj.chat_id === "string" && obj.chat_id) ||
                null;
              if (sid) {
                options.onSessionId?.(sid);
              }

              // Antigravity (`agy -p --output-format json`) result:
              // {"conversation_id":"...","status":"SUCCESS","response":"..."}
              if (
                typeof obj.response === "string" &&
                (typeof obj.conversation_id === "string" ||
                  typeof obj.status === "string")
              ) {
                if (obj.response.trim()) {
                  options.onStreamEvent({
                    type: "text",
                    harness: options.harness,
                    text: obj.response,
                    timestamp: Date.now(),
                  });
                  options.onAssistantText?.(obj.response);
                }
                return;
              }

              if (obj.type === "error") {
                const errObj = obj.error as Record<string, unknown> | undefined;
                const msg =
                  (errObj &&
                    typeof errObj.message === "string" &&
                    errObj.message) ||
                  JSON.stringify(obj.error ?? obj);
                options.onErrorText?.(`${msg}\n`);
                return;
              }
            } catch {
              // Fall through to Core's parseDriverStreamLine
            }
          }

          // Delegate structured stream parsing (thinking, tool_use, tool_result, text) to Core v2.4.0
          const events = parseDriverStreamLine(trimmed, options.harness);
          for (const ev of events) {
            if (ev.harnessSessionId) {
              options.onSessionId(ev.harnessSessionId);
            }
            options.onStreamEvent(ev);
            if (ev.type === "text" && ev.text) {
              options.onAssistantText(ev.text);
            }
          }
        };

        child.stdout?.on("data", (chunk: string) => {
          opts.onStdout(chunk);
          stdoutLineBuf += chunk;
          const lines = stdoutLineBuf.split(/\r?\n/);
          stdoutLineBuf = lines.pop() ?? "";
          for (const l of lines) {
            processStdoutLine(l);
          }
        });

        child.stderr?.on("data", (chunk: string) => {
          opts.onStderr(chunk);
          options.onErrorText(chunk);
        });

        child.on("close", (code) => {
          if (stdoutLineBuf.trim()) {
            processStdoutLine(stdoutLineBuf);
            stdoutLineBuf = "";
          }
          resolve({ exitCode: code ?? -1, pid: child.pid ?? -1 });
        });

        child.on("error", (err) => {
          const msg = `[asd:spawn-error] Failed to spawn '${resolved.command}': ${err.message}\n`;
          opts.onStderr(msg);
          options.onErrorText(msg);
          resolve({ exitCode: -1, pid: child.pid ?? -1 });
        });
      });
    },
  };
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
    const sessionId = normalizeBaseSessionId(
      parsedUrl.searchParams.get("sessionId")
    );
    const db = context.getDb(projectRoot);
    const drivers = listDrivers(db, sessionId).map(normalizeDriverRow);
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
    const sessionId = normalizeBaseSessionId(body.sessionId);
    const rawHarnessSid = body.harnessSessionId?.trim() || null;
    const harness = (
      rawHarnessSid?.startsWith("ses_")
        ? "opencode"
        : body.harness || "claude-code"
    ) as HarnessId;
    const normalizedModel = normalizeModelSlug(body.model);
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
      model: normalizedModel,
      harnessSessionId: rawHarnessSid,
      source,
    });

    if (rawHarnessSid) {
      try {
        recordCliRecentSession(
          projectRoot,
          {
            harnessSessionId: rawHarnessSid,
            harness,
            model: normalizedModel,
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
      driver: normalizeDriverRow(attached.driver),
      previousDriverId: attached.previousDriverId,
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/drivers/prompt") {
    const body = await readJsonBody<DriverPromptRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = normalizeBaseSessionId(body.sessionId);
    const rawPrompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!rawPrompt) {
      throw new HttpApiError(400, "INVALID_PATH", "prompt is required");
    }

    const db = context.getDb(projectRoot);
    const sessionRow = db.getSession(sessionId);
    if (!sessionRow) {
      throw new HttpApiError(404, "NOT_FOUND", `Session not found: ${sessionId}`);
    }

    const history = listDrivers(db, sessionId);
    let activeDriver = getActiveDriver(db, sessionId);

    // If caller specified a selected driverId that differs from current activeDriver, switch to it
    const requestedDriverId =
      typeof body.driverId === "string" && body.driverId.trim()
        ? body.driverId.trim()
        : null;
    if (requestedDriverId && activeDriver?.driver_id !== requestedDriverId) {
      const targetDriver = history.find((d) => d.driver_id === requestedDriverId);
      if (targetDriver) {
        const normalizedTarget = normalizeDriverRow(targetDriver);
        const reattached = attachDriver(db, {
          projectRoot,
          sessionId,
          harness: normalizedTarget.harness as HarnessId,
          model: normalizedTarget.model,
          harnessSessionId: normalizedTarget.harness_session_id,
          source: "gui-headless",
        });
        activeDriver = reattached.driver;
      }
    }

    if (!activeDriver) {
      const lastDriver = history[0] ? normalizeDriverRow(history[0]) : null;
      const fallbackSid = lastDriver
        ? lastDriver.harness_session_id
        : (sessionRow.harness_session_id ?? null);
      const fallbackHarness = (
        fallbackSid?.startsWith("ses_")
          ? "opencode"
          : lastDriver?.harness || sessionRow.main_harness || "claude-code"
      ) as HarnessId;
      const fallbackModel = normalizeModelSlug(
        lastDriver ? lastDriver.model : (sessionRow.main_model ?? null)
      );
      const reattached = attachDriver(db, {
        projectRoot,
        sessionId,
        harness: fallbackHarness,
        model: fallbackModel,
        harnessSessionId: fallbackSid,
        source: "gui-headless",
      });
      activeDriver = reattached.driver;
    }

    // Auto-heal mismatched harness / session ID / display model name before running
    const healedModel = normalizeModelSlug(activeDriver.model);
    let healedHarness = activeDriver.harness as HarnessId;
    let healedSid = activeDriver.harness_session_id ?? null;

    if (healedSid?.startsWith("ses_") && healedHarness !== "opencode") {
      healedHarness = "opencode";
    } else if (
      healedHarness === "claude-code" &&
      healedSid &&
      !UUID_REGEX.test(healedSid)
    ) {
      healedSid = null;
    } else if (
      healedHarness === "opencode" &&
      healedSid &&
      !healedSid.startsWith("ses_")
    ) {
      healedSid = null;
    }

    if (
      healedHarness !== activeDriver.harness ||
      healedModel !== activeDriver.model ||
      healedSid !== (activeDriver.harness_session_id ?? null)
    ) {
      const reattached = attachDriver(db, {
        projectRoot,
        sessionId,
        harness: healedHarness,
        model: healedModel,
        harnessSessionId: healedSid,
        source: "gui-headless",
      });
      activeDriver = reattached.driver;
    }

    if (sessionRow.phase === "done") {
      db.updateSessionPhase(sessionId, "running");
    }
    try {
      setForegroundSession({ db, projectRoot, sessionId });
    } catch {
      // Ignore PLAN.md sync error before turn
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
    const turnStartedAt = Date.now();
    const driverAtStart = activeDriver;

    // Persist user prompt immediately into GUI turn log so Thread shows it across reloads
    appendGuiTurnMessage(
      projectRoot,
      [
        driverAtStart.driver_id,
        driverAtStart.harness_session_id ?? "",
        sessionId,
      ],
      {
        role: "user",
        text: rawPrompt,
        timestamp: new Date(turnStartedAt).toISOString(),
      }
    );

    // Reserve turnKey synchronously before starting async job so concurrent HTTP calls get 409 immediately
    const placeholderAbort = new AbortController();
    activeSessionTurns.set(turnKey, {
      jobId: "",
      runId: placeholderRunId,
      driverId: driverAtStart.driver_id,
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

        let assistantOutput = "";
        let errorOutput = "";

        const emitStreamChunk = (chunk: string) => {
          if (!chunk) return;
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
        };

        try {
          let detectedHarnessSid: string | null = null;
          const emitStreamEvent = (event: DriverStreamEvent) => {
            watcher.broadcastToProject(projectRoot, {
              type: "driver_stream_event",
              projectRoot,
              sessionId,
              runId: placeholderRunId,
              event,
            });
          };

          const customRunner =
            context.commandRunner ??
            createGuiDriverCommandRunner({
              harness: driverAtStart.harness as HarnessId,
              userExplicitModel: driverAtStart.model,
              onStreamEvent: emitStreamEvent,
              onAssistantText: (text) => {
                // Prevent duplicate full result text if deltas already streamed the same text
                if (assistantOutput && assistantOutput.trim() === text.trim()) {
                  return;
                }
                assistantOutput += text;
                emitStreamChunk(text);
              },
              onErrorText: (text) => {
                errorOutput += text;
                emitStreamChunk(text);
              },
              onSessionId: (sid) => {
                if (sid) detectedHarnessSid = sid;
              },
            });

          const result = await runDriverTurn({
            projectRoot,
            homeDir: context.homeDir,
            db,
            sessionId,
            prompt: effectivePrompt,
            driverId: driverAtStart.driver_id,
            injectBriefing: context.commandRunner
              ? "auto"
              : body.mode === "plan"
                ? "auto"
                : "never",
            signal: combinedAbort.signal,
            streamJson: true,
            commandRunner: customRunner,
            onEvent: context.commandRunner ? emitStreamEvent : undefined,
            onOutput: context.commandRunner
              ? (chunk) => {
                  assistantOutput += chunk;
                  emitStreamChunk(chunk);
                }
              : undefined,
          });

          let finalHarnessSid =
            result.harnessSessionId ??
            detectedHarnessSid ??
            driverAtStart.harness_session_id ??
            null;
          if (!result.harnessSessionId && detectedHarnessSid && !driverAtStart.harness_session_id) {
            try {
              setDriverHarnessSessionId(db, {
                projectRoot,
                driverId: driverAtStart.driver_id,
                harnessSessionId: detectedHarnessSid,
              });
            } catch {
              // Ignore if already set
            }
          }

          if (!result.harnessSessionId && !driverAtStart.harness_session_id) {
            try {
              const recent = readCliRecentSessions(projectRoot, {
                syncLocalTranscripts: true,
                homeDir: context.homeDir,
              });
              const candidate = recent.find(
                (r) =>
                  r.harness === driverAtStart.harness &&
                  (!r.asdSessionId || r.asdSessionId === sessionId) &&
                  r.updatedAt >= turnStartedAt - 5000
              );
              if (candidate?.harnessSessionId) {
                finalHarnessSid = candidate.harnessSessionId;
                setDriverHarnessSessionId(db, {
                  projectRoot,
                  driverId: driverAtStart.driver_id,
                  harnessSessionId: candidate.harnessSessionId,
                });
              }
            } catch {
              // Ignore fallback session ID detection errors
            }
          }

          const finalReplyText = assistantOutput.trim() || errorOutput.trim();
          if (finalReplyText) {
            appendGuiTurnMessage(
              projectRoot,
              [driverAtStart.driver_id, finalHarnessSid ?? "", sessionId],
              {
                role: "assistant",
                text: finalReplyText,
                timestamp: new Date().toISOString(),
              }
            );
          }

          try {
            setForegroundSession({ db, projectRoot, sessionId });
          } catch {
            // Ignore PLAN.md sync error after turn
          }

          watcher.broadcastToProject(projectRoot, {
            type: "log_closed",
            projectRoot,
            sessionId,
            runId: placeholderRunId,
            reason: "deleted",
          });
          await watcher.forceBroadcastProject(projectRoot);

          if (
            !context.commandRunner &&
            result.exitCode !== 0 &&
            !assistantOutput.trim()
          ) {
            throw new Error(
              errorOutput.trim() ||
                `드라이버 실행 실패 (exitCode: ${result.exitCode})`
            );
          }

          return {
            runId: result.runId,
            exitCode: result.exitCode,
            harnessSessionId: finalHarnessSid,
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
      driverId: driverAtStart.driver_id,
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/drivers/cancel") {
    const body = await readJsonBody<CancelDriverRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const sessionId = normalizeBaseSessionId(body.sessionId);

    const turnKey = makeSessionTurnKey(projectRoot, sessionId);
    const activeTurn = activeSessionTurns.get(turnKey);
    if (activeTurn) {
      activeTurn.abortController.abort();
      jobRegistry.cancelByRunId(sessionId, activeTurn.runId);
      activeSessionTurns.delete(turnKey);
    }

    const response: CancelDriverResponse = { ok: true };
    sendJson(res, 200, response);
    return true;
  }

  return false;
}
