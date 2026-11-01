/**
 * PTY Manager (src/server/pty/pty-manager.ts) — GUI_ARCHITECTURE.md 6.4-6 & 6.8.
 */

import * as path from "node:path";
import type { WebSocket } from "ws";
import {
  buildInteractiveResumeHarnessCommand,
  killProcessTree,
  resolveSpawnCommand,
  type HarnessId,
} from "../core-api.ts";
import {
  validateProjectRoot,
  validateSessionId,
  validateSubPath,
} from "../context.ts";
import type { ClientWsMessage, ServerWsMessage } from "../../shared/protocol.ts";

export interface IPtyProcess {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void } | void;
  onExit(
    listener: (e: { exitCode: number; signal?: number }) => void
  ): { dispose(): void } | void;
}

export interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      useConpty?: boolean;
    }
  ): IPtyProcess;
}

interface ManagedPtyTab {
  tabId: string;
  projectRoot: string;
  cwd: string;
  harness?: HarnessId;
  harnessSessionId?: string;
  asDriverOf?: { sessionId: string; driverId: string };
  pty: IPtyProcess;
  clients: Set<WebSocket>;
  disconnectTimer: ReturnType<typeof setTimeout> | null;
  recentBuffer: string;
}

export interface PtyManagerOptions {
  maxTabs?: number;
  gracePeriodMs?: number;
  forceDisablePty?: boolean;
  ptyModuleOverride?: NodePtyModule | null;
}

const MAX_RECENT_BUFFER = 64 * 1024;

export class PtyManager {
  private readonly tabs = new Map<string, ManagedPtyTab>();
  private readonly maxTabs: number;
  private readonly gracePeriodMs: number;
  private readonly forceDisablePty: boolean;
  private ptyModule: NodePtyModule | null | undefined;
  private initPromise: Promise<NodePtyModule | null> | null = null;

  constructor(options?: PtyManagerOptions) {
    this.maxTabs = options?.maxTabs ?? 8;
    this.gracePeriodMs = options?.gracePeriodMs ?? 60_000;
    this.forceDisablePty = Boolean(options?.forceDisablePty);
    if (options?.ptyModuleOverride !== undefined) {
      this.ptyModule = options.ptyModuleOverride;
    }
  }

  async ensureLoaded(): Promise<NodePtyModule | null> {
    if (this.forceDisablePty) {
      this.ptyModule = null;
      return null;
    }
    if (this.ptyModule !== undefined) {
      return this.ptyModule;
    }
    if (!this.initPromise) {
      this.initPromise = (async () => {
        try {
          const mod = (await import("node-pty")) as unknown as {
            default?: NodePtyModule;
            spawn?: NodePtyModule["spawn"];
          };
          const resolved: NodePtyModule | null =
            typeof mod.spawn === "function"
              ? (mod as unknown as NodePtyModule)
              : mod.default && typeof mod.default.spawn === "function"
                ? mod.default
                : null;
          this.ptyModule = resolved;
          return resolved;
        } catch {
          this.ptyModule = null;
          return null;
        }
      })();
    }
    return await this.initPromise;
  }

  isAvailable(): boolean {
    if (this.forceDisablePty) return false;
    return Boolean(this.ptyModule);
  }

