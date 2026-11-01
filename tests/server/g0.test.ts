/**
 * G0 Foundation Tests (tests/server/g0.test.ts)
 * Verifies DEV_PLAN.md G0 criteria in an isolated sandbox (--home + temporary git repo):
 * 1. Explicit `sessionId` requirement on `handlePlan` and fixture session/task creation
 * 2. Request without token -> 401 AUTH_REQUIRED
 * 3. Request with invalid Host or Origin -> 403 FORBIDDEN_ORIGIN
 * 4. Token cookie exchange (`/?token=<hex>`) -> 302 redirect + HttpOnly; SameSite=Strict cookie
 * 5. Authenticated `/api/projects` & `/api/projects/open` & Web empty screen HTML load
 * 6. WebSocket upgrade security (401 without token, 403 on bad Origin, `state_updated` with valid token)
 * 7. Bundled `dist/server/server.js` `--port 0 --no-open --home <dir>` ready JSON line on stdout
 */

import * as assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { handlePlan } from "../../src/server/core-api.ts";
import { startGuiServer, type GuiServerHandle } from "../../src/server/index.ts";
import type {
  ApiErrorEnvelope,
  GetProjectsResponse,
  OpenProjectResponse,
  ServerReadyMessage,
  ServerWsMessage,
} from "../../src/shared/protocol.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

