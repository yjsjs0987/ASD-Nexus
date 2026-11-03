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

import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { WebSocket } from "ws";
import {
  collectDashboardSnapshot,
  discoverProjectCliSessions,
  getForegroundSessionId,
  recoverOrphanedTasks,
  resolveAsdPaths,
  resolveSpawnCommand,
  runGit,
  type CliRecentSessionEntry,
  type DashboardSnapshot,
  type DriverRow,
  type HarnessId,
  type HarnessModelCatalog,
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

const projectGitInfoCache = new Map<
  string,
  {
    expiresAt: number;
    value: { isGitRepo: boolean; gitBranch: string | null; gitHeadSha: string | null };
  }
>();
const GIT_INFO_CACHE_TTL_MS = 10_000;

export function getProjectGitInfo(projectRoot: string): {
  isGitRepo: boolean;
  gitBranch: string | null;
  gitHeadSha: string | null;
} {
  const key = path.resolve(projectRoot).replaceAll("\\", "/").toLowerCase();
  const now = Date.now();
  const cached = projectGitInfoCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const inside = runGit(["rev-parse", "--is-inside-work-tree"], {
      cwd: projectRoot,
    });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      const value = { isGitRepo: false, gitBranch: null, gitHeadSha: null };
      projectGitInfoCache.set(key, { expiresAt: now + GIT_INFO_CACHE_TTL_MS, value });
      return value;
    }
    const branchRes = runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: projectRoot,
    });
    const shaRes = runGit(["rev-parse", "--short", "HEAD"], {
      cwd: projectRoot,
    });
    const value = {
      isGitRepo: true,
      gitBranch: branchRes.exitCode === 0 ? branchRes.stdout.trim() : null,
      gitHeadSha: shaRes.exitCode === 0 ? shaRes.stdout.trim() : null,
    };
    projectGitInfoCache.set(key, { expiresAt: now + GIT_INFO_CACHE_TTL_MS, value });
    return value;
  } catch {
    const value = { isGitRepo: false, gitBranch: null, gitHeadSha: null };
    projectGitInfoCache.set(key, { expiresAt: now + GIT_INFO_CACHE_TTL_MS, value });
    return value;
  }
}

const STANDARD_HARNESS_MODELS: Record<HarnessId, string[]> = {
  "claude-code": [
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-sonnet-4-5",
    "claude-opus-4-5",
    "claude-haiku-4-5",
    "sonnet",
    "opus",
    "haiku",
  ],
  codex: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2-codex",
    "gpt-5.2",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
  ],
  opencode: [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-6",
    "openai/gpt-5.4",
    "openai/gpt-5.3-codex",
    "google/gemini-2.5-pro",
    "google/gemini-2.5-flash",
  ],
  antigravity: [
    "gemini-4-argon-medium",
    "gemini-4-argon-high",
    "gemini-4-argon-low",
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "claude-opus-5-5-high",
    "claude-opus-5-5-medium",
    "claude-opus-5-5-low",
    "claude-sonnet-5-5-high",
    "claude-sonnet-5-5-medium",
    "claude-sonnet-5-5-low",
    "gpt-oss-120b-medium",
  ],
  cursor: [
    "auto",
    "composer-2",
    "claude-sonnet-4.6",
    "claude-opus-4.6",
    "gpt-5.4",
    "gemini-2.5-pro",
  ],
};

const asyncCliModelsCache: Record<HarnessId, Set<string>> = {
  "claude-code": new Set<string>(),
  codex: new Set<string>(),
  opencode: new Set<string>(),
  antigravity: new Set<string>(),
  cursor: new Set<string>(),
};
let asyncCliScanInFlight: Promise<void> | null = null;
let asyncCliScanCompleted = false;

function runCliLinesAsync(bin: string, args: string[], timeoutMs = 4500): Promise<string[]> {
  return new Promise((resolve) => {
    try {
      const resolved = resolveSpawnCommand(bin, args);
      const child = child_process.spawn(resolved.command, resolved.args, {
        windowsHide: true,
        shell: resolved.shell,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve([]);
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve([]);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(stdout.split(/\r?\n/));
      });
    } catch {
      resolve([]);
    }
  });
}

