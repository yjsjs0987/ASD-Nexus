/**
 * Project routes (/api/projects/*) — GUI_ARCHITECTURE.md 6.2.1.
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import {
  discoverHarnessModels,
  listKnownProjects,
  loadRoutingConfig,
  recoverOrphanedTasks,
  resolveAsdPaths,
  saveProjectRoutingConfig,
  type RoutingConfig,
} from "../core-api.ts";
import { HttpApiError, type ServerContext, validateProjectRoot } from "../context.ts";
import { readJsonBody, sendJson } from "../index.ts";
import {
  buildMergedModelCatalog,
  collectEnrichedSnapshot,
  getProjectGitInfo,
  refreshAsyncCliModels,
  type StateWatcher,
} from "../watcher/state-watcher.ts";
import type {
  BrowseDirsResponse,
  GetProjectModelsResponse,
  GetProjectRoutingResponse,
  GetProjectsResponse,
  OpenProjectResponse,
  PutProjectRoutingRequest,
  PutProjectRoutingResponse,
} from "../../shared/protocol.ts";

export async function handleProjectsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  context: ServerContext,
  watcher: StateWatcher
): Promise<boolean> {
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/api/projects") {
    const projects = listKnownProjects({ homeDir: context.homeDir });
    const response: GetProjectsResponse = { projects };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/projects/browse-dirs") {
    const rawDir = parsedUrl.searchParams.get("dir");
    const includeHidden = parsedUrl.searchParams.get("hidden") === "1";
    const targetDir = rawDir && rawDir.trim()
      ? validateProjectRoot(rawDir.trim())
      : validateProjectRoot(context.homeDir);

    const parsedPath = path.parse(targetDir);
    const parentCandidate = path.dirname(targetDir);
    const parentDir =
      parentCandidate && parentCandidate !== targetDir && targetDir !== parsedPath.root
        ? parentCandidate
        : null;

    let directories: string[] = [];
    try {
      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      directories = entries
        .filter((e) => {
          if (!e.isDirectory()) return false;
          if (!includeHidden && e.name.startsWith(".")) return false;
          return true;
        })
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err: unknown) {
      throw new HttpApiError(
        400,
        "INVALID_PATH",
        `Cannot read directory '${targetDir}': ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    const gitInfo = getProjectGitInfo(targetDir);
    const response: BrowseDirsResponse = {
      currentDir: targetDir,
      parentDir,
      directories,
      isGitRepo: gitInfo.isGitRepo,
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "POST" && pathname === "/api/projects/open") {
    const body = await readJsonBody<{ projectRoot?: unknown }>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    resolveAsdPaths(projectRoot, context.homeDir);
    const db = context.getDb(projectRoot);
    const recoveredOrphans = recoverOrphanedTasks({ db, projectRoot });
    for (const r of recoveredOrphans) {
      watcher.broadcastToProject(projectRoot, {
        type: "task_status_changed",
        projectRoot,
        sessionId: r.sessionId,
        taskId: r.taskId,
        from: r.from,
        to: r.to,
        reason: r.reason,
      });
    }

    const snapshot = await collectEnrichedSnapshot(projectRoot, context.homeDir);
    if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== "test") {
      void refreshAsyncCliModels()
        .then(() => watcher.forceBroadcastProject(projectRoot))
        .catch(() => {});
    }
    const response: OpenProjectResponse = {
      ...snapshot,
      ...(recoveredOrphans.length > 0 ? { recoveredOrphans } : {}),
    };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/projects/models") {
    const rawRoot = parsedUrl.searchParams.get("projectRoot");
    const projectRoot = rawRoot
      ? validateProjectRoot(rawRoot)
      : process.cwd();
    const forceRefresh =
      parsedUrl.searchParams.get("refresh") === "1" ||
      parsedUrl.searchParams.get("skipCliSpawn") !== "1";
    const skipCliSpawn = parsedUrl.searchParams.get("skipCliSpawn") === "1";
    if (
      forceRefresh &&
      !skipCliSpawn &&
      !process.env.NODE_TEST_CONTEXT &&
      process.env.NODE_ENV !== "test"
    ) {
      await refreshAsyncCliModels();
    }
    const baseModels = await discoverHarnessModels({
      projectRoot,
      homeDir: context.homeDir,
      forceRefresh: true,
      skipCliSpawn: true,
    });
    const models = buildMergedModelCatalog(baseModels, context.homeDir);
    if (rawRoot) {
      void watcher.forceBroadcastProject(projectRoot).catch(() => {});
    }
    const response: GetProjectModelsResponse = { models };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/projects/routing") {
    const projectRoot = validateProjectRoot(
      parsedUrl.searchParams.get("projectRoot")
    );
    const config = loadRoutingConfig(projectRoot, context.homeDir);
    const localRoutingPath = path.join(projectRoot, ".asd", "routing.jsonc");
    const hasLocalRouting = fs.existsSync(localRoutingPath);
    const response: GetProjectRoutingResponse = { config, hasLocalRouting };
    sendJson(res, 200, response);
    return true;
  }

  if (req.method === "PUT" && pathname === "/api/projects/routing") {
    const body = await readJsonBody<PutProjectRoutingRequest>(req);
    const projectRoot = validateProjectRoot(body.projectRoot);
    const result = saveProjectRoutingConfig({
      projectRoot,
      homeDir: context.homeDir,
      action: body.action ?? "save",
      routingConfig: body.routingConfig as RoutingConfig | undefined,
    });
    const response: PutProjectRoutingResponse = result;
    await watcher.forceBroadcastProject(projectRoot);
    sendJson(res, 200, response);
    return true;
  }

  return false;
}
