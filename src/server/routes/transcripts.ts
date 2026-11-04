/**
 * Transcript routes (/api/transcripts/*) — GUI_ARCHITECTURE.md 6.2.4.
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import {
  buildInteractiveResumeHarnessCommand,
  readCliRecentSessions,
  readHarnessTranscript,
  redactSecrets,
  type HarnessId,
  type HarnessTranscript,
  type TranscriptMessage,
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

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripSystemTags(raw: string): string {
  let text = raw;
  if (text.includes("<USER_REQUEST>")) {
    const m = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
    if (m && m[1] !== undefined) {
      text = m[1].trim();
    }
  }
  text = text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, "")
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, "")
    .replace(/<command-message>[\s\S]*?<\/command-message>/gi, "")
    .trim();
  return text;
}

function normalizeTranscriptMessage(msg: TranscriptMessage): TranscriptMessage {
  const rawRole = String(msg.role || "").toLowerCase();
  let role = msg.role;
  if (
    rawRole === "user_input" ||
    rawRole === "user_message" ||
    rawRole === "human" ||
    rawRole === "user"
  ) {
    role = "user";
  } else if (
    rawRole === "planner_response" ||
    rawRole === "agent_message" ||
    rawRole === "assistant" ||
    rawRole === "model" ||
    rawRole === "agent" ||
    rawRole === "result"
  ) {
    role = "assistant";
  } else if (
    rawRole === "tool" ||
    rawRole === "tool_result" ||
    rawRole === "tool_use" ||
    rawRole === "tool_response" ||
    rawRole === "generic" ||
    rawRole === "function_call_output" ||
    rawRole === "custom_tool_call_output"
  ) {
    role = "tool";
  } else if (rawRole === "system" || rawRole === "system_message") {
    role = "system";
  }

  const text = stripSystemTags(typeof msg.text === "string" ? msg.text : "");
  const thinking =
    typeof msg.thinking === "string" && msg.thinking.trim()
      ? redactSecrets(stripSystemTags(msg.thinking))
      : undefined;

  return {
    ...msg,
    role,
    text: redactSecrets(text),
    ...(thinking ? { thinking } : {}),
  };
}

function hasMessageContent(msg: TranscriptMessage): boolean {
  return Boolean(
    (msg.text && msg.text.trim().length > 0) ||
      (msg.thinking && msg.thinking.trim().length > 0) ||
      (msg.toolUse && msg.toolUse.length > 0) ||
      (msg.toolResult && msg.toolResult.length > 0)
  );
}

function isOpenCodeSession(
  harness: HarnessId,
  sessionId: string,
  transcriptPath?: string
): boolean {
  if (harness === "opencode") return true;
  if (sessionId.startsWith("ses_")) return true;
  if (transcriptPath && /[\\/]ses_[A-Za-z0-9_-]+\.jsonl$/i.test(transcriptPath)) {
    return true;
  }
  return false;
}

function isHookCompatibilityTranscriptPath(p?: string): boolean {
  if (!p) return false;
  const norm = p.replaceAll("\\", "/").toLowerCase();
  return norm.includes("/.claude/transcripts/");
}

export function getGuiTurnsFilePath(
  projectRoot: string,
  key: string
): string {
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(
    path.resolve(projectRoot),
    ".asd",
    "sessions",
    "gui-turns",
    `${safeKey}.jsonl`
  );
}

export function appendGuiTurnMessage(
  projectRoot: string,
  keys: string[],
  entry: { role: "user" | "assistant"; text: string; timestamp?: string }
): void {
  const cleanText = entry.text.trim();
  if (!cleanText) return;
  const line =
    JSON.stringify({
      role: entry.role,
      text: redactSecrets(cleanText),
      timestamp: entry.timestamp ?? new Date().toISOString(),
    }) + "\n";

  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  for (const k of uniqueKeys) {
    try {
      const p = getGuiTurnsFilePath(projectRoot, k);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFileSync(p, line, "utf8");
    } catch {
      // Best-effort GUI turn persistence
    }
  }
}

function readGuiTurnMessages(
  projectRoot: string | undefined,
  keys: string[]
): TranscriptMessage[] {
  if (!projectRoot) return [];
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  for (const k of uniqueKeys) {
    const p = getGuiTurnsFilePath(projectRoot, k);
    if (!fs.existsSync(p)) continue;
    try {
      const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
      const msgs: TranscriptMessage[] = [];
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]?.trim();
        if (!l) continue;
        try {
          const parsed = JSON.parse(l) as {
            role?: string;
            text?: string;
            timestamp?: string;
          };
          if (parsed.text && parsed.role) {
            msgs.push({
              index: 100000 + i,
              role: parsed.role === "user" ? "user" : "assistant",
              text: parsed.text,
              ...(parsed.timestamp ? { timestamp: parsed.timestamp } : {}),
            });
          }
        } catch {}
      }
      if (msgs.length > 0) return msgs;
    } catch {}
  }
  return [];
}

function mergeWithGuiTurns(
  baseMessages: TranscriptMessage[],
  guiMessages: TranscriptMessage[]
): TranscriptMessage[] {
  if (guiMessages.length === 0) return baseMessages;
  if (baseMessages.length === 0) {
    return guiMessages.map((m, idx) => ({ ...m, index: idx }));
  }
  const existingFingerprints = new Set(
    baseMessages.map((m) => `${m.role}::${m.text.trim().slice(0, 160)}`)
  );
  const combined = [...baseMessages];
  let nextIdx =
    (combined[combined.length - 1]?.index ?? combined.length - 1) + 1;
  for (const gm of guiMessages) {
    const fp = `${gm.role}::${gm.text.trim().slice(0, 160)}`;
    if (!existingFingerprints.has(fp)) {
      existingFingerprints.add(fp);
      combined.push({ ...gm, index: nextIdx++ });
    }
  }
  return combined;
}

function formatBulletList(title: string, items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  const lines: string[] = [];
  for (const item of items) {
    if (typeof item === "string" && item.trim()) {
      lines.push(`- ${item.trim()}`);
    } else if (isRec(item)) {
      const desc =
        typeof item.description === "string"
          ? item.description
          : typeof item.decision === "string"
            ? item.decision
            : typeof item.risk === "string"
              ? item.risk
              : JSON.stringify(item);
      lines.push(`- ${desc}`);
    }
  }
  if (lines.length === 0) return "";
  return `#### ${title}\n${lines.join("\n")}`;
}

function buildAsdSessionFallbackMessages(
  context: ServerContext,
  projectRoot: string | undefined,
  asdSessionId: string | undefined,
  harnessSessionId: string
): TranscriptMessage[] {
  if (!projectRoot) return [];
  const rawSid = (asdSessionId || harnessSessionId || "").trim();
  if (!rawSid) return [];

  const splitIdx = rawSid.indexOf("::");
  const baseSid = splitIdx !== -1 ? rawSid.slice(0, splitIdx) : rawSid;
  const debateSuffix = splitIdx !== -1 ? rawSid.slice(splitIdx + 2).trim() : "";

  const out: TranscriptMessage[] = [];
  try {
    const db = context.getDb(projectRoot);
    const debates = debateSuffix
      ? [db.getDebate(debateSuffix)].filter(Boolean)
      : db.getSessionDebates(baseSid);

    for (const d of debates) {
      if (!d) continue;
      out.push({
        index: out.length,
        role: "user",
        text: `📋 **적대적 토론 (Debate \`${d.debate_id}\`)**\n\n**주제:** ${d.topic}\n**상태:** \`${d.status}\``,
      });

      if (typeof d.round1_bundle_json === "string" && d.round1_bundle_json.trim()) {
        try {
          const r1 = JSON.parse(d.round1_bundle_json) as {
            openings?: Array<Record<string, unknown>>;
          };
          for (const op of r1.openings ?? []) {
            const revHarness = typeof op.harness === "string" ? op.harness : "reviewer";
            const revModel = typeof op.model === "string" ? ` (${op.model})` : "";
            const revRole = typeof op.role === "string" ? op.role : "reviewer";
            const verdict = typeof op.verdict === "string" ? op.verdict : "";
            const reasoning = typeof op.reasoning === "string" ? op.reasoning.trim() : "";
            const parts: string[] = [];
            if (reasoning) {
              parts.push(`<asd-thinking>\n${reasoning}\n</asd-thinking>`);
            }
            parts.push(
              `### 🎙️ Round 1 — ${revHarness}${revModel} · \`${revRole}\`${verdict ? ` → **${verdict}**` : ""}`
            );
            const hc = formatBulletList("핵심 제약 (Hard Constraints)", op.hard_constraints);
            if (hc) parts.push(hc);
            const dec = formatBulletList("주요 결정 (Decisions)", op.decisions);
            if (dec) parts.push(dec);
            const risks = formatBulletList("리스크 (Risks)", op.risks);
            if (risks) parts.push(risks);
            out.push({
              index: out.length,
              role: "assistant",
              text: redactSecrets(parts.join("\n\n")),
            });
          }
        } catch {}
      }

      if (typeof d.insight_verdict_json === "string" && d.insight_verdict_json.trim()) {
        try {
          const vd = JSON.parse(d.insight_verdict_json) as Record<string, unknown>;
          const vStatus = typeof vd.verdict === "string" ? vd.verdict : d.status;
          const vReason = typeof vd.reasoning === "string" ? vd.reasoning.trim() : "";
          const parts: string[] = [];
          parts.push(`### ⚖️ 최종 합의 판정 (Verdict: **${vStatus}**)`);
          if (vReason) parts.push(vReason);
          const hc = formatBulletList("합의된 핵심 제약 (Hard Constraints)", vd.hard_constraints);
          if (hc) parts.push(hc);
          const dec = formatBulletList("합의된 결정 사항 (Decisions)", vd.decisions);
          if (dec) parts.push(dec);
          const risks = formatBulletList("식별된 리스크 (Risks)", vd.risks);
          if (risks) parts.push(risks);
          out.push({
            index: out.length,
            role: "assistant",
            text: redactSecrets(parts.join("\n\n")),
          });
        } catch {}
      }
    }

    if (out.length > 0) return out;

    // Check .asd/sessions/<baseSid>/summary.md if no debate records exist
    const summaryPath = path.join(
      path.resolve(projectRoot),
      ".asd",
      "sessions",
      baseSid,
      "summary.md"
    );
    if (fs.existsSync(summaryPath)) {
      const summaryMd = fs.readFileSync(summaryPath, "utf8").trim();
      if (summaryMd) {
        const sess = db.getSession(baseSid);
        out.push({
          index: 0,
          role: "user",
          text: sess?.memo
            ? `📋 **ASD 세션 목표:** ${sess.memo}`
            : `📋 **ASD 세션:** \`${baseSid}\``,
        });
        out.push({
          index: 1,
          role: "assistant",
          text: redactSecrets(summaryMd),
        });
        return out;
      }
    }
  } catch {
    // Ignore DB/file fallback errors
  }

  return out;
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
    const resolvedProjectRoot = rawProjectRoot
      ? validateProjectRoot(rawProjectRoot)
      : undefined;
    const requestedHarness = parseHarness(parsedUrl.searchParams.get("harness"));
    const harnessSessionId =
      parsedUrl.searchParams.get("harnessSessionId")?.trim() ?? "";
    if (!harnessSessionId) {
      throw new HttpApiError(
        400,
        "INVALID_SESSION_ID",
        "harnessSessionId is required"
      );
    }

    let transcriptPath =
      parsedUrl.searchParams.get("transcriptPath")?.trim() || undefined;
    if (!transcriptPath && resolvedProjectRoot) {
      try {
        const recent = readCliRecentSessions(resolvedProjectRoot, {
          syncLocalTranscripts: true,
          homeDir: context.homeDir,
        });
        const matched = recent.find(
          (r) => r.harnessSessionId === harnessSessionId
        );
        if (matched?.transcriptPath) {
          transcriptPath = matched.transcriptPath;
        }
      } catch {
        // Ignore fallback lookup errors
      }
    }

    const effectiveHarness: HarnessId = isOpenCodeSession(
      requestedHarness,
      harnessSessionId,
      transcriptPath
    )
      ? "opencode"
      : requestedHarness;

    const rawLimit = parsedUrl.searchParams.get("limit");
    const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 200;
    const effectiveLimit =
      Number.isFinite(limit) && limit > 0 ? limit : 200;
    const rawBefore = parsedUrl.searchParams.get("before");
    const before =
      rawBefore && Number.isFinite(Number.parseInt(rawBefore, 10))
        ? Number.parseInt(rawBefore, 10)
        : undefined;

    let resultTranscript: HarnessTranscript | null = null;

    // Delegate directly to Core v2.4.0's `readHarnessTranscript` (which supports
    // 4-way classification: user, assistant, thinking, tool_use, tool_result across all 5 harnesses).
    // For opencode (when transcriptPath points to opencode.db) or hook compatibility paths,
    // let Core's native locator run first before falling back to an explicit JSONL path.
    const shouldTryNativeLocatorFirst =
      !transcriptPath ||
      transcriptPath.toLowerCase().endsWith(".db") ||
      isHookCompatibilityTranscriptPath(transcriptPath);

    if (shouldTryNativeLocatorFirst) {
      const nativeTry = readHarnessTranscript(
        effectiveHarness,
        harnessSessionId,
        {
          homeDir: context.homeDir,
          limit: effectiveLimit,
          before,
        }
      );
      if (nativeTry.found && nativeTry.messages.length > 0) {
        resultTranscript = nativeTry;
      }
    }

    if (!resultTranscript) {
      const jsonlOverride =
        transcriptPath && !transcriptPath.toLowerCase().endsWith(".db")
          ? transcriptPath
          : undefined;
      resultTranscript = readHarnessTranscript(
        effectiveHarness,
        harnessSessionId,
        {
          homeDir: context.homeDir,
          transcriptPath: jsonlOverride,
          limit: effectiveLimit,
          before,
        }
      );
    }

    // Merge any headless GUI turns recorded for this session/driver
    const asdSessionIdParam =
      parsedUrl.searchParams.get("asdSessionId")?.trim() || undefined;
    const guiTurns = readGuiTurnMessages(resolvedProjectRoot, [
      harnessSessionId,
      ...(asdSessionIdParam ? [asdSessionIdParam] : []),
    ]);
    let normalizedMessages = mergeWithGuiTurns(
      resultTranscript.messages
        .map(normalizeTranscriptMessage)
        .filter(hasMessageContent),
      guiTurns
    );

    const hasAssistantReply = normalizedMessages.some(
      (m) => m.role === "assistant"
    );
    if (
      (!hasAssistantReply || normalizedMessages.length === 0) &&
      resolvedProjectRoot &&
      (asdSessionIdParam ||
        harnessSessionId.startsWith("drv-") ||
        harnessSessionId.includes("::D-"))
    ) {
      const fallbackMsgs = buildAsdSessionFallbackMessages(
        context,
        resolvedProjectRoot,
        asdSessionIdParam,
        harnessSessionId
      );
      if (fallbackMsgs.length > 0) {
        normalizedMessages = mergeWithGuiTurns(fallbackMsgs, normalizedMessages);
      }
    }

    const hasAnyMessages = resultTranscript.found || normalizedMessages.length > 0;
    const transcript: GetTranscriptResponse = {
      ...resultTranscript,
      found: hasAnyMessages,
      messages: normalizedMessages,
      ...(hasAnyMessages ? { error: undefined } : {}),
    };
    sendJson(res, 200, transcript);
    return true;
  }

  if (req.method === "GET" && pathname === "/api/transcripts/resume-command") {
    const requestedHarness = parseHarness(parsedUrl.searchParams.get("harness"));
    const harnessSessionId =
      parsedUrl.searchParams.get("harnessSessionId")?.trim() || null;
    const effectiveHarness: HarnessId =
      harnessSessionId && harnessSessionId.startsWith("ses_")
        ? "opencode"
        : requestedHarness;
    const model = parsedUrl.searchParams.get("model")?.trim() || null;

    if (ptyManager) {
      await ptyManager.ensureLoaded();
    }
    const built = buildInteractiveResumeHarnessCommand(
      effectiveHarness,
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
