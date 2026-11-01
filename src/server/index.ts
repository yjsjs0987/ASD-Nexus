import {
  AUTH_COOKIE_NAME,
  generateAuthToken,
  isAllowedHost,
  safeTokenEquals,
  sendErrorJson,
  verifyRequestSecurity,
} from "./auth.ts";
import {
  HttpApiError,
  ServerContext,
  validateProjectRoot,
  validateSessionId,
} from "./context.ts";
import { ASD_VERSION, type CommandRunner } from "./core-api.ts";
import { JobRegistry } from "./jobs/job-registry.ts";
import {
  PtyManager,
  type NodePtyModule,
} from "./pty/pty-manager.ts";
import { handleDriversRoutes } from "./routes/drivers.ts";
import { handleProjectsRoutes } from "./routes/projects.ts";
import { handleSessionsRoutes } from "./routes/sessions.ts";
import { handleTasksRoutes } from "./routes/tasks.ts";
import { handleTranscriptsRoutes } from "./routes/transcripts.ts";
import {
  collectEnrichedSnapshot,
  StateWatcher,
} from "./watcher/state-watcher.ts";
import type {
  ClientWsMessage,
  ServerReadyMessage,
  ServerWsMessage,
} from "../shared/protocol.ts";

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

export interface StartGuiServerOptions {
  port?: number;
  homeDir?: string;
  noOpen?: boolean;
  isDevMode?: boolean;
  webDistDir?: string;
  quietReadyLog?: boolean;
  watcherDebounceMs?: number;
  commandRunner?: CommandRunner;
  forceDisablePty?: boolean;
  ptyModuleOverride?: NodePtyModule | null;
  ptyGracePeriodMs?: number;
}

export interface GuiServerHandle {
  port: number;
  token: string;
  url: string;
  context: ServerContext;
  watcher: StateWatcher;
  jobRegistry: JobRegistry;
  ptyManager: PtyManager;
  httpServer: http.Server;
  wss: WebSocketServer;
  broadcast: (msg: ServerWsMessage) => void;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function resolveDefaultWebDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidateDist = path.resolve(here, "..", "web");
  if (fs.existsSync(path.join(candidateDist, "index.html"))) {
    return candidateDist;
  }
  const rootDistWeb = path.resolve(here, "..", "..", "dist", "web");
  if (fs.existsSync(path.join(rootDistWeb, "index.html"))) {
    return rootDistWeb;
  }
  return path.resolve(here, "..", "web");
}