  private sendToClient(client: WebSocket, msg: ServerWsMessage): void {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(msg));
    }
  }

  private broadcastToTab(tab: ManagedPtyTab, msg: ServerWsMessage): void {
    const payload = JSON.stringify(msg);
    for (const c of tab.clients) {
      if (c.readyState === c.OPEN) {
        c.send(payload);
      }
    }
  }

  async handleMessage(
    client: WebSocket,
    msg: Extract<
      ClientWsMessage,
      { type: "pty_spawn" | "pty_input" | "pty_resize" | "pty_kill" }
    >
  ): Promise<void> {
    switch (msg.type) {
      case "pty_spawn": {
        const existing = this.tabs.get(msg.tabId);
        if (existing) {
          if (existing.disconnectTimer) {
            clearTimeout(existing.disconnectTimer);
            existing.disconnectTimer = null;
          }
          existing.clients.add(client);
          if (existing.recentBuffer) {
            this.sendToClient(client, {
              type: "pty_output",
              tabId: existing.tabId,
              data: existing.recentBuffer,
            });
          }
          return;
        }

        const projectRoot = validateProjectRoot(msg.projectRoot);
        const cwd = validateSubPath(projectRoot, msg.cwd);
        if (msg.asDriverOf) {
          validateSessionId(msg.asDriverOf.sessionId);
        }

        if (this.tabs.size >= this.maxTabs) {
          this.sendToClient(client, {
            type: "pty_error",
            tabId: msg.tabId,
            message: `MAX_TABS_EXCEEDED: 최대 터미널 탭 수(${this.maxTabs}개)를 초과했습니다.`,
          });
          return;
        }

        const ptyMod = await this.ensureLoaded();
        if (!ptyMod) {
          const fallbackHint = msg.harness
            ? buildInteractiveResumeHarnessCommand(
                msg.harness,
                msg.harnessSessionId ?? null,
                msg.model ?? null
              ).cliString
            : "";
          this.sendToClient(client, {
            type: "pty_error",
            tabId: msg.tabId,
            message: `NODE_PTY_UNAVAILABLE: 터미널 사용 불가 — 아래 명령을 직접 터미널에 붙여넣으세요${
              fallbackHint ? `: ${fallbackHint}` : ""
            }`,
          });
          return;
        }

        let spawnCmd: string;
        let spawnArgs: string[];

        if (msg.harness) {
          const interactive = buildInteractiveResumeHarnessCommand(
            msg.harness,
            msg.harnessSessionId ?? null,
            msg.model ?? null
          );
          const resolved = resolveSpawnCommand(
            interactive.command,
            interactive.args
          );
          spawnCmd = resolved.cmd;
          spawnArgs = resolved.args;
        } else {
          spawnCmd =
            process.platform === "win32"
              ? "powershell.exe"
              : process.env.SHELL || "/bin/bash";
          spawnArgs = process.platform === "win32" ? ["-NoLogo"] : [];
        }

        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === "string") {
            env[k] = v;
          }
        }
        if (msg.asDriverOf) {
          env.ASD_SESSION_ROLE = "driver";
          env.ASD_MAIN_SESSION_ID = msg.asDriverOf.sessionId;
          env.ASD_DRIVER_ID = msg.asDriverOf.driverId;
        }

        const cols = Math.max(20, Math.min(500, msg.cols || 80));
        const rows = Math.max(5, Math.min(200, msg.rows || 24));

        try {
          const ptyProc = ptyMod.spawn(spawnCmd, spawnArgs, {
            name: "xterm-256color",
            cols,
            rows,
            cwd,
            env,
            useConpty: process.platform === "win32",
          });

          const tab: ManagedPtyTab = {
            tabId: msg.tabId,
            projectRoot,
            cwd,
            harness: msg.harness,
            harnessSessionId: msg.harnessSessionId,
            asDriverOf: msg.asDriverOf,
            pty: ptyProc,
            clients: new Set([client]),
            disconnectTimer: null,
            recentBuffer: "",
          };
          this.tabs.set(msg.tabId, tab);

          ptyProc.onData((data) => {
            tab.recentBuffer = (tab.recentBuffer + data).slice(
              -MAX_RECENT_BUFFER
            );
            this.broadcastToTab(tab, {
              type: "pty_output",
              tabId: tab.tabId,
              data,
            });
          });

          ptyProc.onExit(({ exitCode }) => {
            if (tab.disconnectTimer) {
              clearTimeout(tab.disconnectTimer);
              tab.disconnectTimer = null;
            }
            this.broadcastToTab(tab, {
              type: "pty_exit",
              tabId: tab.tabId,
              exitCode: exitCode ?? 0,
            });
            this.tabs.delete(tab.tabId);
          });
        } catch (err: unknown) {
          this.sendToClient(client, {
            type: "pty_error",
            tabId: msg.tabId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }

      case "pty_input": {
        const tab = this.tabs.get(msg.tabId);
        if (tab && typeof msg.data === "string") {
          try {
            tab.pty.write(msg.data);
          } catch {
            // Ignore write error on closing PTY
          }
        }
        return;
      }

      case "pty_resize": {
        const tab = this.tabs.get(msg.tabId);
        if (tab) {
          const cols = Math.max(20, Math.min(500, msg.cols || 80));
          const rows = Math.max(5, Math.min(200, msg.rows || 24));
          try {
            tab.pty.resize(cols, rows);
          } catch {
            // Ignore resize error
          }
        }
        return;
      }

      case "pty_kill": {
        this.killTab(msg.tabId);
        return;
      }
    }
  }

  handleClientDisconnect(client: WebSocket): void {
    for (const tab of this.tabs.values()) {
      tab.clients.delete(client);
      if (tab.clients.size === 0 && !tab.disconnectTimer) {
        tab.disconnectTimer = setTimeout(() => {
          tab.disconnectTimer = null;
          if (tab.clients.size === 0) {
            this.killTab(tab.tabId);
          }
        }, this.gracePeriodMs);
        tab.disconnectTimer.unref?.();
      }
    }
  }

  killTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (tab.disconnectTimer) {
      clearTimeout(tab.disconnectTimer);
      tab.disconnectTimer = null;
    }
    this.tabs.delete(tabId);
    try {
      if (tab.pty.pid) {
        killProcessTree(tab.pty.pid);
      }
      tab.pty.kill();
    } catch {
      // Ignore kill errors
    }
    return true;
  }

  async closeTabsInPath(targetDir: string): Promise<number> {
    const resolvedTarget = path.resolve(targetDir);
    const normTarget =
      process.platform === "win32"
        ? resolvedTarget.toLowerCase()
        : resolvedTarget;

    let closedCount = 0;
    for (const tab of [...this.tabs.values()]) {
      const normCwd =
        process.platform === "win32"
          ? path.resolve(tab.cwd).toLowerCase()
          : path.resolve(tab.cwd);
      const rel = path.relative(normTarget, normCwd);
      const isInside =
        normCwd === normTarget ||
        (!rel.startsWith("..") && !path.isAbsolute(rel));
      if (isInside) {
        this.broadcastToTab(tab, {
          type: "pty_exit",
          tabId: tab.tabId,
          exitCode: 0,
        });
        this.killTab(tab.tabId);
        closedCount++;
      }
    }
    return closedCount;
  }

  getActiveTabs(): Array<{
    tabId: string;
    cwd: string;
    harness?: HarnessId;
    asDriverOf?: { sessionId: string; driverId: string };
  }> {
    return [...this.tabs.values()].map((t) => ({
      tabId: t.tabId,
      cwd: t.cwd,
      harness: t.harness,
      asDriverOf: t.asDriverOf,
    }));
  }

  closeAll(): void {
    for (const tabId of [...this.tabs.keys()]) {
      this.killTab(tabId);
    }
  }
}
