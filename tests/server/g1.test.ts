import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import WebSocket from "ws";
import { startGuiServer } from "../../src/server/index.ts";
import type {
  BrowseDirsResponse,
  CreateSessionResponse,
  OpenProjectResponse,
  ServerWsMessage,
} from "../../src/shared/protocol.ts";

function createTempGitProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Project\n", "utf-8");
  execSync("git add README.md && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

async function waitForEvent<T extends ServerWsMessage>(
  events: ServerWsMessage[],
  predicate: (evt: ServerWsMessage) => evt is T,
  timeoutMs = 10000
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for WS event`);
}

test("G1 — Projects, Sessions, and StateWatcher (debounced snapshot + log streaming)", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-g1-home-"));
  const projectA = createTempGitProject("asd-gui-g1-projA-");
  const projectB = createTempGitProject("asd-gui-g1-projB-");

  const gui = await startGuiServer({
    port: 0,
    homeDir: tempHome,
    noOpen: true,
    quietReadyLog: true,
    watcherDebounceMs: 100,
  });

  try {
    const headers = {
      Authorization: `Bearer ${gui.token}`,
      "Content-Type": "application/json",
    };

    // 1. Open projectA & verify git detection
    const openRes = await fetch(`http://127.0.0.1:${gui.port}/api/projects/open`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectRoot: projectA }),
    });
    assert.equal(openRes.status, 200);
    const openBody = (await openRes.json()) as OpenProjectResponse;
    assert.equal(openBody.isGitRepo, true);
    assert.ok(openBody.gitBranch);

    // 2. Browse dirs
    const browseRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/projects/browse-dirs?dir=${encodeURIComponent(path.dirname(projectA))}`,
      { headers }
    );
    assert.equal(browseRes.status, 200);
    const browseBody = (await browseRes.json()) as BrowseDirsResponse;
    assert.ok(browseBody.directories.includes(path.basename(projectA)));

    // 3. Create session via POST /api/sessions/create
    const createSessRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/sessions/create`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot: projectA,
          harness: "claude-code",
          memo: "Test G1 Session",
          makeForeground: true,
        }),
      }
    );
    assert.equal(createSessRes.status, 200);
    const createSessBody = (await createSessRes.json()) as CreateSessionResponse;
    const sessionId = createSessBody.sessionId;
    assert.ok(sessionId);

    // Populate a task via POST /api/sessions/plan
    const planRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/sessions/plan`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot: projectA,
          sessionId,
          tasks: [
            {
              id: "T1.1",
              title: "First G1 Task",
              turn: 1,
              scope: "backend",
              complexity: "low",
              targetFiles: ["README.md"],
              verificationCmd: 'node -e "process.exit(0)"',
            },
          ],
        }),
      }
    );
    assert.equal(planRes.status, 200);

    // 4. Connect WebSocket & subscribe to projectA
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

    ws.send(
      JSON.stringify({
        type: "subscribe_project",
        projectRoot: projectA,
      })
    );

    // Wait for initial state_updated
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(events.some((e) => e.type === "state_updated"));
    events.length = 0;

    // 5. Modify task status in SQLite directly -> expect task_status_changed & state_updated
    const db = gui.context.getDb(projectA);
    db.updateTaskStatus(sessionId, "T1.1", "running");
    // Touch .asd/PLAN.md to trigger fs.watch immediately
    fs.appendFileSync(path.join(projectA, ".asd", "PLAN.md"), "\n");

    await new Promise((r) => setTimeout(r, 400));
    const statusEvt = events.find((e) => e.type === "task_status_changed");
    assert.ok(statusEvt, "Expected task_status_changed event");
    if (statusEvt?.type === "task_status_changed") {
      assert.equal(statusEvt.taskId, "T1.1");
      assert.equal(statusEvt.from, "pending");
      assert.equal(statusEvt.to, "running");
    }
    assert.ok(events.some((e) => e.type === "state_updated"));
    events.length = 0;

    // 6. Subscribe to subagent log and write to output.log -> expect subagent_log_chunk WITHOUT state_updated
    const subSessionId = "sub-T1.1-test";
    const logDir = path.join(
      projectA,
      ".asd",
      "sessions",
      sessionId,
      "subagents",
      subSessionId
    );
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "output.log");
    fs.writeFileSync(logFile, "", "utf-8");

    // Wait for mkdir debounce to settle
    await new Promise((r) => setTimeout(r, 300));
    events.length = 0;

    ws.send(
      JSON.stringify({
        type: "subscribe_log",
        projectRoot: projectA,
        sessionId,
        subSessionId,
        fromOffset: 0,
      })
    );

    fs.appendFileSync(logFile, "Hello from subagent log line 1\n", "utf-8");

    await new Promise((r) => setTimeout(r, 350));
    const logChunkEvt = events.find((e) => e.type === "subagent_log_chunk");
    assert.ok(logChunkEvt, "Expected subagent_log_chunk event");
    if (logChunkEvt?.type === "subagent_log_chunk") {
      assert.equal(logChunkEvt.sessionId, sessionId);
      assert.equal(logChunkEvt.subSessionId, subSessionId);
      assert.match(logChunkEvt.chunk, /Hello from subagent log line 1/);
    }
    const unexpectedSnapshots = events.filter((e) => e.type === "state_updated");
    assert.equal(
      unexpectedSnapshots.length,
      0,
      "Writing to subagents output.log must NOT trigger full state_updated"
    );

    // 7. Project switching via unsubscribe_project / subscribe_project
    ws.send(
      JSON.stringify({
        type: "unsubscribe_project",
        projectRoot: projectA,
      })
    );
    ws.send(
      JSON.stringify({
        type: "subscribe_project",
        projectRoot: projectB,
      })
    );
    const projBEvent = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "state_updated" }> =>
        e.type === "state_updated" && e.projectRoot === path.resolve(projectB)
    );
    assert.ok(projBEvent, "Expected state_updated for projectB after switching");

    ws.close();
  } finally {
    await gui.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(projectA, { recursive: true, force: true });
    fs.rmSync(projectB, { recursive: true, force: true });
  }
});
