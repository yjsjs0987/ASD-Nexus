import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import WebSocket from "ws";
import { startGuiServer } from "../../src/server/index.ts";
import {
  recordCliRecentSession,
  type CommandRunner,
} from "../../src/server/core-api.ts";
import type {
  AttachDriverResponse,
  CreateSessionResponse,
  DriverPromptResponse,
  GetDriversResponse,
  GetResumeCommandResponse,
  GetTranscriptResponse,
  OpenProjectResponse,
  ResolveConflictResponse,
  ServerWsMessage,
  SetForegroundSessionResponse,
  SubagentActionResponse,
} from "../../src/shared/protocol.ts";

function createTempGitProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "app.ts"), "export const v = 1;\n", "utf-8");
  fs.writeFileSync(path.join(dir, "ai-conflict.txt"), "base line\n", "utf-8");
  execSync("git add . && git commit -m init", { cwd: dir, stdio: "ignore" });
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
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for WS event`);
}

test("G5 E2E — Scenarios 1, 2, 3, 5, 6, 7, 8 (Drivers, Briefing, Resume Follow-up, AI Conflict, Orphans, Foreground)", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-g5-home-"));
  const projectRoot = createTempGitProject("asd-gui-g5-proj-");

  const capturedPrompts: Array<{ cmd: string; args: string[]; cwd?: string }> = [];

  const mockRunner: CommandRunner = {
    async run(cmd, args, opts) {
      capturedPrompts.push({ cmd, args, cwd: opts.cwd });
      const joinedArgs = args.join(" ");
      const cwd = opts.cwd ?? projectRoot;

      // If this is AI conflict resolution in a worktree (Scenario 5)
      if (joinedArgs.includes("git merge") && cwd.includes("T2.1")) {
        const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: projectRoot,
          encoding: "utf-8",
        }).trim();
        try {
          execSync(`git merge ${mainBranch}`, { cwd, stdio: "ignore" });
        } catch {
          // expected conflict
        }
        fs.writeFileSync(
          path.join(cwd, "ai-conflict.txt"),
          "ai resolved conflict content\n",
          "utf-8"
        );
        execSync('git add ai-conflict.txt && git commit -m "ai resolved"', {
          cwd,
          stdio: "ignore",
        });
      } else if (cwd.includes("T2.1")) {
        // Initial T2.1 run: cause merge conflict with main
        fs.writeFileSync(
          path.join(cwd, "ai-conflict.txt"),
          "wt conflicting content\n",
          "utf-8"
        );
        fs.writeFileSync(
          path.join(projectRoot, "ai-conflict.txt"),
          "main conflicting content\n",
          "utf-8"
        );
        execSync('git add ai-conflict.txt && git commit -m "main conflict"', {
          cwd: projectRoot,
          stdio: "ignore",
        });
      } else {
        // Modify app.ts for T1.1 or follow-up T1.2
        const cur = fs.existsSync(path.join(cwd, "app.ts"))
          ? fs.readFileSync(path.join(cwd, "app.ts"), "utf-8")
          : "";
        fs.writeFileSync(
          path.join(cwd, "app.ts"),
          `${cur}// updated at ${Date.now()}\n`,
          "utf-8"
        );
      }

      opts.onSpawn?.(process.pid);
      const out =
        '{"session_id":"native-sid-from-runner-777"}\nDriver/Subagent output chunk.\n';
      opts.onStdout(out);
      return { exitCode: 0, pid: process.pid };
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

    // Connect WebSocket
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

    // =========================================================================
    // Scenario 1 & 2: CLI -> GUI (cli-recent.json, transcript view, attachDriver) & Resume commands
    // =========================================================================
    const sampleTranscript = path.join(projectRoot, "cli-chat.jsonl");
    fs.writeFileSync(
      sampleTranscript,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Login bug investigation" },
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "Found issue in auth.ts" },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    recordCliRecentSession(
      projectRoot,
      {
        harnessSessionId: "cli-recent-sid-101",
        harness: "claude-code",
        model: "claude-sonnet-4-6",
        summary: "Login bug investigation",
        transcriptPath: sampleTranscript,
      },
      { forceCreateDir: true }
    );

    const openSnapRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/projects/open`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ projectRoot }),
      }
    );
    assert.equal(openSnapRes.status, 200);
    const openSnap = (await openSnapRes.json()) as OpenProjectResponse;
    assert.ok(
      openSnap.cliRecentSessions.some(
        (r) => r.harnessSessionId === "cli-recent-sid-101"
      ),
      "cli-recent session must be visible in project snapshot"
    );

    const trRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/transcripts?projectRoot=${encodeURIComponent(
        projectRoot
      )}&harness=claude-code&harnessSessionId=cli-recent-sid-101&transcriptPath=${encodeURIComponent(
        sampleTranscript
      )}`,
      { headers }
    );
    const trData = (await trRes.json()) as GetTranscriptResponse;
    assert.equal(trData.found, true);
    assert.equal(trData.messages.length, 2);

    // Scenario 2: Verify resume command generation across harnesses
    for (const [h, expectedPattern] of [
      ["claude-code", /claude --resume sid-1/],
      ["codex", /codex resume sid-1/],
      ["opencode", /opencode --session sid-1/],
      ["antigravity", /agy --resume sid-1/],
      ["cursor", /agent --resume sid-1/],
    ] as const) {
      const rCmd = await fetch(
        `http://127.0.0.1:${gui.port}/api/transcripts/resume-command?harness=${h}&harnessSessionId=sid-1`,
        { headers }
      );
      const rBody = (await rCmd.json()) as GetResumeCommandResponse;
      assert.match(rBody.cliString, expectedPattern);
    }

    // =========================================================================
    // Scenario 7 & 8: Create Session A (foreground) & Session B (background), Driver switch + Briefing
    // =========================================================================
    const createARes = await fetch(
      `http://127.0.0.1:${gui.port}/api/sessions/create`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot,
          harness: "opencode",
          model: "glm-5",
          memo: "Session A (Foreground)",
          makeForeground: true,
        }),
      }
    );
    assert.equal(createARes.status, 200);
    const { sessionId: sessionA, driver: driverA1 } =
      (await createARes.json()) as CreateSessionResponse;
    assert.equal(driverA1.harness, "opencode");

    // Link CLI recent conversation or switch driver to claude-code (Scenario 7)
    const attachRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/drivers/attach`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot,
          sessionId: sessionA,
          harness: "claude-code",
          model: "claude-sonnet-4-6",
          source: "gui-headless",
        }),
      }
    );
    assert.equal(attachRes.status, 200);
    const attachBody = (await attachRes.json()) as AttachDriverResponse;
    assert.equal(attachBody.previousDriverId, driverA1.driver_id);
    assert.equal(attachBody.driver.harness, "claude-code");
    assert.equal(attachBody.driver.briefing_injected, 0);

    // Send prompt to new driver -> briefing should be auto-injected because previous driver existed!
    events.length = 0;
    capturedPrompts.length = 0;
    const promptRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/drivers/prompt`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot,
          sessionId: sessionA,
          prompt: "Continue from previous opencode driver",
          mode: "chat",
        }),
      }
    );
    assert.equal(promptRes.status, 200);
    const promptBody = (await promptRes.json()) as DriverPromptResponse;
    assert.ok(promptBody.jobId);

    await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "driver_output_chunk" }> =>
        e.type === "driver_output_chunk" && e.sessionId === sessionA
    );
    const drvJobDone = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "job_finished" }> =>
        e.type === "job_finished" && e.jobId === promptBody.jobId
    );
    assert.equal(drvJobDone.ok, true);

    // Verify briefing was injected and briefing_injected is now 1
    assert.ok(
      capturedPrompts.some((p) =>
        p.args.join(" ").includes("Continue from previous opencode driver")
      )
    );
    const driversListRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/drivers?projectRoot=${encodeURIComponent(
        projectRoot
      )}&sessionId=${encodeURIComponent(sessionA)}`,
      { headers }
    );
    const driversList = (await driversListRes.json()) as GetDriversResponse;
    const updatedActiveDriver = driversList.drivers.find(
      (d) => d.driver_id === attachBody.driver.driver_id
    );
    assert.equal(updatedActiveDriver?.briefing_injected, 1);
    assert.equal(
      updatedActiveDriver?.harness_session_id,
      "native-sid-from-runner-777"
    );

    // Scenario 8: Create Session B in background (`makeForeground: false`)
    const createBRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/sessions/create`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot,
          harness: "codex",
          memo: "Session B (Background)",
          makeForeground: false,
        }),
      }
    );
    const { sessionId: sessionB } =
      (await createBRes.json()) as CreateSessionResponse;

    // Add tasks to Session B -> PLAN.md must STILL belong to Session A!
    await fetch(`http://127.0.0.1:${gui.port}/api/sessions/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId: sessionB,
        tasks: [
          {
            taskId: "T1.1",
            title: "Background session B task",
            turn: 1,
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "low",
            targetFiles: ["app.ts"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
        ],
      }),
    });
    const planMdBeforeSwitch = fs.readFileSync(
      path.join(projectRoot, ".asd", "PLAN.md"),
      "utf-8"
    );
    assert.match(planMdBeforeSwitch, new RegExp(`Session:\\s*${sessionA}`));

    // Switch foreground to Session B -> PLAN.md now reflects Session B
    const fgSwitchRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/sessions/foreground`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ projectRoot, sessionId: sessionB }),
      }
    );
    assert.equal(fgSwitchRes.status, 200);
    const fgSwitchBody =
      (await fgSwitchRes.json()) as SetForegroundSessionResponse;
    assert.equal(fgSwitchBody.sessionId, sessionB);
    const planMdAfterSwitch = fs.readFileSync(
      path.join(projectRoot, ".asd", "PLAN.md"),
      "utf-8"
    );
    assert.match(planMdAfterSwitch, new RegExp(`Session:\\s*${sessionB}`));

    // Switch foreground back to Session A for Scenario 3 & 5
    await fetch(`http://127.0.0.1:${gui.port}/api/sessions/foreground`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectRoot, sessionId: sessionA }),
    });

    // =========================================================================
    // Scenario 3 & 5: Subagent follow-up Resume on `done` task & AI Conflict Resolution (CR-13)
    // =========================================================================
    await fetch(`http://127.0.0.1:${gui.port}/api/sessions/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId: sessionA,
        tasks: [
          {
            taskId: "T1.1",
            title: "Initial app.ts feature",
            turn: 1,
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "low",
            targetFiles: ["app.ts"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
          {
            taskId: "T2.1",
            title: "Heavy task with AI conflict resolution",
            turn: 2,
            track: "HEAVY",
            role: "worker",
            category: "general",
            difficulty: "medium",
            targetFiles: ["ai-conflict.txt"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
        ],
      }),
    });

    // Dispatch Turn 1 -> T1.1 completes (`done`)
    events.length = 0;
    const disp1Res = await fetch(
      `http://127.0.0.1:${gui.port}/api/tasks/dispatch`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ projectRoot, sessionId: sessionA, turn: 1 }),
      }
    );
    const { jobId: disp1JobId } = (await disp1Res.json()) as { jobId: string };
    await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "job_finished" }> =>
        e.type === "job_finished" && e.jobId === disp1JobId
    );

    const db = gui.context.getDb(projectRoot);
    const t1Done = db.getTask(sessionA, "T1.1");
    assert.equal(t1Done?.status, "done");
    assert.ok(t1Done?.sub_session_id);

    // Verify Section 6.6 guard: changing harness on resume is rejected with 400
    const badHarnessResume = await fetch(
      `http://127.0.0.1:${gui.port}/api/sessions/subagent-action`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot,
          sessionId: sessionA,
          subSessionId: t1Done!.sub_session_id,
          action: "resume",
          harness: "cursor",
          prompt: "Should fail due to harness mismatch",
        }),
      }
    );
    assert.equal(badHarnessResume.status, 400);

    // Scenario 3: Valid resume on `done` task T1.1 -> creates follow-up task T1.2 (`follow_up_of = 'T1.1'`) and completes it!
    events.length = 0;
    const resumeDoneRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/sessions/subagent-action`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot,
          sessionId: sessionA,
          subSessionId: t1Done!.sub_session_id,
          action: "resume",
          prompt: "Add follow-up validation to app.ts",
        }),
      }
    );
    assert.equal(resumeDoneRes.status, 200);
    const resumeDoneBody =
      (await resumeDoneRes.json()) as SubagentActionResponse;
    const resumeJobFinished = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "job_finished" }> =>
        e.type === "job_finished" && e.jobId === resumeDoneBody.jobId
    );
    assert.equal(resumeJobFinished.ok, true);

    const followUpTask = db.getTask(sessionA, "T1.2");
    assert.ok(followUpTask, "Expected follow-up task T1.2 to be created");
    assert.equal(followUpTask?.follow_up_of, "T1.1");
    assert.equal(followUpTask?.status, "done");

    // Scenario 5: Dispatch Turn 2 -> T2.1 enters merge_conflict -> Resolve via POST /api/tasks/resolve-conflict (AI)
    events.length = 0;
    const disp2Res = await fetch(
      `http://127.0.0.1:${gui.port}/api/tasks/dispatch`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ projectRoot, sessionId: sessionA, turn: 2 }),
      }
    );
    const { jobId: disp2JobId } = (await disp2Res.json()) as { jobId: string };
    await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "job_finished" }> =>
        e.type === "job_finished" && e.jobId === disp2JobId
    );
    assert.equal(db.getTask(sessionA, "T2.1")?.status, "merge_conflict");

    events.length = 0;
    const aiResolveRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/tasks/resolve-conflict`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectRoot,
          sessionId: sessionA,
          taskId: "T2.1",
          strategy: "ai",
        }),
      }
    );
    assert.equal(aiResolveRes.status, 200);
    const aiResolveBody =
      (await aiResolveRes.json()) as ResolveConflictResponse;
    const aiResolveDone = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "job_finished" }> =>
        e.type === "job_finished" && e.jobId === aiResolveBody.jobId
    );
    assert.equal(aiResolveDone.ok, true);
    assert.equal(db.getTask(sessionA, "T2.1")?.status, "done");
    assert.match(
      fs.readFileSync(path.join(projectRoot, "ai-conflict.txt"), "utf-8"),
      /ai resolved conflict content/
    );

    // =========================================================================
    // Scenario 6: Orphaned task recovery (CR-12)
    // =========================================================================
    // Create a running parallel_spawn task whose pid and ownerPid are dead (999999)
    await fetch(`http://127.0.0.1:${gui.port}/api/sessions/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        projectRoot,
        sessionId: sessionA,
        tasks: [
          {
            taskId: "T3.1",
            title: "Orphaned parallel task",
            turn: 3,
            track: "LIGHT",
            role: "worker",
            category: "general",
            difficulty: "low",
            targetFiles: ["app.ts"],
            verifyCmd: 'node -e "process.exit(0)"',
          },
        ],
      }),
    });
    db.updateTaskStatus(sessionA, "T3.1", "running", {
      subSessionId: "sub-orphan-3-1",
    });
    const orphanSubDir = path.join(
      projectRoot,
      ".asd",
      "sessions",
      sessionA,
      "subagents",
      "sub-orphan-3-1"
    );
    fs.mkdirSync(orphanSubDir, { recursive: true });
    fs.writeFileSync(
      path.join(orphanSubDir, "meta.json"),
      JSON.stringify({
        subSessionId: "sub-orphan-3-1",
        parentSessionId: sessionA,
        roleType: "subagent",
        role: "worker",
        harness: "codex",
        model: "gpt-5",
        taskId: "T3.1",
        pid: 999991,
        ownerPid: 999992,
        dispatchMode: "parallel_spawn",
        status: "running",
        startedAt: Date.now() - 5000,
      }),
      "utf-8"
    );

    events.length = 0;
    const recovered = gui.watcher.runOrphanSweep(projectRoot);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.taskId, "T3.1");
    assert.equal(recovered[0]!.to, "failed");
    assert.equal(recovered[0]!.reason, "orphaned");
    assert.equal(db.getTask(sessionA, "T3.1")?.status, "failed");

    ws.close();
  } finally {
    await gui.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