export async function refreshAsyncCliModels(force = false): Promise<boolean> {
  if (asyncCliScanCompleted && !force) return false;
  if (asyncCliScanInFlight) {
    await asyncCliScanInFlight;
    return true;
  }
  asyncCliScanInFlight = (async () => {
    const [agyLines, opencodeLines] = await Promise.all([
      runCliLinesAsync("agy", ["models"]),
      runCliLinesAsync("opencode", ["models"]),
    ]);
    for (const rawLine of agyLines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("Fetching")) continue;
      const firstCol = line.split("\t")[0]?.trim();
      if (firstCol && !firstCol.includes(" ")) {
        asyncCliModelsCache.antigravity.add(firstCol);
      }
    }
    for (const rawLine of opencodeLines) {
      const line = rawLine.trim();
      if (
        line &&
        line.includes("/") &&
        !line.startsWith("INFO") &&
        !line.startsWith("WARN") &&
        !line.includes(" ")
      ) {
        asyncCliModelsCache.opencode.add(line);
      }
    }
    asyncCliScanCompleted = true;
  })().finally(() => {
    asyncCliScanInFlight = null;
  });
  await asyncCliScanInFlight;
  return true;
}

function normalizeModelId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.includes(" ")) {
    // Convert UI display name like "Gemini 4 Argon (Medium)" -> "gemini-4-argon-medium"
    return trimmed
      .toLowerCase()
      .replace(/[()[\]]/g, " ")
      .trim()
      .replace(/\s+/g, "-");
  }
  return trimmed;
}

export function buildMergedModelCatalog(
  baseCatalog: HarnessModelCatalog,
  homeDir: string
): HarnessModelCatalog {
  const homes = Array.from(new Set([homeDir, os.homedir()].filter(Boolean)));
  const sets: Record<HarnessId, Set<string>> = {
    "claude-code": new Set(),
    codex: new Set(),
    opencode: new Set(),
    antigravity: new Set(),
    cursor: new Set(),
  };

  for (const h of Object.keys(sets) as HarnessId[]) {
    for (const raw of baseCatalog[h] ?? []) {
      const m = normalizeModelId(raw);
      if (m) sets[h].add(m);
    }
  }

  for (const h of homes) {
    // Antigravity settings
    try {
      const agySettingsPath = path.join(h, ".gemini", "antigravity-cli", "settings.json");
      if (fs.existsSync(agySettingsPath)) {
        const agySettings = JSON.parse(fs.readFileSync(agySettingsPath, "utf8")) as {
          model?: string;
        };
        if (agySettings.model?.trim()) {
          const norm = normalizeModelId(agySettings.model);
          if (norm) sets.antigravity.add(norm);
        }
      }
    } catch {}

    // Codex models_cache.json & config.toml
    try {
      const codexCachePath = path.join(h, ".codex", "models_cache.json");
      if (fs.existsSync(codexCachePath)) {
        const cacheObj = JSON.parse(fs.readFileSync(codexCachePath, "utf8")) as {
          models?: Array<{ slug?: string }>;
        };
        for (const item of cacheObj.models ?? []) {
          if (item?.slug?.trim()) sets.codex.add(item.slug.trim());
        }
      }
      const codexTomlPath = path.join(h, ".codex", "config.toml");
      if (fs.existsSync(codexTomlPath)) {
        const tomlText = fs.readFileSync(codexTomlPath, "utf8");
        for (const m of tomlText.matchAll(/^\s*model\s*=\s*["']([^"']+)["']/gm)) {
          if (m[1]?.trim()) sets.codex.add(m[1].trim());
        }
      }
    } catch {}

    // Claude settings.json
    try {
      const claudeSettingsPath = path.join(h, ".claude", "settings.json");
      if (fs.existsSync(claudeSettingsPath)) {
        const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8")) as {
          model?: string;
          env?: Record<string, string>;
        };
        if (settings.model?.trim()) sets["claude-code"].add(settings.model.trim());
        const envObj = settings.env ?? {};
        for (const k of [
          "ANTHROPIC_MODEL",
          "ANTHROPIC_CUSTOM_MODEL_OPTION",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        ]) {
          const v = envObj[k]?.trim();
          if (v) {
            sets["claude-code"].add(v);
            sets["claude-code"].add(v.replace(/\[.*\]$/, "").trim());
          }
        }
      }
    } catch {}
  }

  for (const harness of Object.keys(sets) as HarnessId[]) {
    for (const m of asyncCliModelsCache[harness]) {
      const norm = normalizeModelId(m);
      if (norm) sets[harness].add(norm);
    }
    for (const m of STANDARD_HARNESS_MODELS[harness]) {
      sets[harness].add(m);
    }
  }

  return {
    "claude-code": Array.from(sets["claude-code"]),
    codex: Array.from(sets.codex),
    opencode: Array.from(sets.opencode),
    antigravity: Array.from(sets.antigravity),
    cursor: Array.from(sets.cursor),
  };
}

