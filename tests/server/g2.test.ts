import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import WebSocket from "ws";
import { startGuiServer } from "../../src/server/index.ts";
import type { CommandRunner } from "../../src/server/core-api.ts";
import type {
  CreateSessionResponse,
  DispatchTasksResponse,
  GetPlanMdResponse,
  GetProjectRoutingResponse,
  PutPlanMdResponse,
  PutProjectRoutingResponse,
  ServerWsMessage,
} from "../../src/shared/protocol.ts";

function createTempGitProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# G2 Test Project\n", "utf-8");
  execSync("git add README.md && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

async function waitForEvent<T extends ServerWsMessage>(
  events: ServerWsMessage[],
  predicate: (evt: ServerWsMessage) => evt is T,
  timeoutMs = 15000
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for WS event`);
}

test("G2 — Turn dispatch (job_* events), PLAN.md baseVersion concurrency, memo & routing", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-g2-home-"));
  const projectRoot = createTempGitProject("asd-gui-g2-proj-");

  const mockRunner: CommandRunner = {
    async run(_cmd, _args, opts) {
      const targetFile = path.join(opts.cwd ?? projectRoot, "README.md");
      fs.writeFileSync(targetFile, "# Updated by mock subagent\n", "utf-8");
      const stdout =
        '{"session_id":"mock-sid-g2-001"}\nTask completed successfully.\n';
      opts.onSpawn?.(process.pid);
      opts.onStdout(stdout);
      return {
        exitCode: 0,
        pid: process.pid,
      };
    },
  };

  const gui = await startGuiServer({
    port: 0,
    homeDir: tempHome,
    noOpen: true,
    quietReadyLog: true,
    watcherDebounceMs: 100,
    commandRunner: mockRunner,
  });

  try {
    const headers = {
      Authorization: `Bearer ${gui.token}`,
      "Content-Type": "application/json",
    };

    // 1. Create foreground session
    const createRes = await fetch(`http://127.0.0.1:${gui.port}/api/sessions/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        harness: "claude-code",
        memo: "G2 Session",
        makeForeground: true,
      }),
    });
    assert.equal(createRes.status, 200);
    const { sessionId } = (await createRes.json()) as CreateSessionResponse;

    // 2. Add a task via POST /api/sessions/plan
    const planRes = await fetch(`http://127.0.0.1:${gui.port}/api/sessions/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId,
        tasks: [
          {
            taskId: "T1.1",
            title: "Update README in G2",
            turn: 1,
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "low",
            targetFiles: ["README.md"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
        ],
      }),
    });
    assert.equal(planRes.status, 200);

    // 3. Test GET & PUT /api/tasks/plan-md with baseVersion concurrency control
    const getPlanRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/tasks/plan-md?projectRoot=${encodeURIComponent(projectRoot)}`,
      { headers }
    );
    assert.equal(getPlanRes.status, 200);
    const planMdData = (await getPlanRes.json()) as GetPlanMdResponse;
    assert.equal(planMdData.foregroundSessionId, sessionId);
    assert.ok(planMdData.stateVersion !== undefined);

    // Put with matching baseVersion -> 200 OK
    const updatedMd = planMdData.content.replace(
      "Update README in G2",
      "Update README in G2 (Edited)"
    );
    const putOkRes = await fetch(`http://127.0.0.1:${gui.port}/api/tasks/plan-md`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId,
        content: updatedMd,
        baseVersion: planMdData.stateVersion,
      }),
    });
    assert.equal(putOkRes.status, 200);
    const putOkBody = (await putOkRes.json()) as PutPlanMdResponse;
    assert.equal(putOkBody.ok, true);
    assert.ok(putOkBody.stateVersion > (planMdData.stateVersion ?? 0));

    // Put with stale baseVersion -> 409 CONFLICT
    const putConflictRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/tasks/plan-md`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          projectRoot,
          sessionId,
          content: updatedMd,
          baseVersion: planMdData.stateVersion, // stale!
        }),
      }
    );
    assert.equal(putConflictRes.status, 409);

    // 4. Test memo & routing endpoints
    const memoRes = await fetch(`http://127.0.0.1:${gui.port}/api/sessions/memo`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId,
        memo: "Updated Memo Text",
      }),
    });
    assert.equal(memoRes.status, 200);

    const getRouteRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/projects/routing?projectRoot=${encodeURIComponent(projectRoot)}`,
      { headers }
    );
    assert.equal(getRouteRes.status, 200);
    const routeData = (await getRouteRes.json()) as GetProjectRoutingResponse;
    assert.equal(routeData.hasLocalRouting, false);

    const putRouteRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/projects/routing`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          projectRoot,
          action: "save",
          routingConfig: routeData.config,
        }),
      }
    );
    assert.equal(putRouteRes.status, 200);
    const putRouteBody = (await putRouteRes.json()) as PutProjectRoutingResponse;
    assert.equal(putRouteBody.hasLocalRouting, true);

    // 5. Connect WS & dispatch Turn 1 -> verify job_started, task_status_changed, job_finished
    const ws = new WebSocket(`ws://127.0.0.1:${gui.port}/ws`, {
      headers: {
        Origin: `http://127.0.0.1:${gui.port}`,
        Authorization: `Bearer ${gui.token}`,
      },
    });
    const events: ServerWsMessage[] = [];
    ws.on("message", (raw) => {
      events.push(JSON.parse(String(raw)) as ServerWsMessage);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });

    ws.send(JSON.stringify({ type: "subscribe_project", projectRoot }));
    await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "state_updated" }> =>
        e.type === "state_updated"
    );
    events.length = 0;

    const dispRes = await fetch(`http://127.0.0.1:${gui.port}/api/tasks/dispatch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId,
        turn: 1,
      }),
    });
    assert.equal(dispRes.status, 200);
    const dispBody = (await dispRes.json()) as DispatchTasksResponse;
    assert.ok(dispBody.jobId);

    const jobStarted = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "job_started" }> =>
        e.type === "job_started" && e.jobId === dispBody.jobId
    );
    assert.equal(jobStarted.kind, "dispatch");

    const jobFinished = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "job_finished" }> =>
        e.type === "job_finished" && e.jobId === dispBody.jobId
    );
    assert.equal(jobFinished.ok, true, jobFinished.error ?? "Dispatch job failed");

    const db = gui.context.getDb(projectRoot);
    const finalTask = db.getTask(sessionId, "T1.1");
    assert.equal(finalTask?.status, "done");

    ws.close();
  } finally {
    await gui.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
