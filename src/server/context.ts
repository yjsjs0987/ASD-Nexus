/**
 * Server context: per-project SqliteDriver cache & path/session validation (Section 6.1 & 6.4).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isValidAsdSessionId,
  openProjectDb,
  type CommandRunner,
  type SqliteDriver,
} from "./core-api.ts";
import type { ErrorCode } from "../shared/protocol.ts";

export class HttpApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode, message: string) {
    super(message);
    this.name = "HttpApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function validateSessionId(sessionId: unknown): string {
  if (!isValidAsdSessionId(sessionId)) {
    throw new HttpApiError(
      400,
      "INVALID_SESSION_ID",
      `Invalid ASD session ID: ${String(sessionId)}`
    );
  }
  return sessionId;
}

export function validateProjectRoot(rawPath: unknown): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new HttpApiError(400, "INVALID_PATH", "projectRoot must be a non-empty string");
  }
  if (!path.isAbsolute(rawPath)) {
    throw new HttpApiError(
      400,
      "INVALID_PATH",
      `projectRoot must be an absolute path: ${rawPath}`
    );
  }
  const resolved = path.resolve(rawPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new HttpApiError(
      400,
      "INVALID_PATH",
      `Directory does not exist: ${resolved}`
    );
  }
  if (!stat.isDirectory()) {
    throw new HttpApiError(
      400,
      "INVALID_PATH",
      `Path is not a directory: ${resolved}`
    );
  }
  return resolved;
}

export function validateSubPath(projectRoot: string, targetCwd: unknown): string {
  const root = validateProjectRoot(projectRoot);
  if (targetCwd === undefined || targetCwd === null || targetCwd === "") {
    return root;
  }
  if (typeof targetCwd !== "string") {
    throw new HttpApiError(400, "INVALID_PATH", "cwd must be a string");
  }
  const resolved = path.resolve(root, targetCwd);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HttpApiError(
      400,
      "INVALID_PATH",
      `Path '${resolved}' escapes projectRoot '${root}'`
    );
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new HttpApiError(
      400,
      "INVALID_PATH",
      `cwd directory does not exist: ${resolved}`
    );
  }
  if (!stat.isDirectory()) {
    throw new HttpApiError(
      400,
      "INVALID_PATH",
      `cwd is not a directory: ${resolved}`
    );
  }
  return resolved;
}

export class ServerContext {
  readonly homeDir: string;
  readonly commandRunner?: CommandRunner;
  private readonly dbCache = new Map<string, SqliteDriver>();

  constructor(options?: { homeDir?: string; commandRunner?: CommandRunner }) {
    this.homeDir = options?.homeDir
      ? path.resolve(options.homeDir)
      : process.env.ASD_HOME_DIR
        ? path.resolve(process.env.ASD_HOME_DIR)
        : os.homedir();
    this.commandRunner = options?.commandRunner;
  }

  getDb(projectRoot: string): SqliteDriver {
    const normalizedRoot = validateProjectRoot(projectRoot);
    const key =
      process.platform === "win32"
        ? normalizedRoot.toLowerCase()
        : normalizedRoot;
    let db = this.dbCache.get(key);
    if (!db) {
      db = openProjectDb(normalizedRoot, this.homeDir);
      this.dbCache.set(key, db);
    }
    return db;
  }

  closeProjectDb(projectRoot: string): void {
    const normalizedRoot = path.resolve(projectRoot);
    const key =
      process.platform === "win32"
        ? normalizedRoot.toLowerCase()
        : normalizedRoot;
    const db = this.dbCache.get(key);
    if (db) {
      this.dbCache.delete(key);
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
  }

  closeAll(): void {
    for (const db of this.dbCache.values()) {
      try {
        db.close();
      } catch {
        // Ignore close errors
      }
    }
    this.dbCache.clear();
  }
}
