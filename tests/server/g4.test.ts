import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { startGuiServer } from "../../src/server/index.ts";
import type { CommandRunner } from "../../src/server/core-api.ts";
import type {
  ApproveTaskResponse,
  CreateSessionResponse,
  DispatchTasksResponse,
  GetTaskDiffResponse,
  RejectTaskResponse,
} from "../../src/shared/protocol.ts";

function createTempGitProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "conflict.txt"), "line 1: base\n", "utf-8");
  fs.writeFileSync(path.join(dir, "reject-me.txt"), "line 1: base\n", "utf-8");
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
  return dir;
}

test("G4 — Merge conflict committed diff (CR-08), manual resolve + approve, and reject", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-g4-home-"));
  const projectRoot = createTempGitProject("asd-gui-g4-proj-");

  // Mock runner modifies target file in the worktree, while main branch also advances with a conflicting commit!
  const mockRunner: CommandRunner = {
    async run(_cmd, _args, opts) {
      const wtDir = opts.cwd ?? projectRoot;
      if (wtDir.includes("T1.1")) {
        // Modify conflict.txt in worktree
        fs.writeFileSync(
          path.join(wtDir, "conflict.txt"),
          "line 1: worktree version\n",
          "utf-8"
        );
        // Also advance main branch in projectRoot so merging wt into main causes a merge_conflict!
        fs.writeFileSync(
          path.join(projectRoot, "conflict.txt"),
          "line 1: main conflicting version\n",
          "utf-8"
        );
        execSync('git add conflict.txt && git commit -m "main advance"', {
          cwd: projectRoot,
          stdio: "ignore",
        });
      } else if (wtDir.includes("T2.1")) {
        fs.writeFileSync(
          path.join(wtDir, "reject-me.txt"),
          "line 1: wt reject version\n",
          "utf-8"
        );
        fs.writeFileSync(
          path.join(projectRoot, "reject-me.txt"),
          "line 1: main reject conflict\n",
          "utf-8"
        );
        execSync('git add reject-me.txt && git commit -m "main advance 2"', {
          cwd: projectRoot,
          stdio: "ignore",
        });
      }
      opts.onSpawn?.(process.pid);
      opts.onStdout('{"session_id":"mock-sid-g4-001"}\nDone.\n');
      return { exitCode: 0, pid: process.pid };
    },
  };

  const gui = await startGuiServer({
    port: 0,
    homeDir: tempHome,
    noOpen: true,
    quietReadyLog: true,
    commandRunner: mockRunner,
  });

  try {
    const headers = {
      Authorization: `Bearer ${gui.token}`,
      "Content-Type": "application/json",
    };

    const createRes = await fetch(`http://127.0.0.1:${gui.port}/api/sessions/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        harness: "claude-code",
        memo: "G4 Conflict Test",
        makeForeground: true,
      }),
    });
    const { sessionId } = (await createRes.json()) as CreateSessionResponse;

    await fetch(`http://127.0.0.1:${gui.port}/api/sessions/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId,
        tasks: [
          {
            taskId: "T1.1",
            title: "Heavy task causing merge conflict",
            turn: 1,
            track: "HEAVY",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["conflict.txt"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
          {
            taskId: "T2.1",
            title: "Heavy task to reject",
            turn: 2,
            track: "HEAVY",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["reject-me.txt"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
        ],
      }),
    });

    // 1. Dispatch Turn 1 -> T1.1 should end up in merge_conflict
    const disp1 = await fetch(`http://127.0.0.1:${gui.port}/api/tasks/dispatch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectRoot, sessionId, turn: 1 }),
    });
    assert.equal(disp1.status, 200);
    const { jobId: job1 } = (await disp1.json()) as DispatchTasksResponse;
    assert.ok(job1);

    const db = gui.context.getDb(projectRoot);
    const startWait = Date.now();
    while (Date.now() - startWait < 15000) {
      const t = db.getTask(sessionId, "T1.1");
      if (t?.status === "merge_conflict") break;
      await new Promise((r) => setTimeout(r, 80));
    }
    const task1 = db.getTask(sessionId, "T1.1");
    assert.equal(task1?.status, "merge_conflict");
    assert.ok(task1?.worktree_path && fs.existsSync(task1.worktree_path));

    // 2. Verify GET /api/tasks/diff returns committed mode & non-empty diff (CR-08)
    const diffRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/tasks/diff?projectRoot=${encodeURIComponent(
        projectRoot
      )}&sessionId=${encodeURIComponent(sessionId)}&taskId=T1.1`,
      { headers }
    );
    assert.equal(diffRes.status, 200);
    const diffBody = (await diffRes.json()) as GetTaskDiffResponse;
    assert.equal(diffBody.mode, "committed");
    assert.ok(diffBody.changedFiles.includes("conflict.txt"));
    assert.match(diffBody.diff, /worktree version/);

    // 3. Manually resolve conflict in worktree (merge main into worktree and commit resolved file)
    const wt1 = task1!.worktree_path!;
    const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: projectRoot,
      encoding: "utf-8",
    }).trim();
    try {
      execSync(`git merge ${mainBranch}`, { cwd: wt1, stdio: "ignore" });
    } catch {
      // Expected merge conflict exit code
    }
    fs.writeFileSync(
      path.join(wt1, "conflict.txt"),
      "line 1: resolved both main and worktree\n",
      "utf-8"
    );
    execSync('git add conflict.txt && git commit -m "resolved conflict"', {
      cwd: wt1,
      stdio: "ignore",
    });

    // 4. Call POST /api/tasks/approve -> re-verifies, merges into main, and transitions T1.1 to done
    const approveRes = await fetch(`http://127.0.0.1:${gui.port}/api/tasks/approve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId,
        taskId: "T1.1",
      }),
    });
    assert.equal(approveRes.status, 200);
    const approveBody = (await approveRes.json()) as ApproveTaskResponse;
    assert.equal(approveBody.ok, true);
    assert.equal(approveBody.status, "done");
    assert.equal(db.getTask(sessionId, "T1.1")?.status, "done");
    assert.match(
      fs.readFileSync(path.join(projectRoot, "conflict.txt"), "utf-8"),
      /resolved both main and worktree/
    );

    // 5. Dispatch Turn 2 -> T2.1 enters merge_conflict -> POST /api/tasks/reject
    await fetch(`http://127.0.0.1:${gui.port}/api/tasks/dispatch`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectRoot, sessionId, turn: 2 }),
    });
    const startWait2 = Date.now();
    while (Date.now() - startWait2 < 15000) {
      const t = db.getTask(sessionId, "T2.1");
      if (t?.status === "merge_conflict") break;
      await new Promise((r) => setTimeout(r, 80));
    }
    const task2 = db.getTask(sessionId, "T2.1");
    assert.equal(task2?.status, "merge_conflict");
    const wt2 = task2!.worktree_path!;
    assert.ok(fs.existsSync(wt2));

    const rejectRes = await fetch(`http://127.0.0.1:${gui.port}/api/tasks/reject`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId,
        taskId: "T2.1",
      }),
    });
    assert.equal(rejectRes.status, 200);
    const rejectBody = (await rejectRes.json()) as RejectTaskResponse;
    assert.equal(rejectBody.ok, true);
    assert.equal(rejectBody.status, "failed");
    assert.equal(db.getTask(sessionId, "T2.1")?.status, "failed");
    assert.equal(fs.existsSync(wt2), false, "Rejected worktree must be removed");
  } finally {
    await gui.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
