/**
 * Transcript routes (/api/transcripts/*) — GUI_ARCHITECTURE.md 6.2.4.
 */

import type * as http from "node:http";
import {
  buildInteractiveResumeHarnessCommand,
  readHarnessTranscript,
  type HarnessId,
} from "../core-api.ts";
import {
  HttpApiError,
  type ServerContext,
  validateProjectRoot,
} from "../context.ts";
import { sendJson } from "../index.ts";
import type { PtyManager } from "../pty/pty-manager.ts";
import type {
  GetResumeCommandResponse,
  GetTranscriptResponse,
} from "../../shared/protocol.ts";

const VALID_HARNESSES = new Set<string>([
  "claude-code",
  "codex",
  "opencode",
  "antigravity",
  "cursor",
]);

function parseHarness(raw: string | null): HarnessId {
  const val = raw?.trim() ?? "";
  if (!VALID_HARNESSES.has(val)) {
    throw new HttpApiError(400, "INVALID_PATH", `Invalid harness: ${val}`);
  }
  return val as HarnessId;
}

export async function handleTranscriptsRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL,
  context: ServerContext,
  ptyManager?: PtyManager
): Promise<boolean> {
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && pathname === "/api/transcripts") {
    const rawProjectRoot = parsedUrl.searchParams.get("projectRoot");
    if (rawProjectRoot) {
      validateProjectRoot(rawProjectRoot);
    }
    const harness = parseHarness(parsedUrl.searchParams.get("harness"));
    const harnessSessionId =
      parsedUrl.searchParams.get("harnessSessionId")?.trim() ?? "";
    if (!harnessSessionId) {
      throw new HttpApiError(
        400,
        "INVALID_SESSION_ID",
        "harnessSessionId is required"
      );
    }

    const transcriptPath =
      parsedUrl.searchParams.get("transcriptPath")?.trim() || undefined;
    const rawLimit = parsedUrl.searchParams.get("limit");
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 200;
    const rawBefore = parsedUrl.searchParams.get("before");
    const before =
      rawBefore && Number.isFinite(Number.parseInt(rawBefore, 10))
        ? Number.parseInt(rawBefore, 10)
        : undefined;

    const transcript: GetTranscriptResponse = readHarnessTranscript(
      harness,
      harnessSessionId,
      {
        homeDir: context.homeDir,
        transcriptPath,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 200,
        before,
      }
    );
    sendJson(res, 200, transcript);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/transcripts/resume-command") {
    const harness = parseHarness(parsedUrl.searchParams.get("harness"));
    const harnessSessionId =
      parsedUrl.searchParams.get("harnessSessionId")?.trim() || null;
    const model = parsedUrl.searchParams.get("model")?.trim() || null;

    if (ptyManager) {
      await ptyManager.ensureLoaded();
    }
    const built = buildInteractiveResumeHarnessCommand(
      harness,
      harnessSessionId,
      model
    );
    const response: GetResumeCommandResponse = {
      ...built,
      ...(ptyManager ? { ptyAvailable: ptyManager.isAvailable() } : {}),
    };
    sendJson(res, 200, response);
    return true;
  }

  return false;
}