function mergeDiscoveredCliSessions(
  projectRoot: string,
  homeDir: string,
  existing: CliRecentSessionEntry[]
): CliRecentSessionEntry[] {
  const discovered = discoverProjectCliSessions(projectRoot, { homeDir });
  const byKey = new Map<string, CliRecentSessionEntry>();

  for (const item of [...existing, ...discovered]) {
    const isSes =
      item.harnessSessionId.startsWith("ses_") ||
      Boolean(
        item.transcriptPath &&
          /[\\/]ses_[A-Za-z0-9_-]+\.jsonl$/i.test(item.transcriptPath)
      );
    const correctedHarness: HarnessId = isSes ? "opencode" : item.harness;
    const key = `${correctedHarness}::${item.harnessSessionId}`;
    const prev = byKey.get(key);
    if (prev) {
      byKey.set(key, {
        ...prev,
        harness: correctedHarness,
        model: prev.model || item.model || null,
        summary: prev.summary || item.summary || "",
        transcriptPath: prev.transcriptPath || item.transcriptPath || null,
        asdSessionId: item.asdSessionId ?? prev.asdSessionId ?? null,
        updatedAt: Math.max(prev.updatedAt || 0, item.updatedAt || 0),
      });
    } else {
      byKey.set(key, {
        ...item,
        harness: correctedHarness,
      });
    }
  }

  return Array.from(byKey.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

const rememberedForegroundByProject = new Map<string, string>();

export function setRememberedForegroundSessionId(
  projectRoot: string,
  sessionId: string | null
): void {
  const key = path.resolve(projectRoot).replaceAll("\\", "/").toLowerCase();
  if (sessionId && sessionId.trim()) {
    rememberedForegroundByProject.set(key, sessionId.trim());
  } else {
    rememberedForegroundByProject.delete(key);
  }
}

export function getRememberedForegroundSessionId(
  projectRoot: string
): string | null {
  const key = path.resolve(projectRoot).replaceAll("\\", "/").toLowerCase();
  return rememberedForegroundByProject.get(key) ?? null;
}

export async function collectEnrichedSnapshot(
  projectRoot: string,
  homeDir: string
): Promise<EnrichedSnapshot> {
  if (
    !asyncCliScanCompleted &&
    !asyncCliScanInFlight &&
    !process.env.NODE_TEST_CONTEXT &&
    process.env.NODE_ENV !== "test"
  ) {
    void refreshAsyncCliModels().catch(() => {});
  }
  const snapshot = await collectDashboardSnapshot({
    projectRoot,
    homeDir,
    skipCliSpawn: true,
  });
  const availableModels = buildMergedModelCatalog(snapshot.availableModels, homeDir);
  const gitInfo = getProjectGitInfo(projectRoot);
  const rememberedFg = getRememberedForegroundSessionId(projectRoot);
  const rawFg = rememberedFg ?? getForegroundSessionId(projectRoot);
  const matchedFg =
    rawFg &&
    (snapshot.sessions.find((s) => s.session_id === rawFg)?.session_id ??
      snapshot.sessions.find((s) => s.session_id.startsWith(`${rawFg}::`))
        ?.session_id);
  const foregroundSessionId = matchedFg ?? snapshot.session?.session_id ?? null;
  const activeSession =
    (foregroundSessionId
      ? snapshot.sessions.find((s) => s.session_id === foregroundSessionId)
      : null) ??
    snapshot.session ??
    null;
  const activeTasks = activeSession
    ? (snapshot.allTasks ?? []).filter(
        (t) => t.session_id === activeSession.session_id
      )
    : snapshot.tasks;
  const activeDebates = activeSession
    ? (snapshot.allDebates ?? []).filter(
        (d) => d.session_id === activeSession.session_id
      )
    : snapshot.debates;

  const cliRecentSessions = mergeDiscoveredCliSessions(
    projectRoot,
    homeDir,
    snapshot.cliRecentSessions ?? []
  );

  const normalizedDrivers: Record<string, DriverRow[]> = {};
  for (const [sid, list] of Object.entries(snapshot.drivers ?? {})) {
    normalizedDrivers[sid] = list.map((d) => {
      const fixedHarness =
        d.harness_session_id && d.harness_session_id.startsWith("ses_")
          ? "opencode"
          : d.harness;
      const fixedModel = d.model ? normalizeModelId(d.model) : d.model;
      return {
        ...d,
        harness: fixedHarness,
        model: fixedModel,
      };
    });
  }
  for (const s of snapshot.sessions ?? []) {
    if (s.session_id.includes("::") && !normalizedDrivers[s.session_id]) {
      const baseSid = s.session_id.slice(0, s.session_id.indexOf("::"));
      if (normalizedDrivers[baseSid]) {
        normalizedDrivers[s.session_id] = normalizedDrivers[baseSid];
      }
    }
  }

  return {
    ...snapshot,
    session: activeSession,
    tasks: activeTasks,
    debates: activeDebates,
    cliRecentSessions,
    drivers: normalizedDrivers,
    availableModels,
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
