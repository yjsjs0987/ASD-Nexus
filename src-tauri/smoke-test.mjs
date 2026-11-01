import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const exePath = path.resolve("src-tauri/target/debug/asd-gui.exe");
if (!fs.existsSync(exePath)) {
  throw new Error("Tauri debug exe not found: " + exePath);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "asd-tauri-smoke-"));
fs.mkdirSync(path.join(tempHome, ".asd", "state"), { recursive: true });
const realRouting = path.join(os.homedir(), ".asd", "routing.jsonc");
if (fs.existsSync(realRouting)) {
  fs.copyFileSync(realRouting, path.join(tempHome, ".asd", "routing.jsonc"));
}

const child = spawn(exePath, [], {
  env: { ...process.env, ASD_TAURI_SMOKE_TEST: "1", ASD_GUI_HOME: tempHome },
  stdio: ["ignore", "pipe", "pipe"],
});

let readyPayload = null;
let httpVerified = false;

child.stdout.on("data", async (chunk) => {
  const text = chunk.toString("utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line.trim());
      if (parsed.type === "asd-tauri-ready") {
        readyPayload = parsed;
        console.log("Tauri ready received:", parsed);
        const res = await fetch(`http://127.0.0.1:${parsed.port}/`);
        const html = await res.text();
        httpVerified = res.status === 200 && html.includes('<div id="root">');
        console.log("HTTP check against spawned server:", {
          status: res.status,
          httpVerified,
        });
      }
    } catch {}
  }
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(chunk);
});

child.on("exit", async (code) => {
  console.log("Tauri exe exited with code:", code);
  let serverKilled = false;
  if (readyPayload) {
    try {
      await fetch(`http://127.0.0.1:${readyPayload.port}/`);
    } catch {
      serverKilled = true;
    }
  }
  console.log("Child server cleanup verified:", serverKilled);
  if (code !== 0 || !readyPayload || !httpVerified || !serverKilled) {
    process.exit(1);
  }
});