function createTempGitProject(baseDir: string, name: string): string {
  const projDir = path.join(baseDir, name);
  fs.mkdirSync(projDir, { recursive: true });
  child_process.execFileSync("git", ["init"], { cwd: projDir, stdio: "ignore" });
  child_process.execFileSync("git", ["config", "user.email", "test@asd.local"], {
    cwd: projDir,
    stdio: "ignore",
  });
  child_process.execFileSync("git", ["config", "user.name", "ASD Test"], {
    cwd: projDir,
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(projDir, "README.md"), "# Sandbox\n", "utf8");
  child_process.execFileSync("git", ["add", "README.md"], {
    cwd: projDir,
    stdio: "ignore",
  });
  child_process.execFileSync("git", ["commit", "-m", "init"], {
    cwd: projDir,
    stdio: "ignore",
  });
  return projDir;
}

function rawHttpRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("G0 Foundation — Security, Core API, Bundle, and Web Load", () => {
  let tempRoot = "";
  let tempHome = "";
  let sandboxProject = "";
  let server: GuiServerHandle;

  before(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-g0-"));
    tempHome = path.join(tempRoot, "home");
    fs.mkdirSync(tempHome, { recursive: true });
    sandboxProject = createTempGitProject(tempRoot, "sandbox-app");

    // Seed session & task via core-api handlePlan with explicit sessionId
    const planOut = await handlePlan(
      {
        action: "create",
        sessionId: "asd-sandbox-sess-01",
        mainHarness: "claude-code",
        tasks: [
          {
            taskId: "T1.1",
            turn: 1,
            title: "Sandbox foundation task",
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "low",
            targetFiles: ["README.md"],
            acceptance: "Verify README exists",
          },
        ],
      },
      { projectRoot: sandboxProject, homeDir: tempHome }
    );
    assert.equal(planOut.sessionId, "asd-sandbox-sess-01");
    assert.equal(planOut.tasks.length, 1);

    server = await startGuiServer({
      port: 0,
      homeDir: tempHome,
      noOpen: true,
      quietReadyLog: true,
    });
  });

  after(async () => {
    if (server) {
      await server.close();
    }
    if (tempRoot && fs.existsSync(tempRoot)) {
      try {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        // Ignore Windows cleanup locks
      }
    }
  });

  it("enforces explicit sessionId in core-api handlePlan", async () => {
    await assert.rejects(
      async () => {
        await handlePlan(
          { action: "get", sessionId: "   " },
          { projectRoot: sandboxProject, homeDir: tempHome }
        );
      },
      /requires an explicit non-empty sessionId/
    );
  });

  it("rejects API requests without token with 401 AUTH_REQUIRED", async () => {
    const res = await rawHttpRequest({
      port: server.port,
      path: "/api/projects",
      headers: {
        Host: `127.0.0.1:${server.port}`,
      },
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body) as ApiErrorEnvelope;
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "AUTH_REQUIRED");
  });

  it("rejects requests with invalid Host header with 403 FORBIDDEN_ORIGIN", async () => {
    const res = await rawHttpRequest({
      port: server.port,
      path: "/api/projects",
      headers: {
        Host: "evil.example.com",
        Authorization: `Bearer ${server.token}`,
      },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body) as ApiErrorEnvelope;
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "FORBIDDEN_ORIGIN");
  });

  it("rejects requests with invalid Origin header with 403 FORBIDDEN_ORIGIN", async () => {
    const res = await rawHttpRequest({
      port: server.port,
      path: "/api/projects",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Origin: "http://evil.example.com",
        Authorization: `Bearer ${server.token}`,
      },
    });
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body) as ApiErrorEnvelope;
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "FORBIDDEN_ORIGIN");
  });

  it("exchanges /?token=<hex> for HttpOnly SameSite=Strict cookie and 302 redirects", async () => {
    const res = await rawHttpRequest({
      port: server.port,
      path: `/?token=${server.token}`,
      headers: {
        Host: `127.0.0.1:${server.port}`,
      },
    });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, "/");
    const setCookie = res.headers["set-cookie"]?.[0] ?? "";
    assert.match(setCookie, new RegExp(`asd_token=${server.token}`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
  });

  it("serves web root HTML screen and authenticated /api/projects & /api/projects/open", async () => {
    const htmlRes = await rawHttpRequest({
      port: server.port,
      path: "/",
      headers: {
        Host: `127.0.0.1:${server.port}`,
      },
    });
    assert.equal(htmlRes.statusCode, 200);
    assert.match(htmlRes.body, /<div id="root">/);

    const projRes = await rawHttpRequest({
      port: server.port,
      path: "/api/projects",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Cookie: `asd_token=${server.token}`,
      },
    });
    assert.equal(projRes.statusCode, 200);
    const parsedProjects = JSON.parse(projRes.body) as GetProjectsResponse;
    assert.ok(Array.isArray(parsedProjects.projects));
    assert.equal(parsedProjects.projects.length, 1);
    assert.equal(
      path.resolve(parsedProjects.projects[0]!.projectRoot),
      path.resolve(sandboxProject)
    );

    const openRes = await rawHttpRequest({
      port: server.port,
      path: "/api/projects/open",
      method: "POST",
      headers: {
        Host: `127.0.0.1:${server.port}`,
        Origin: `http://127.0.0.1:${server.port}`,
        Cookie: `asd_token=${server.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ projectRoot: sandboxProject }),
    });
    assert.equal(openRes.statusCode, 200);
    const snapshot = JSON.parse(openRes.body) as OpenProjectResponse;
    assert.equal(snapshot.session?.session_id, "asd-sandbox-sess-01");
    assert.equal(snapshot.allTasks.length, 1);
  });

  it("validates WebSocket upgrade security and streams state_updated on subscribe_project", async () => {
    // 1) Unauthenticated WS upgrade must fail
    await new Promise<void>((resolve, reject) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      badWs.on("unexpected-response", (_req, res) => {
        assert.equal(res.statusCode, 401);
        badWs.close();
        resolve();
      });
      badWs.on("open", () => {
        badWs.close();
        reject(new Error("Unauthenticated WebSocket should not open"));
      });
      badWs.on("error", () => {
        // Expected when upgrade is rejected
      });
    });

    // 2) Authenticated WS upgrade succeeds and returns state_updated
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
        headers: {
          Cookie: `asd_token=${server.token}`,
          Origin: `http://127.0.0.1:${server.port}`,
        },
      });
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "subscribe_project",
            projectRoot: sandboxProject,
          })
        );
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as ServerWsMessage;
        if (msg.type === "state_updated") {
          assert.equal(
            path.resolve(msg.projectRoot),
            path.resolve(sandboxProject)
          );
          assert.equal(msg.snapshot.session?.session_id, "asd-sandbox-sess-01");
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });
  });

  it("runs bundled dist/server/server.js and prints asd-gui-ready JSON line", async () => {
    const bundledServerPath = path.join(repoRoot, "dist", "server", "server.js");
    assert.ok(
      fs.existsSync(bundledServerPath),
      `Expected bundled server at ${bundledServerPath}`
    );

    const proc = child_process.spawn(
      process.execPath,
      [bundledServerPath, "--port", "0", "--no-open", "--home", tempHome],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );

    try {
      const ready = await new Promise<ServerReadyMessage>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for asd-gui-ready")),
          10_000
        );
        readline.createInterface({ input: proc.stdout! }).on("line", (line) => {
          try {
            const parsed = JSON.parse(line) as ServerReadyMessage;
            if (parsed.type === "asd-gui-ready") {
              clearTimeout(timer);
              resolve(parsed);
            }
          } catch {
            // Ignore non-JSON lines
          }
        });
        proc.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Bundled server exited early with code ${code}`));
        });
      });

      assert.ok(ready.port > 0);
      assert.equal(ready.token.length, 64);
    } finally {
      proc.kill();
    }
  });
});
