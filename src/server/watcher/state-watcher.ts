/**
 * Project state watcher & incremental log streamer (GUI_ARCHITECTURE.md 6.3).
 *
 * Rules:
 * 1. Watches ~/.asd/state/<hash>/core.db, core.db-wal, <project>/.asd/sessions/**, cli-recent.json, PLAN.md.
 * 2. 300ms trailing debounce on state/metadata changes.
 * 3. Compares session (updated_at, state_version) + task (task_id, status, attempts, commit_sha) digest
 *    before running `collectDashboardSnapshot` and broadcasting `state_updated`.
 * 4. Ignores `output.log` and `.tmp` changes for snapshot recalculation; streams `output.log`
 *    increments via `subagent_log_chunk` / `driver_output_chunk`, and emits `log_closed` on finish/delete.
 * 5. Diffs task statuses to emit `task_status_changed`.
 * 6. Runs a 2-second lightweight DB digest poll per subscribed project for Windows WAL reliability.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WebSocket } from "ws";
import {
  collectDashboardSnapshot,
  discoverHarnessModels,
  getForegroundSessionId,
  recoverOrphanedTasks,
  resolveAsdPaths,
  runGit,
  type DashboardSnapshot,
  type TaskStatus,
} from "../core-api.ts";
import type { ServerContext } from "../context.ts";
import type { ServerWsMessage } from "../../shared/protocol.ts";

export interface EnrichedSnapshot extends DashboardSnapshot {
  isGitRepo: boolean;
  gitBranch: string | null;
  gitHeadSha: string | null;
  foregroundSessionId: string | null;
}

export function getProjectGitInfo(projectRoot: string): {
  isGitRepo: boolean;
  gitBranch: string | null;
  gitHeadSha: string | null;
} {
  try {
    const inside = runGit(["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
    });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return { isGitRepo: false, gitBranch: null, gitHeadSha: null };
    }
    const branchRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
    });
    const shaRes = runGit(["rev-parse", "--short", "HEAD"], {
      cwd: projectRoot,
    });
    return {
      isGitRepo: true,
      gitBranch: branchRes.exitCode === 0 ? branchRes.stdout.trim() : null,
      gitHeadSha: shaRes.exitCode === 0 ? shaRes.stdout.trim() : null,
    };
  } catch {
    return { isGitRepo: false, gitBranch: null, gitHeadSha: null };
  }
}

export async function collectEnrichedSnapshot(
  projectRoot: string,
  homeDir: string
): Promise<EnrichedSnapshot> {
  await discoverHarnessModels({ projectRoot, homeDir, skipCliSpawn: true });
  const snapshot = await collectDashboardSnapshot({ projectRoot, homeDir });
  const gitInfo = getProjectGitInfo(projectRoot);
  const foregroundSessionId = getForegroundSessionId(projectRoot);
  return {
    ...snapshot,
    ...gitInfo,
    foregroundSessionId,
  };
}

interface LogSubscription {
  key: string;
  projectRoot: string;
  sessionId: string;
  subSessionId?: string;
  runId?: string;
  driverId?: string;
  filePath: string;
  offset: number;
  clients: Set<WebSocket>;
  closedEmitted: boolean;
}

interface WatchedProject {
  projectRoot: string;
  clients: Set<WebSocket>;
  watchers: fs.FSWatcher[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastDigest: string;
  lastTaskStatuses: Map<string, TaskStatus>;
}

export class StateWatcher {
  private readonly context: ServerContext;
  private readonly projects = new Map<string, WatchedProject>();
  private readonly logSubs = new Map<string, LogSubscription>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private logPollTimer: ReturnType<typeof setInterval> | null = null;
  private orphanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly debounceMs: number;

  constructor(context: ServerContext, options?: { debounceMs?: number }) {
    this.context = context;
    this.debounceMs = options?.debounceMs ?? 300;

    // Poll for WAL / nested session changes & orphan checks
    const pollIntervalMs = Math.max(200, Math.min(1000, this.debounceMs * 2));
    this.pollTimer = setInterval(() => {
      for (const wp of this.projects.values()) {
        if (wp.clients.size > 0) {
          void this.checkAndEmitProjectUpdate(wp);
        }
      }
    }, pollIntervalMs);
    this.pollTimer.unref?.();

    // 100ms incremental log tailer
    this.logPollTimer = setInterval(() => {
      this.flushAllLogSubscriptions();
    }, 100);
    this.logPollTimer.unref?.();

    // 30s periodic orphan recovery sweep (Section 6.5-3)
    this.orphanTimer = setInterval(() => {
      for (const wp of this.projects.values()) {
        this.runOrphanSweep(wp.projectRoot);
      }
    }, 30_000);
    this.orphanTimer.unref?.();
  }

  runOrphanSweep(projectRoot: string): Array<{
    sessionId: string;
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    reason: string;
  }> {
    try {
      const db = this.context.getDb(projectRoot);
      const recovered = recoverOrphanedTasks({ db, projectRoot });
      for (const r of recovered) {
        this.broadcastToProject(projectRoot, {
          type: "task_status_changed",
          projectRoot,
          sessionId: r.sessionId,
          taskId: r.taskId,
          from: r.from,
          to: r.to,
          reason: r.reason,
        });
      }
      if (recovered.length > 0) {
        void this.forceBroadcastProject(projectRoot);
      }
      return recovered;
    } catch {
      return [];
    }
  }

  private normalizeKey(projectRoot: string): string {
    const resolved = path.resolve(projectRoot);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  subscribeProject(client: WebSocket, projectRoot: string): WatchedProject {
    const resolved = path.resolve(projectRoot);
    const key = this.normalizeKey(resolved);
    let wp = this.projects.get(key);
    if (!wp) {
      wp = {
        projectRoot: resolved,
        clients: new Set(),
        watchers: [],
        debounceTimer: null,
        lastDigest: "",
        lastTaskStatuses: new Map(),
      };
      this.projects.set(key, wp);
      this.setupFsWatchers(wp);
    }
    wp.clients.add(client);
    return wp;
  }

  unsubscribeProject(client: WebSocket, projectRoot?: string): void {
    if (projectRoot) {
      const key = this.normalizeKey(projectRoot);
      const wp = this.projects.get(key);
      if (wp) {
        wp.clients.delete(client);
        if (wp.clients.size === 0) {
          this.teardownWatchedProject(key, wp);
        }
      }
      return;
    }

    for (const [key, wp] of this.projects.entries()) {
      wp.clients.delete(client);
      if (wp.clients.size === 0) {
        this.teardownWatchedProject(key, wp);
      }
    }
    for (const [lKey, sub] of this.logSubs.entries()) {
      sub.clients.delete(client);
      if (sub.clients.size === 0) {
        this.logSubs.delete(lKey);
      }
    }
  }

  subscribeLog(
    client: WebSocket,
    params: {
      projectRoot: string;
      sessionId: string;
      subSessionId?: string;
      runId?: string;
      fromOffset?: number;
    }
  ): void {
    const projectRoot = path.resolve(params.projectRoot);
    const key = `${this.normalizeKey(projectRoot)}::${params.sessionId}::${
      params.subSessionId ?? ""
    }::${params.runId ?? ""}`;

    let filePath = "";
    if (params.subSessionId) {
      filePath = path.join(
        projectRoot,
        ".asd",
        "sessions",
        params.sessionId,
        "subagents",
        params.subSessionId,
        "output.log"
      );
    } else if (params.runId) {
      // Locate driver run output.log under .asd/sessions/<sessionId>/drivers/*/runs/<runId>/output.log
      const driversDir = path.join(
        projectRoot,
        ".asd",
        "sessions",
        params.sessionId,
        "drivers"
      );
      if (fs.existsSync(driversDir)) {
        try {
          for (const d of fs.readdirSync(driversDir, { withFileTypes: true })) {
            if (!d.isDirectory()) continue;
            const candidate = path.join(
              driversDir,
              d.name,
              "runs",
              params.runId,
              "output.log"
            );
            if (fs.existsSync(candidate)) {
              filePath = candidate;
              break;
            }
          }
        } catch {
          // Ignore
        }
      }
    }

    let sub = this.logSubs.get(key);
    if (!sub) {
      sub = {
        key,
        projectRoot,
        sessionId: params.sessionId,
        subSessionId: params.subSessionId,
        runId: params.runId,
        filePath,
        offset: params.fromOffset ?? 0,
        clients: new Set(),
        closedEmitted: false,
      };
      this.logSubs.set(key, sub);
    } else if (params.fromOffset !== undefined) {
      sub.offset = params.fromOffset;
    }
    sub.clients.add(client);
    this.flushSingleLogSubscription(sub);
  }

  unsubscribeLog(
    client: WebSocket,
    params: {
      projectRoot: string;
      sessionId: string;
      subSessionId?: string;
      runId?: string;
    }
  ): void {
    const key = `${this.normalizeKey(params.projectRoot)}::${
      params.sessionId
    }::${params.subSessionId ?? ""}::${params.runId ?? ""}`;
    const sub = this.logSubs.get(key);
    if (!sub) return;
    sub.clients.delete(client);
    if (sub.clients.size === 0) {
      this.logSubs.delete(key);
    }
  }

  private flushAllLogSubscriptions(): void {
    for (const sub of this.logSubs.values()) {
      this.flushSingleLogSubscription(sub);
    }
  }

  private flushSingleLogSubscription(sub: LogSubscription): void {
    if (sub.clients.size === 0) return;

    if (!sub.filePath || !fs.existsSync(sub.filePath)) {
      // Check if meta.json indicates finished or file was deleted (CR-09)
      if (!sub.closedEmitted && sub.subSessionId) {
        const metaPath = path.join(
          sub.projectRoot,
          ".asd",
          "sessions",
          sub.sessionId,
          "subagents",
          sub.subSessionId,
          "meta.json"
        );
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as {
              status?: string;
            };
            if (meta.status === "done" || meta.status === "failed") {
              sub.closedEmitted = true;
              this.sendToClients(sub.clients, {
                type: "log_closed",
                projectRoot: sub.projectRoot,
                sessionId: sub.sessionId,
                subSessionId: sub.subSessionId,
                reason: "deleted",
              });
            }
          } catch {
            // Ignore
          }
        }
      }
      return;
    }

    try {
      const stat = fs.statSync(sub.filePath);
      if (stat.size > sub.offset) {
        const len = stat.size - sub.offset;
        const fd = fs.openSync(sub.filePath, "r");
        try {
          const buf = Buffer.alloc(len);
          const bytesRead = fs.readSync(fd, buf, 0, len, sub.offset);
          if (bytesRead > 0) {
            const chunk = buf.toString("utf8", 0, bytesRead);
            const prevOffset = sub.offset;
            sub.offset += bytesRead;
            if (sub.subSessionId) {
              this.sendToClients(sub.clients, {
                type: "subagent_log_chunk",
                projectRoot: sub.projectRoot,
                sessionId: sub.sessionId,
                subSessionId: sub.subSessionId,
                offset: prevOffset,
                chunk,
              });
            } else if (sub.runId) {
              this.sendToClients(sub.clients, {
                type: "driver_output_chunk",
                projectRoot: sub.projectRoot,
                sessionId: sub.sessionId,
                runId: sub.runId,
                offset: prevOffset,
                chunk,
              });
            }
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      // File may have been unlinked mid-read
    }
  }

  private setupFsWatchers(wp: WatchedProject): void {
    const paths = resolveAsdPaths(wp.projectRoot, this.context.homeDir);
    const stateDir = path.dirname(paths.dbPath);
    const localAsdDir = path.join(wp.projectRoot, ".asd");
    const sessionsDir = path.join(localAsdDir, "sessions");

    for (const dirToWatch of [stateDir, localAsdDir, sessionsDir]) {
      if (!fs.existsSync(dirToWatch)) {
        try {
          fs.mkdirSync(dirToWatch, { recursive: true });
        } catch {
          continue;
        }
      }
      try {
        const realDir = fs.realpathSync.native(dirToWatch);
        const watcher = fs.watch(
          realDir,
          { persistent: false },
          (_eventType, filename) => {
            const name = (filename ?? "").replace(/\\/g, "/");
            // Rule 3: Never recalculate full snapshot on output.log or .tmp changes
            if (
              name.endsWith("output.log") ||
              name.endsWith(".tmp") ||
              name.includes(".tmp.")
            ) {
              this.flushAllLogSubscriptions();
              return;
            }
            this.scheduleDebouncedCheck(wp);
          }
        );
        watcher.on("error", () => {
          // Ignore watcher error; pollTimer remains active
        });
        wp.watchers.push(watcher);
      } catch {
        // Fallback poll still active
      }
    }
  }

  private scheduleDebouncedCheck(wp: WatchedProject): void {
    if (wp.debounceTimer) {
      clearTimeout(wp.debounceTimer);
    }
    wp.debounceTimer = setTimeout(() => {
      wp.debounceTimer = null;
      void this.checkAndEmitProjectUpdate(wp);
    }, this.debounceMs);
  }

  private computeProjectDigest(projectRoot: string): {
    digest: string;
    taskStatuses: Map<string, TaskStatus>;
  } {
    const taskStatuses = new Map<string, TaskStatus>();
    try {
      const db = this.context.getDb(projectRoot);
      const sessions = db.listSessions();
      const tasks = db.getAllTasks();
      const debates = db.getAllDebates();
      const paths = resolveAsdPaths(projectRoot, this.context.homeDir);

      const sessPart = sessions
        .map((s) => `${s.session_id}:${s.updated_at}:${s.state_version}:${s.phase}:${s.memo ?? ""}`)
        .join("|");
      const taskPart = tasks
        .map((t) => {
          const key = `${t.session_id}::${t.task_id}`;
          taskStatuses.set(key, t.status as TaskStatus);
          return `${key}:${t.status}:${t.attempts}:${t.commit_sha ?? ""}`;
        })
        .join("|");
      const debatePart = debates
        .map((d) => `${d.debate_id}:${d.status}`)
        .join("|");

      let cliRecentMtime = 0;
      const cliRecentPath = path.join(
        projectRoot,
        ".asd",
        "sessions",
        "cli-recent.json"
      );
      if (fs.existsSync(cliRecentPath)) {
        try {
          cliRecentMtime = Math.round(fs.statSync(cliRecentPath).mtimeMs);
        } catch {
          // Ignore
        }
      }

      let planMtime = 0;
      if (fs.existsSync(paths.planMdPath)) {
        try {
          planMtime = Math.round(fs.statSync(paths.planMdPath).mtimeMs);
        } catch {
          // Ignore
        }
      }

      const fg = getForegroundSessionId(projectRoot) ?? "";

      return {
        digest: `${sessPart}#${taskPart}#${debatePart}#${cliRecentMtime}#${planMtime}#${fg}`,
        taskStatuses,
      };
    } catch {
      return { digest: "", taskStatuses };
    }
  }

  async forceBroadcastProject(projectRoot: string): Promise<EnrichedSnapshot | null> {
    const key = this.normalizeKey(projectRoot);
    const wp = this.projects.get(key);
    const snapshot = await collectEnrichedSnapshot(
      path.resolve(projectRoot),
      this.context.homeDir
    );
    if (wp && wp.clients.size > 0) {
      const { digest, taskStatuses } = this.computeProjectDigest(wp.projectRoot);
      this.emitTaskDiffs(wp, taskStatuses);
      wp.lastDigest = digest;
      wp.lastTaskStatuses = taskStatuses;
      this.sendToClients(wp.clients, {
        type: "state_updated",
        projectRoot: wp.projectRoot,
        snapshot,
      });
    }
    return snapshot;
  }

  seedInitialBaseline(projectRoot: string): void {
    const key = this.normalizeKey(projectRoot);
    const wp = this.projects.get(key);
    if (!wp) return;
    const { digest, taskStatuses } = this.computeProjectDigest(wp.projectRoot);
    wp.lastDigest = digest;
    wp.lastTaskStatuses = taskStatuses;
  }

  private emitTaskDiffs(
    wp: WatchedProject,
    nextStatuses: Map<string, TaskStatus>
  ): void {
    if (wp.lastDigest === "") return; // Skip diff on initial baseline
    for (const [compositeKey, nextStatus] of nextStatuses.entries()) {
      const prevStatus = wp.lastTaskStatuses.get(compositeKey) ?? null;
      if (prevStatus !== nextStatus) {
        const sepIdx = compositeKey.indexOf("::");
        const sessionId = compositeKey.slice(0, sepIdx);
        const taskId = compositeKey.slice(sepIdx + 2);
        this.sendToClients(wp.clients, {
          type: "task_status_changed",
          projectRoot: wp.projectRoot,
          sessionId,
          taskId,
          from: prevStatus,
          to: nextStatus,
        });
      }
    }
  }

  private async checkAndEmitProjectUpdate(wp: WatchedProject): Promise<void> {
    if (wp.clients.size === 0) return;
    const { digest, taskStatuses } = this.computeProjectDigest(wp.projectRoot);
    if (!digest || digest === wp.lastDigest) {
      return;
    }

    this.emitTaskDiffs(wp, taskStatuses);
    wp.lastDigest = digest;
    wp.lastTaskStatuses = taskStatuses;

    try {
      const snapshot = await collectEnrichedSnapshot(
        wp.projectRoot,
        this.context.homeDir
      );
      this.sendToClients(wp.clients, {
        type: "state_updated",
        projectRoot: wp.projectRoot,
        snapshot,
      });
    } catch {
      // Ignore transient snapshot errors
    }
  }

  broadcastToProject(projectRoot: string, msg: ServerWsMessage): void {
    const key = this.normalizeKey(projectRoot);
    const wp = this.projects.get(key);
    if (!wp) return;
    this.sendToClients(wp.clients, msg);
  }

  private sendToClients(clients: Set<WebSocket>, msg: ServerWsMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  private teardownWatchedProject(key: string, wp: WatchedProject): void {
    if (wp.debounceTimer) {
      clearTimeout(wp.debounceTimer);
      wp.debounceTimer = null;
    }
    for (const w of wp.watchers) {
      try {
        w.close();
      } catch {
        // Ignore
      }
    }
    wp.watchers = [];
    this.projects.delete(key);
  }

  close(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.logPollTimer) {
      clearInterval(this.logPollTimer);
      this.logPollTimer = null;
    }
    if (this.orphanTimer) {
      clearInterval(this.orphanTimer);
      this.orphanTimer = null;
    }
    for (const [key, wp] of this.projects.entries()) {
      this.teardownWatchedProject(key, wp);
    }
    this.logSubs.clear();
  }
}
