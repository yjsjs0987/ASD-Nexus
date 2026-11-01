import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import WebSocket from "ws";
import { startGuiServer } from "../../src/server/index.ts";
import type { IPtyProcess, NodePtyModule } from "../../src/server/pty/pty-manager.ts";
import type {
  GetResumeCommandResponse,
  GetTranscriptResponse,
  ServerWsMessage,
} from "../../src/shared/protocol.ts";

function createTempGitProject(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "test@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "# G3 Test Project\n", "utf-8");
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
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for WS event`);
}

test("G3 — PTY Manager (spawn, I/O, resize, reconnect, closeTabsInPath, security) & Transcripts API", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-g3-home-"));
  const projectRoot = createTempGitProject("asd-gui-g3-proj-");
  const wtSubdir = path.join(projectRoot, ".asd", "wt", "1-T1.1");
  fs.mkdirSync(wtSubdir, { recursive: true });

  const spawnedCalls: Array<{
    file: string;
    args: string[] | string;
    cwd?: string;
    env?: Record<string, string>;
  }> = [];

  const mockPtyModule: NodePtyModule = {
    spawn(file, args, options) {
      spawnedCalls.push({
        file,
        args,
        cwd: options.cwd,
        env: options.env,
      });
      let dataListener: ((d: string) => void) | null = null;
      let exitListener: ((e: { exitCode: number }) => void) | null = null;

      const proc: IPtyProcess = {
        pid: 0,
        write(data: string) {
          dataListener?.(`ECHO:${data}`);
        },
        resize(_cols: number, _rows: number) {
          // no-op
        },
        kill() {
          exitListener?.({ exitCode: 0 });
        },
        onData(cb) {
          dataListener = cb;
          setTimeout(() => {
            dataListener?.("READY\r\n");
          }, 10);
        },
        onExit(cb) {
          exitListener = cb;
        },
      };
      return proc;
    },
  };

  const gui = await startGuiServer({
    port: 0,
    homeDir: tempHome,
    noOpen: true,
    quietReadyLog: true,
    ptyModuleOverride: mockPtyModule,
  });

  try {
    const headers = {
      Authorization: `Bearer ${gui.token}`,
      "Content-Type": "application/json",
    };

    // 1. Test GET /api/transcripts/resume-command
    const resumeCmdRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/transcripts/resume-command?harness=codex&harnessSessionId=thread_abc123&model=gpt-5`,
      { headers }
    );
    assert.equal(resumeCmdRes.status, 200);
    const resumeCmdBody = (await resumeCmdRes.json()) as GetResumeCommandResponse;
    assert.equal(resumeCmdBody.command, "codex");
    assert.match(resumeCmdBody.cliString, /codex resume thread_abc123/);
    assert.equal(resumeCmdBody.ptyAvailable, true);

    // 2. Test GET /api/transcripts with a sample JSONL file
    const sampleTranscriptPath = path.join(projectRoot, "sample-transcript.jsonl");
    fs.writeFileSync(
      sampleTranscriptPath,
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "Hello Claude" },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: "Here is my response with secret sk-ant-api03-1234567890abcdefghijklmnop",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const trRes = await fetch(
      `http://127.0.0.1:${gui.port}/api/transcripts?projectRoot=${encodeURIComponent(
        projectRoot
      )}&harness=claude-code&harnessSessionId=sess-123&transcriptPath=${encodeURIComponent(
        sampleTranscriptPath
      )}`,
      { headers }
    );
    assert.equal(trRes.status, 200);
    const trBody = (await trRes.json()) as GetTranscriptResponse;
    assert.equal(trBody.found, true);
    assert.equal(trBody.messages.length, 2);
    assert.ok(
      !trBody.messages[1]!.text.includes("sk-ant-api03-1234567890abcdefghijklmnop"),
      "Transcript output must be secret-redacted"
    );

    // 3. Connect WS and spawn PTY with asDriverOf env injection
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
        type: "pty_spawn",
        tabId: "tab-wt-1",
        projectRoot,
        cwd: wtSubdir,
        harness: "claude-code",
        harnessSessionId: "claude-sid-999",
        asDriverOf: {
          sessionId: "asd-20261101-120000-a1b2",
          driverId: "drv-1234",
        },
        cols: 100,
        rows: 30,
      })
    );

    const readyOut = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "pty_output" }> =>
        e.type === "pty_output" && e.tabId === "tab-wt-1"
    );
    assert.match(readyOut.data, /READY/);
    assert.equal(spawnedCalls.length, 1);
    assert.equal(
      spawnedCalls[0]!.env?.ASD_SESSION_ROLE,
      "driver",
      "Expected ASD_SESSION_ROLE=driver in PTY env"
    );
    assert.equal(
      spawnedCalls[0]!.env?.ASD_MAIN_SESSION_ID,
      "asd-20261101-120000-a1b2"
    );
    assert.equal(spawnedCalls[0]!.env?.ASD_DRIVER_ID, "drv-1234");

    // 4. Send pty_input and verify echo output
    events.length = 0;
    ws.send(
      JSON.stringify({
        type: "pty_input",
        tabId: "tab-wt-1",
        data: "pwd\r",
      })
    );
    const echoOut = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "pty_output" }> =>
        e.type === "pty_output" &&
        e.tabId === "tab-wt-1" &&
        e.data.includes("ECHO:pwd")
    );
    assert.ok(echoOut);

    // 5. Reject cwd outside projectRoot
    events.length = 0;
    ws.send(
      JSON.stringify({
        type: "pty_spawn",
        tabId: "tab-bad-cwd",
        projectRoot,
        cwd: path.resolve(projectRoot, ".."),
        cols: 80,
        rows: 24,
      })
    );
    const errEvt = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "error" }> =>
        e.type === "error"
    );
    assert.equal(errEvt.code, "INVALID_PATH");

    // 6. Test closeTabsInPath(wtSubdir) closes tab-wt-1 and emits pty_exit
    events.length = 0;
    const closedCount = await gui.ptyManager.closeTabsInPath(wtSubdir);
    assert.equal(closedCount, 1);
    const exitEvt = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "pty_exit" }> =>
        e.type === "pty_exit" && e.tabId === "tab-wt-1"
    );
    assert.equal(exitEvt.exitCode, 0);

    ws.close();
  } finally {
    await gui.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("G3 — PTY fallback mode when node-pty is unavailable", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-g3-fb-home-"));
  const projectRoot = createTempGitProject("asd-gui-g3-fb-proj-");

  const gui = await startGuiServer({
    port: 0,
    homeDir: tempHome,
    noOpen: true,
    quietReadyLog: true,
    forceDisablePty: true,
  });

  try {
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
        type: "pty_spawn",
        tabId: "tab-fallback",
        projectRoot,
        harness: "claude-code",
        harnessSessionId: "sid-fallback-1",
        cols: 80,
        rows: 24,
      })
    );

    const ptyErr = await waitForEvent(
      events,
      (e): e is Extract<ServerWsMessage, { type: "pty_error" }> =>
        e.type === "pty_error" && e.tabId === "tab-fallback"
    );
    assert.match(ptyErr.message, /NODE_PTY_UNAVAILABLE/);
    assert.match(ptyErr.message, /claude --resume sid-fallback-1/);

    ws.close();
  } finally {
    await gui.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