export async function readJsonBody<T = Record<string, unknown>>(
  req: http.IncomingMessage
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 10 * 1024 * 1024) {
        reject(new HttpApiError(400, "INVALID_PATH", "Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new HttpApiError(400, "CORE_ERROR", "Malformed JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown
): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      child_process.spawn("cmd", ["/c", "start", "", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else if (process.platform === "darwin") {
      child_process.spawn("open", [url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      child_process.spawn("xdg-open", [url], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
  } catch {
    // Ignore browser launch errors
  }
}

export async function startGuiServer(
  options?: StartGuiServerOptions
): Promise<GuiServerHandle> {
  const requestedPort = options?.port ?? 4173;
  const token = generateAuthToken();
  const context = new ServerContext({
    homeDir: options?.homeDir,
    commandRunner: options?.commandRunner,
  });
  const watcher = new StateWatcher(context, {
    debounceMs: options?.watcherDebounceMs,
  });
  const clients = new Set<WebSocket>();

  const broadcast = (msg: ServerWsMessage) => {
    const payload = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  };

  const jobRegistry = new JobRegistry((projectRoot, msg) => {
    watcher.broadcastToProject(projectRoot, msg);
  });
  const ptyManager = new PtyManager({
    forceDisablePty: options?.forceDisablePty,
    ptyModuleOverride: options?.ptyModuleOverride,
    gracePeriodMs: options?.ptyGracePeriodMs,
  });

  const webDistDir = options?.webDistDir ?? resolveDefaultWebDistDir();
  const isDevMode = Boolean(
    options?.isDevMode ?? process.env.ASD_GUI_DEV === "1"
  );

  let boundPort = requestedPort;

  const httpServer = http.createServer(async (req, res) => {
    try {
      const rawUrl = req.url || "/";
      const parsedUrl = new URL(rawUrl, `http://127.0.0.1:${boundPort}`);
      const pathname = parsedUrl.pathname;

      if (!isAllowedHost(req.headers.host, boundPort)) {
        sendErrorJson(
          res,
          403,
          "FORBIDDEN_ORIGIN",
          `Forbidden Host header: ${req.headers.host ?? "(missing)"}`
        );
        return;
      }

      const queryToken = parsedUrl.searchParams.get("token");
      if (
        req.method === "GET" &&
        queryToken !== null &&
        !pathname.startsWith("/api/")
      ) {
        if (!safeTokenEquals(token, queryToken)) {
          sendErrorJson(
            res,
            401,
            "AUTH_REQUIRED",
            "Invalid token query parameter"
          );
          return;
        }
        parsedUrl.searchParams.delete("token");
        const cleanLocation =
          parsedUrl.pathname +
          (parsedUrl.searchParams.toString()
            ? `?${parsedUrl.searchParams.toString()}`
            : "");
        res.writeHead(302, {
          "Set-Cookie": `${AUTH_COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          Location: cleanLocation || "/",
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }

      if (pathname.startsWith("/api/")) {
        const guard = verifyRequestSecurity(req, {
          token,
          port: boundPort,
          isDevMode,
        });
        if (!guard.allowed) {
          sendErrorJson(
            res,
            guard.statusCode ?? 401,
            guard.error?.code ?? "AUTH_REQUIRED",
            guard.error?.message ?? "Unauthorized"
          );
          return;
        }

        if (
          await handleProjectsRoutes(req, res, parsedUrl, context, watcher)
        ) {
          return;
        }

        if (
          await handleSessionsRoutes(
            req,
            res,
            parsedUrl,
            context,
            watcher,
            jobRegistry
          )
        ) {
          return;
        }

        if (
          await handleDriversRoutes(
            req,
            res,
            parsedUrl,
            context,
            watcher,
            jobRegistry
          )
        ) {
          return;
        }

        if (
          await handleTasksRoutes(
            req,
            res,
            parsedUrl,
            context,
            watcher,
            jobRegistry,
            ptyManager
          )
        ) {
          return;
        }

        if (
          await handleTranscriptsRoutes(
            req,
            res,
            parsedUrl,
            context,
            ptyManager
          )
        ) {
          return;
        }

        sendErrorJson(
          res,
          404,
          "NOT_FOUND",
          `API route not found: ${req.method} ${pathname}`
        );
        return;
      }

      if (req.method === "GET" || req.method === "HEAD") {
        const relPath =
          pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
        const candidatePath = path.resolve(webDistDir, relPath);
        const relCheck = path.relative(webDistDir, candidatePath);
        if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
          sendErrorJson(res, 400, "INVALID_PATH", "Invalid static file path");
          return;
        }

        let targetFile = candidatePath;
        if (
          !fs.existsSync(targetFile) ||
          fs.statSync(targetFile).isDirectory()
        ) {
          targetFile = path.join(webDistDir, "index.html");
        }

        if (fs.existsSync(targetFile) && fs.statSync(targetFile).isFile()) {
          const ext = path.extname(targetFile).toLowerCase();
          const contentType = MIME_TYPES[ext] || "application/octet-stream";
          const content = fs.readFileSync(targetFile);
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control":
              ext === ".html" ? "no-cache" : "public, max-age=3600",
          });
          res.end(req.method === "HEAD" ? undefined : content);
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><head><meta charset="utf-8"><title>ASD GUI</title></head><body><div id="root">ASD GUI v${ASD_VERSION}</div></body></html>`
        );
        return;
      }

      sendErrorJson(res, 404, "NOT_FOUND", "Not found");
    } catch (err: unknown) {
      if (err instanceof HttpApiError) {
        sendErrorJson(res, err.statusCode, err.code, err.message);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("MERGE_LOCK_TIMEOUT") || message.includes("merge.lock")) {
        sendErrorJson(
          res,
          423,
          "LOCKED",
          "다른 프로세스(CLI 등)가 병합 중입니다 (merge.lock timeout)"
        );
        return;
      }
      sendErrorJson(res, 500, "CORE_ERROR", message);
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const rawUrl = req.url || "/";
    const parsedUrl = new URL(rawUrl, `http://127.0.0.1:${boundPort}`);
    if (parsedUrl.pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const guard = verifyRequestSecurity(req, {
      token,
      port: boundPort,
      isDevMode,
    });
    if (!guard.allowed) {
      const status = guard.statusCode ?? 401;
      const statusText = status === 403 ? "Forbidden" : "Unauthorized";
      const body = JSON.stringify({
        ok: false,
        error: guard.error ?? {
          code: "AUTH_REQUIRED",
          message: "Unauthorized",
        },
      });
      socket.write(
        `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(
          body
        )}\r\n\r\n${body}`
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    ws.on("message", async (rawData) => {
      try {
        const msg = JSON.parse(String(rawData)) as ClientWsMessage;
        if (msg.type === "subscribe_project") {
          const projectRoot = validateProjectRoot(msg.projectRoot);
          watcher.subscribeProject(ws, projectRoot);
          watcher.seedInitialBaseline(projectRoot);
          const snapshot = await collectEnrichedSnapshot(
            projectRoot,
            context.homeDir
          );
          const reply: ServerWsMessage = {
            type: "state_updated",
            projectRoot,
            snapshot,
          };
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(reply));
          }
        } else if (msg.type === "unsubscribe_project") {
          const projectRoot = validateProjectRoot(msg.projectRoot);
          watcher.unsubscribeProject(ws, projectRoot);
        } else if (msg.type === "subscribe_log") {
          const projectRoot = validateProjectRoot(msg.projectRoot);
          const sessionId = validateSessionId(msg.sessionId);
          watcher.subscribeLog(ws, {
            projectRoot,
            sessionId,
            subSessionId: msg.subSessionId,
            runId: msg.runId,
            fromOffset: msg.fromOffset,
          });
        } else if (msg.type === "unsubscribe_log") {
          const projectRoot = validateProjectRoot(msg.projectRoot);
          const sessionId = validateSessionId(msg.sessionId);
          watcher.unsubscribeLog(ws, {
            projectRoot,
            sessionId,
            subSessionId: msg.subSessionId,
            runId: msg.runId,
          });
        } else if (
          msg.type === "pty_spawn" ||
          msg.type === "pty_input" ||
          msg.type === "pty_resize" ||
          msg.type === "pty_kill"
        ) {
          await ptyManager.handleMessage(ws, msg);
        }
      } catch (err: unknown) {
        const errorMsg: ServerWsMessage = {
          type: "error",
          code: err instanceof HttpApiError ? err.code : "CORE_ERROR",
          message: err instanceof Error ? err.message : String(err),
        };
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(errorMsg));
        }
      }
    });
    ws.on("close", () => {
      watcher.unsubscribeProject(ws);
      ptyManager.handleClientDisconnect(ws);
      clients.delete(ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      httpServer.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${requestedPort} is already in use on 127.0.0.1. Use --port 0 for automatic port assignment or specify another port.`
          )
        );
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      httpServer.removeListener("error", onError);
      const addr = httpServer.address() as AddressInfo;
      boundPort = addr.port;
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(requestedPort, "127.0.0.1");
  });

  const readyPayload: ServerReadyMessage = {
    type: "asd-gui-ready",
    port: boundPort,
    token,
  };
  const accessUrl = `http://127.0.0.1:${boundPort}/?token=${token}`;

  if (!options?.quietReadyLog) {
    process.stdout.write(JSON.stringify(readyPayload) + "\n");
    process.stdout.write(`ASD GUI Server listening at ${accessUrl}\n`);
  }

  if (!options?.noOpen && !options?.quietReadyLog) {
    openBrowser(accessUrl);
  }

  const close = async (): Promise<void> => {
    ptyManager.closeAll();
    watcher.close();
    for (const client of clients) {
      try {
        client.terminate();
      } catch {
        // Ignore
      }
    }
    clients.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    context.closeAll();
  };

  return {
    port: boundPort,
    token,
    url: accessUrl,
    context,
    watcher,
    jobRegistry,
    ptyManager,
    httpServer,
    wss,
    broadcast,
    close,
  };
}

export interface ParsedServerCliArgs {
  port: number;
  homeDir?: string;
  noOpen: boolean;
}

export function parseServerCliArgs(argv: string[]): ParsedServerCliArgs {
  let port = 4173;
  let homeDir: string | undefined;
  let noOpen = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-open") {
      noOpen = true;
    } else if (arg === "--port" || arg === "-p") {
      const next = argv[++i];
      if (next !== undefined) {
        const parsed = Number.parseInt(next, 10);
        if (Number.isFinite(parsed) && parsed >= 0) {
          port = parsed;
        }
      }
    } else if (arg.startsWith("--port=")) {
      const parsed = Number.parseInt(arg.slice("--port=".length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        port = parsed;
      }
    } else if (arg === "--home") {
      homeDir = argv[++i];
    } else if (arg.startsWith("--home=")) {
      homeDir = arg.slice("--home=".length);
    }
  }

  return { port, homeDir, noOpen };
}

const isMainEntry = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    const entry = path.resolve(process.argv[1]);
    const current = path.resolve(fileURLToPath(import.meta.url));
    return (
      entry === current ||
      entry.endsWith(path.join("dist", "server", "server.js"))
    );
  } catch {
    return false;
  }
};

if (isMainEntry()) {
  const cliArgs = parseServerCliArgs(process.argv.slice(2));
  startGuiServer(cliArgs).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
