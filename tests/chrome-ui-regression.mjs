import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const projectRoot = process.cwd();

function findChromeBinary() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Chrome/Edge binary not found");
}

async function startGuiServer() {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-home-"));
  const realAsdDir = path.join(os.homedir(), ".asd");
  const tempAsdDir = path.join(tempHome, ".asd");
  const tempStateDir = path.join(tempAsdDir, "state");
  fs.mkdirSync(tempStateDir, { recursive: true });
  for (const fname of ["routing.jsonc", "routing.json"]) {
    const src = path.join(realAsdDir, fname);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(tempAsdDir, fname));
    }
  }
  const targetDir = path.join(realAsdDir, "state", "5016f1fb79bd");
  if (fs.existsSync(targetDir)) {
    fs.cpSync(targetDir, path.join(tempStateDir, "5016f1fb79bd"), { recursive: true });
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["dist/server/server.js", "--no-open", "--port", "0", "--home", tempHome],
      {
        cwd: projectRoot,
        env: { ...process.env, ASD_GUI_DEV: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Server ready timeout. Output: " + buf));
    }, 10000);

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split(/\r?\n/)) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.type === "asd-gui-ready") {
            clearTimeout(timer);
            resolve({ child, port: parsed.port, token: parsed.token });
          }
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}: ${buf}`));
    });
  });
}

async function startChromeCdp(chromeBin) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "asd-gui-cdp-"));
  return new Promise((resolve, reject) => {
    const child = spawn(
      chromeBin,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1440,900",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let errBuf = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Chrome CDP timeout: " + errBuf));
    }, 10000);

    const onData = (chunk) => {
      errBuf += chunk.toString("utf8");
      const m = errBuf.match(/DevTools listening on (ws:\/\/[^\s\r\n]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ child, wsUrl: m[1], userDataDir });
      }
    };
    child.stderr.on("data", onData);
    child.stdout.on("data", onData);
  });
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.exceptions = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        if (msg.params.type === "error") {
          const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
          this.consoleErrors.push(text);
        }
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.exceptions.push(msg.params.exceptionDetails?.text || "Exception");
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(`Eval exception: ${res.exceptionDetails.text} (${expression})`);
    }
    return res.result?.value;
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const chromeBin = findChromeBinary();
  const srv = await startGuiServer();
  const chr = await startChromeCdp(chromeBin);

  try {
    const httpEndpoint = chr.wsUrl.replace(/^ws:\/\//, "http://").split("/devtools/")[0];
    const targets = await fetch(`${httpEndpoint}/json/list`).then((r) => r.json());
    const pageTarget = targets.find((t) => t.type === "page");
    if (!pageTarget) throw new Error("No page target found");

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", rej, { once: true });
    });

    const cdp = new CdpSession(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const authUrl = `http://127.0.0.1:${srv.port}/?token=${srv.token}`;
    await cdp.send("Page.navigate", { url: authUrl });
    await sleep(1500);

    // 1. Check 3-column layout and viewport on Welcome screen
    const welcomeCheck = await cdp.eval(`(() => {
      const app = document.querySelector('.app');
      const cs = app ? getComputedStyle(app) : null;
      return {
        hasApp: !!app,
        gridCols: cs ? cs.gridTemplateColumns : null,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        hasDock: !!document.querySelector('.dock'),
        hasMain: !!document.querySelector('.main'),
        hasToolsDock: !!document.querySelector('.tools-dock'),
        titleText: document.querySelector('.welcome h1')?.textContent?.trim() ?? '',
      };
    })()`);
    console.log("1. Welcome & 3-Col Check:", welcomeCheck);

    // 2. Test Folder Browser (browseDirs) and then open current project (asd-gui) via welcome card
    await cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('form.asd-form button')];
      const browseBtn = buttons.find(b => b.textContent.includes('폴더 찾아보기'));
      if (!browseBtn) throw new Error("Browse button not found");
      browseBtn.click();
    })()`);
    for (let i = 0; i < 80; i++) {
      const ready = await cdp.eval(`!!document.querySelector('.asd-dir-browser') && document.querySelectorAll('.welcome-cards button').length > 0`);
      if (ready) break;
      await sleep(300);
    }
    const step2Action = await cdp.eval(`(() => {
      const hasDirBrowser = !!document.querySelector('.asd-dir-browser');
      const cards = [...document.querySelectorAll('.welcome-cards button')];
      const match = cards.find(b => b.textContent.includes('asd-gui'));
      if (!match) throw new Error("asd-gui card not found among " + cards.length + " cards");
      match.click();
      return { hasDirBrowser, cardsCount: cards.length, clickedCard: true };
    })()`);
    console.log("Step 2 Action (Folder Browser + Welcome Card Open):", step2Action);
    await sleep(1500);

    // Verify Chat tab (default after opening project with foreground session)
    const chatCheck = await cdp.eval(`(() => {
      const logoImg = document.querySelector('.dock-logo img');
      return {
        h1: document.querySelector('h1')?.textContent?.trim() ?? '',
        toast: document.querySelector('.toast')?.textContent?.trim() ?? '',
        sessionHead: document.querySelector('.session-head')?.textContent?.trim() ?? '',
        hasDriverBar: !!document.querySelector('.asd-driver-bar'),
        hasThread: !!document.querySelector('.thread'),
        hasComposer: !!document.querySelector('.composer'),
        logoLoaded: !!(logoImg && logoImg.complete && logoImg.naturalWidth > 0),
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    })()`);
    console.log("2. Chat Tab, Logo & DriverBar Check:", chatCheck);

    // 2b. Verify HarnessModelsModal & ModelPicker
    await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('.session-head button')].find(b => b.textContent.includes('하네스·모델'));
      if (!btn) throw new Error("Harness modal button not found");
      btn.click();
    })()`);
    await sleep(600);
    const harnessModalCheck = await cdp.eval(`(() => {
      const modal = document.querySelector('.asd-harness-modal');
      const cards = [...document.querySelectorAll('.asd-harness-card')];
      const pills = [...document.querySelectorAll('.asd-model-pill')];
      const closeBtn = [...(modal?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === '닫기');
      if (closeBtn) closeBtn.click();
      return {
        modalOpen: !!modal,
        harnessCardCount: cards.length,
        totalModelPills: pills.length,
      };
    })()`);
    console.log("2b. HarnessModelsModal Check:", harnessModalCheck);
    await sleep(300);

    // 2c. Verify Session Switching in SessionRail (switch away and then ensure Elysium session is active for Step 3)
    await cdp.eval(`(() => {
      const panelToggle = document.querySelector('.dock button[aria-label="세션 목록"]');
      const panelOpen = document.querySelector('.panel.open');
      if (!panelOpen && panelToggle) panelToggle.click();
    })()`);
    await sleep(400);
    const sessionSwitchCheck = await cdp.eval(`(async () => {
      const beforeTitle = document.querySelector('.session-head .head-title')?.textContent?.trim() ?? '';
      const otherBtn = [...document.querySelectorAll('.sessions .session:not(.cli-session):not(.on)')][0];
      if (!otherBtn) return { switched: true, beforeTitle, afterTitle: beforeTitle };
      otherBtn.click();
      await new Promise(r => setTimeout(r, 500));
      const midTitle = document.querySelector('.session-head .head-title')?.textContent?.trim() ?? '';
      const elysiumBtn = [...document.querySelectorAll('.sessions .session:not(.cli-session)')].find(el => el.textContent.includes('Elysium'));
      if (elysiumBtn && !elysiumBtn.classList.contains('on')) {
        elysiumBtn.click();
        await new Promise(r => setTimeout(r, 500));
      }
      const afterTitle = document.querySelector('.session-head .head-title')?.textContent?.trim() ?? '';
      return { switched: beforeTitle !== midTitle, beforeTitle, midTitle, afterTitle };
    })()`);
    console.log("2c. Session Switch Check:", sessionSwitchCheck);

    // 3. Switch to PLAN tab -> verify PLAN.md editor + click task card -> verify SubagentInspector updates
    await cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('.seg button')];
      const planBtn = buttons.find(b => b.textContent.trim() === 'PLAN');
      if (!planBtn) throw new Error("PLAN tab button not found");
      planBtn.click();
    })()`);
    await sleep(1000);

    const planBeforeClick = await cdp.eval(`(() => {
      const ta = document.querySelector('.asd-plan-textarea');
      const cards = [...document.querySelectorAll('.asd-task-card')];
      if (cards.length > 0) cards[0].click();
      return {
        planLoaded: (ta?.value?.length ?? 0) > 0,
        taskCardCount: cards.length,
        firstCardId: cards[0]?.querySelector('.asd-task-id')?.textContent ?? null,
      };
    })()`);
    await sleep(600);

    const planAfterClick = await cdp.eval(`(() => {
      const selectedCard = document.querySelector('.asd-task-card.selected .asd-task-id')?.textContent ?? null;
      const inspectorOpen = document.querySelector('.tools-panel.open') !== null;
      const inspectorHead = document.querySelector('.tools-panel .tool-sec h4')?.textContent?.trim() ?? '';
      return { selectedCard, inspectorOpen, inspectorHead };
    })()`);
    console.log("3. PLAN Tab & Task Card Click Check:", { ...planBeforeClick, ...planAfterClick });

    // 4. Switch to Routing tab -> verify config.agents & config.categories render without white screen (Defect 2 check)
    await cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('.seg button')];
      const routingBtn = buttons.find(b => b.textContent.trim() === 'Routing');
      if (!routingBtn) throw new Error("Routing tab button not found");
      routingBtn.click();
    })()`);
    await sleep(1000);

    const routingCheck = await cdp.eval(`(() => {
      const entries = [...document.querySelectorAll('.asd-routing-entry')];
      return {
        hasRoutingPanel: !!document.querySelector('.asd-routing-panel'),
        entryCount: entries.length,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    })()`);
    console.log("4. Routing Tab Check (Defect 2):", routingCheck);

    // 5. Open WorktreeDiffModal -> check diff modal & 409 notice -> close
    await cdp.eval(`(() => {
      const diffBtn = document.querySelector('.tools-dock button[aria-label="워크트리 Diff 모달 열기"]')
        || [...document.querySelectorAll('.session-head button')].find(b => b.textContent.includes('Diff'));
      if (!diffBtn) throw new Error("Diff button not found");
      diffBtn.click();
    })()`);
    await sleep(1000);

    const diffCheck = await cdp.eval(`(() => {
      const modal = document.querySelector('.asd-diff-modal');
      const footText = modal?.querySelector('.asd-diff-foot')?.textContent ?? '';
      return {
        modalOpen: !!modal,
        has409Notice: footText.includes('merge_conflict') && footText.includes('409'),
      };
    })()`);
    console.log("5. WorktreeDiffModal Check:", diffCheck);

    // Close Diff Modal
    await cdp.eval(`(() => {
      const closeBtn = document.querySelector('.asd-diff-modal button[aria-label="닫기"]');
      if (closeBtn) closeBtn.click();
    })()`);
    await sleep(400);

    // 6. Open TerminalPane -> verify xterm container mounts & resize works
    await cdp.eval(`(() => {
      const termBtn = document.querySelector('.tools-dock button[aria-label="새 터미널 탭 열기"]');
      if (!termBtn) throw new Error("Terminal button not found");
      termBtn.click();
    })()`);
    await sleep(1000);

    const termCheck = await cdp.eval(`(() => {
      const pane = document.querySelector('.asd-terminal-pane');
      const xterm = document.querySelector('.xterm');
      const bodyText = document.body.innerText;
      const leakMatch = bodyText.match(/\\b(common|nav|routing|driver|session)\\.[a-z]+_[a-z_]+\\b/i);
      const i18nLeak = !!leakMatch;
      return {
        hasTerminalPane: !!pane,
        hasXtermDom: !!xterm,
        i18nLeak,
        leakSample: leakMatch ? leakMatch[0] : null,
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      };
    })()`);
    console.log("6. TerminalPane & i18n Check:", termCheck);

    console.log("Console Errors:", cdp.consoleErrors);
    console.log("Uncaught Exceptions:", cdp.exceptions);

    if (
      !welcomeCheck.hasApp ||
      welcomeCheck.scrollWidth > 1440 ||
      welcomeCheck.scrollHeight > 900 ||
      !chatCheck.hasDriverBar ||
      chatCheck.scrollWidth > 1440 ||
      chatCheck.scrollHeight > 900 ||
      !planBeforeClick.planLoaded ||
      planBeforeClick.taskCardCount === 0 ||
      !planAfterClick.selectedCard ||
      !planAfterClick.inspectorOpen ||
      routingCheck.entryCount < 5 ||
      !diffCheck.modalOpen ||
      !diffCheck.has409Notice ||
      !termCheck.hasTerminalPane ||
      !termCheck.hasXtermDom ||
      termCheck.i18nLeak ||
      cdp.consoleErrors.length > 0 ||
      cdp.exceptions.length > 0
    ) {
      process.exitCode = 1;
    }

    ws.close();
  } finally {
    srv.child.kill();
    chr.child.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
