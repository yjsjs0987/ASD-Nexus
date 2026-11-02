/**
 * Transcript routes (/api/transcripts/*) — GUI_ARCHITECTURE.md 6.2.4.
 */

import * as fs from "node:fs";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    rawRole === "tool_use"
  ) {
    role = "tool";
  } else if (rawRole === "system" || rawRole === "system_message") {
    role = "system";
  }

  const text = stripSystemTags(typeof msg.text === "string" ? msg.text : "");

  return {
    ...msg,
    role,
    text: redactSecrets(text),
  };
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

function readOpencodeDbDirect(
  homeDir: string,
  sessionId: string
): { messages: TranscriptMessage[]; dbPath: string } | null {
  const candidateHomes = Array.from(
    new Set([homeDir, os.homedir()].filter(Boolean))
  );
  for (const h of candidateHomes) {
    const dbPath = path.join(h, ".local", "share", "opencode", "opencode.db");
    if (!fs.existsSync(dbPath)) continue;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const msgRows = db
        .prepare(
          "SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC, rowid ASC"
        )
        .all(sessionId) as Array<{
        id: unknown;
        data: unknown;
        time_created?: unknown;
      }>;
      if (!msgRows || msgRows.length === 0) {
        continue;
      }
      const partRows = db
        .prepare(
          "SELECT message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created ASC, rowid ASC"
        )
        .all(sessionId) as Array<{
        message_id: unknown;
        data: unknown;
        time_created?: unknown;
      }>;

      const textPartsByMsg = new Map<string, string[]>();
      const reasoningPartsByMsg = new Map<string, string[]>();
      const toolPartsByMsg = new Map<string, string[]>();

      for (const row of partRows) {
        if (typeof row.message_id !== "string") continue;
        let pData: Record<string, unknown> | null = null;
        try {
          pData =
            typeof row.data === "string"
              ? (JSON.parse(row.data) as Record<string, unknown>)
              : null;
        } catch {
          pData = null;
        }
        if (!pData) continue;
        const pType = typeof pData.type === "string" ? pData.type : "";
        const pText = typeof pData.text === "string" ? pData.text.trim() : "";

        if (pType === "text" && pText) {
          const list = textPartsByMsg.get(row.message_id) ?? [];
          list.push(pText);
          textPartsByMsg.set(row.message_id, list);
        } else if (pType === "reasoning" && pText) {
          const list = reasoningPartsByMsg.get(row.message_id) ?? [];
          list.push(pText);
          reasoningPartsByMsg.set(row.message_id, list);
        } else if (pType === "tool") {
          const toolName =
            typeof pData.tool === "string" ? pData.tool : "tool";
          const state = isRec(pData.state) ? pData.state : null;
          const title =
            state && typeof state.title === "string" ? state.title : "";
          const summaryLine = title
            ? `> 🔧 **${toolName}**: ${title}`
            : `> 🔧 **${toolName}**`;
          const list = toolPartsByMsg.get(row.message_id) ?? [];
          list.push(summaryLine);
          toolPartsByMsg.set(row.message_id, list);
        } else if (pText) {
          const list = textPartsByMsg.get(row.message_id) ?? [];
          list.push(pText);
          textPartsByMsg.set(row.message_id, list);
        }
      }

      const out: TranscriptMessage[] = [];
      for (const row of msgRows) {
        if (typeof row.id !== "string") continue;
        let mData: Record<string, unknown> | null = null;
        try {
          mData =
            typeof row.data === "string"
              ? (JSON.parse(row.data) as Record<string, unknown>)
              : null;
        } catch {
          mData = null;
        }
        const roleRaw =
          mData && typeof mData.role === "string" ? mData.role : "assistant";
        const timeObj = mData && isRec(mData.time) ? mData.time : null;
        const createdMs =
          typeof timeObj?.created === "number"
            ? timeObj.created
            : typeof row.time_created === "number"
              ? row.time_created
              : undefined;

        const textParts = textPartsByMsg.get(row.id) ?? [];
        const reasoningParts = reasoningPartsByMsg.get(row.id) ?? [];
        const toolParts = toolPartsByMsg.get(row.id) ?? [];
        const normRole = roleRaw === "user" ? "user" : "assistant";

        const segments: string[] = [];
        if (normRole === "assistant" && reasoningParts.length > 0) {
          const cleanReason = stripSystemTags(reasoningParts.join("\n\n"));
          if (cleanReason) {
            segments.push(`<asd-thinking>\n${cleanReason}\n</asd-thinking>`);
          }
        }

        if (textParts.length > 0) {
          const cleanText = stripSystemTags(textParts.join("\n\n"));
          if (cleanText) {
            segments.push(cleanText);
          }
        } else if (
          mData &&
          typeof mData.content === "string" &&
          mData.content.trim()
        ) {
          const cleanContent = stripSystemTags(mData.content.trim());
          if (cleanContent) {
            segments.push(cleanContent);
          }
        }

        if (normRole === "assistant" && toolParts.length > 0 && textParts.length === 0) {
          segments.push(toolParts.slice(0, 5).join("\n"));
        }

        const combinedText = segments.join("\n\n").trim();
        if (!combinedText) continue;

        const prev = out[out.length - 1];
        if (prev && prev.role === "assistant" && normRole === "assistant") {
          prev.text = `${prev.text}\n\n${redactSecrets(combinedText)}`;
        } else {
          out.push({
            index: out.length,
            role: normRole,
            text: redactSecrets(combinedText),
            ...(createdMs ? { timestamp: new Date(createdMs).toISOString() } : {}),
          });
        }
      }

      if (out.length > 0) {
        return { messages: out, dbPath };
      }
    } catch {
      // Ignore DB read errors and try next candidate
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  return null;
}

function locateClaudeProjectJsonl(
  homeDir: string,
  sessionId: string
): string | null {
  const candidateHomes = Array.from(
    new Set([homeDir, os.homedir()].filter(Boolean))
  );
  for (const h of candidateHomes) {
    const projectsDir = path.join(h, ".claude", "projects");
    if (!fs.existsSync(projectsDir)) continue;
    try {
      const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    } catch {
      // Ignore
    }
  }
  return null;
}

function locateAntigravityJsonl(
  homeDir: string,
  sessionId: string,
  transcriptPath?: string
): string | null {
  if (transcriptPath) {
    // If transcriptPath points to transcript.jsonl, check if transcript_full.jsonl exists alongside it
    const fullSibling = transcriptPath.replace(
      /transcript\.jsonl$/i,
      "transcript_full.jsonl"
    );
    if (fullSibling !== transcriptPath && fs.existsSync(fullSibling)) {
      return fullSibling;
    }
    if (fs.existsSync(transcriptPath)) {
      return transcriptPath;
    }
  }
  const candidateHomes = Array.from(
    new Set([homeDir, os.homedir()].filter(Boolean))
  );
  for (const h of candidateHomes) {
    const logsDir = path.join(
      h,
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs"
    );
    const fullPath = path.join(logsDir, "transcript_full.jsonl");
    if (fs.existsSync(fullPath)) return fullPath;
    const compactPath = path.join(logsDir, "transcript.jsonl");
    if (fs.existsSync(compactPath)) return compactPath;
  }
  return null;
}

const IGNORED_CLAUDE_JSONL_TYPES = new Set<string>([
  "api-request-blob",
  "api-request-shape",
  "api-request",
  "attachment",
  "file-history-snapshot",
  "mode",
  "permission-mode",
  "atis-latch",
  "last-prompt",
  "summary",
  "queue-operation",
]);

function extractClaudeOrHookJsonlMessages(filePath: string): TranscriptMessage[] | null {
  if (!fs.existsSync(filePath)) return null;
  let raw = "";
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const maxBytes = 20 * 1024 * 1024;
    if (stat.size <= maxBytes) {
      raw = fs.readFileSync(filePath, "utf8");
    } else {
      const fd = fs.openSync(filePath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes);
        const text = buf.toString("utf8", 0, bytesRead);
        const firstNl = text.indexOf("\n");
        raw = firstNl >= 0 ? text.slice(firstNl + 1) : text;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {
    return null;
  }

  const lines = raw.split(/\r?\n/);
  const parsedLines: Array<{
    lineIndex: number;
    stepIndex?: number;
    obj: Record<string, unknown>;
  }> = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRec(obj)) continue;

    // Antigravity (agy) transcript_full.jsonl / transcript.jsonl appends new
    // steps with the rewound `step_index` when a user undoes or edits a turn.
    // Any earlier entries with `stepIndex >= currentStepIndex` were undone and
    // must be discarded so only the active timeline remains.
    const stepIndex =
      typeof obj.step_index === "number" && Number.isFinite(obj.step_index)
        ? obj.step_index
        : undefined;
    if (stepIndex !== undefined) {
      while (
        parsedLines.length > 0 &&
        parsedLines[parsedLines.length - 1]!.stepIndex !== undefined &&
        parsedLines[parsedLines.length - 1]!.stepIndex! >= stepIndex
      ) {
        parsedLines.pop();
      }
      for (let j = parsedLines.length - 1; j >= 0; j--) {
        const prevStep = parsedLines[j]?.stepIndex;
        if (prevStep !== undefined && prevStep >= stepIndex) {
          parsedLines.splice(j, 1);
        }
      }
    }
    parsedLines.push({ lineIndex: i, stepIndex, obj });
  }

  const out: TranscriptMessage[] = [];

  for (const { lineIndex: i, obj } of parsedLines) {
    const lineType = typeof obj.type === "string" ? obj.type : "";
    if (IGNORED_CLAUDE_JSONL_TYPES.has(lineType)) {
      continue;
    }

    const status = typeof obj.status === "string" ? obj.status.toUpperCase() : "";
    if (status === "CANCELLED" || status === "CANCELED" || status === "UNDONE") {
      continue;
    }

    const ts =
      typeof obj.timestamp === "string"
        ? obj.timestamp
        : typeof obj.created_at === "string"
          ? obj.created_at
          : typeof obj.ts === "string"
            ? obj.ts
            : typeof obj.time === "number"
              ? new Date(obj.time).toISOString()
              : undefined;

    // 1. Headless `claude -p --output-format json` result line: {"type":"result","result":"..."}
    if (lineType === "result" && typeof obj.result === "string" && obj.result.trim()) {
      const clean = stripSystemTags(obj.result);
      if (clean) {
        out.push({
          index: i,
          role: "assistant",
          text: redactSecrets(clean),
          ...(ts ? { timestamp: ts } : {}),
        });
      }
      continue;
    }

    // 2. Claude Code native message wrapper: {"type":"user"|"assistant","message":{"role":...,"content":...}}
    if (isRec(obj.message)) {
      const msg = obj.message;
      const roleRaw =
        typeof msg.role === "string"
          ? msg.role.toLowerCase()
          : lineType.toLowerCase();
      if (roleRaw !== "user" && roleRaw !== "assistant" && roleRaw !== "human" && roleRaw !== "model") {
        continue;
      }
      const normRole =
        roleRaw === "user" || roleRaw === "human" ? "user" : "assistant";

      let extractedText = "";
      if (typeof msg.content === "string") {
        extractedText = stripSystemTags(msg.content);
      } else if (Array.isArray(msg.content)) {
        const textBlocks: string[] = [];
        const thinkingBlocks: string[] = [];
        const toolBlocks: string[] = [];
        let hasOnlyToolResult = true;

        for (const part of msg.content) {
          if (typeof part === "string") {
            const cleaned = stripSystemTags(part);
            if (cleaned) {
              textBlocks.push(cleaned);
              hasOnlyToolResult = false;
            }
            continue;
          }
          if (!isRec(part)) continue;
          const pType = typeof part.type === "string" ? part.type : "";
          if (pType === "tool_result") {
            continue;
          }
          hasOnlyToolResult = false;
          if (pType === "text" || pType === "input_text" || pType === "output_text" || !pType) {
            const t =
              typeof part.text === "string"
                ? part.text
                : typeof part.content === "string"
                  ? part.content
                  : "";
            const cleaned = stripSystemTags(t);
            if (cleaned) textBlocks.push(cleaned);
          } else if (pType === "thinking") {
            const th =
              typeof part.thinking === "string"
                ? part.thinking.trim()
                : typeof part.text === "string"
                  ? part.text.trim()
                  : "";
            if (th) thinkingBlocks.push(th);
          } else if (pType === "tool_use") {
            const toolName =
              typeof part.name === "string" ? part.name : "tool";
            toolBlocks.push(`> 🔧 **${toolName}**`);
          }
        }

        if (normRole === "user" && hasOnlyToolResult && textBlocks.length === 0) {
          continue;
        }

        const segments: string[] = [];
        if (normRole === "assistant" && thinkingBlocks.length > 0) {
          const cleanThinking = stripSystemTags(thinkingBlocks.join("\n\n"));
          if (cleanThinking) {
            segments.push(`<asd-thinking>\n${cleanThinking}\n</asd-thinking>`);
          }
        }
        if (textBlocks.length > 0) {
          segments.push(textBlocks.join("\n\n"));
        } else if (normRole === "assistant" && toolBlocks.length > 0) {
          segments.push(toolBlocks.join("\n"));
        }
        extractedText = segments.join("\n\n").trim();
      }

      if (!extractedText) continue;

      const prev = out[out.length - 1];
      if (prev && prev.role === "assistant" && normRole === "assistant") {
        // Merge consecutive assistant blocks from the same turn
        if (!prev.text.includes(extractedText)) {
          prev.text = `${prev.text}\n\n${redactSecrets(extractedText)}`;
        }
      } else {
        out.push({
          index: i,
          role: normRole,
          text: redactSecrets(extractedText),
          ...(ts ? { timestamp: ts } : {}),
        });
      }
      continue;
    }

    // 3. Hook transcript / Antigravity / generic JSONL lines:
    //    {"type":"user"|"assistant"|"USER_INPUT"|"PLANNER_RESPONSE"|"tool_use","content":...}
    if (lineType === "tool_use") {
      const toolName =
        typeof obj.tool_name === "string"
          ? obj.tool_name
          : typeof obj.name === "string"
            ? obj.name
            : "tool";
      const toolInput = isRec(obj.tool_input) ? obj.tool_input : null;
      const desc =
        toolInput && typeof toolInput.description === "string"
          ? toolInput.description
          : toolInput && typeof toolInput.command === "string"
            ? `\`${String(toolInput.command).slice(0, 80)}\``
            : toolInput && typeof toolInput.filePath === "string"
              ? path.basename(String(toolInput.filePath))
              : "";
      const summary = desc
        ? `> 🔧 **${toolName}**: ${desc}`
        : `> 🔧 **${toolName}**`;
      const prev = out[out.length - 1];
      if (prev && prev.role === "assistant") {
        const lineCount = prev.text.split("\n").length;
        if (lineCount < 15) {
          prev.text = `${prev.text}\n${redactSecrets(summary)}`;
        }
      } else {
        out.push({
          index: i,
          role: "assistant",
          text: redactSecrets(summary),
          ...(ts ? { timestamp: ts } : {}),
        });
      }
      continue;
    }

    if (lineType === "tool_result") {
      continue;
    }

    const rawRole = String(obj.role ?? obj.type ?? "").toLowerCase();
    if (
      rawRole === "user" ||
      rawRole === "human" ||
      rawRole === "user_input" ||
      rawRole === "assistant" ||
      rawRole === "model" ||
      rawRole === "agent" ||
      rawRole === "planner_response"
    ) {
      const rawContent =
        typeof obj.content === "string"
          ? obj.content
          : typeof obj.text === "string"
            ? obj.text
            : "";
      const rawThinking =
        typeof obj.thinking === "string" ? obj.thinking.trim() : "";
      const cleaned = stripSystemTags(rawContent);
      const normRole =
        rawRole === "user" || rawRole === "human" || rawRole === "user_input"
          ? "user"
          : "assistant";
      const segments: string[] = [];
      if (normRole === "assistant" && rawThinking) {
        const cleanThinking = stripSystemTags(rawThinking);
        if (cleanThinking && cleanThinking !== "[REDACTED]") {
          segments.push(`<asd-thinking>\n${cleanThinking}\n</asd-thinking>`);
        }
      }
      if (cleaned) {
        segments.push(cleaned);
      }
      if (segments.length === 0 || (normRole === "assistant" && !cleaned)) {
        continue;
      }
      out.push({
        index: i,
        role: normRole,
        text: redactSecrets(segments.join("\n\n")),
        ...(ts ? { timestamp: ts } : {}),
      });
    }
  }

  return out;
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

    // 1. OpenCode session (`opencode` or `ses_...`): ALWAYS try opencode.db first
    //    because ~/.claude/transcripts/ses_*.jsonl only logs user/tool hooks without assistant text.
    if (effectiveHarness === "opencode") {
      const dbResult = readOpencodeDbDirect(context.homeDir, harnessSessionId);
      if (dbResult && dbResult.messages.length > 0) {
        const filtered =
          before !== undefined
            ? dbResult.messages.filter((m) => m.index < before)
            : dbResult.messages;
        const sliced = filtered.slice(
          Math.max(0, filtered.length - effectiveLimit)
        );
        resultTranscript = {
          found: true,
          harness: "opencode",
          sessionId: harnessSessionId,
          transcriptPath: dbResult.dbPath,
          messages: sliced,
          hasMore: sliced.length > 0 && (sliced[0]?.index ?? 0) > 0,
          truncated: false,
        };
      } else {
        // Try core reader without the .claude/transcripts hook path first (for storage/ or temp homeDir DBs)
        const nonHookPath = isHookCompatibilityTranscriptPath(transcriptPath)
          ? undefined
          : transcriptPath;
        const coreTry = readHarnessTranscript("opencode", harnessSessionId, {
          homeDir: context.homeDir,
          transcriptPath: nonHookPath,
          limit: effectiveLimit,
          before,
        });
        if (coreTry.found && coreTry.messages.length > 0) {
          resultTranscript = coreTry;
        } else {
          const fallbackHookPath =
            transcriptPath && fs.existsSync(transcriptPath)
              ? transcriptPath
              : path.join(
                  context.homeDir,
                  ".claude",
                  "transcripts",
                  `${harnessSessionId}.jsonl`
                );
          if (fs.existsSync(fallbackHookPath)) {
            const hookMsgs = extractClaudeOrHookJsonlMessages(fallbackHookPath);
            if (hookMsgs) {
              const filtered =
                before !== undefined
                  ? hookMsgs.filter((m) => m.index < before)
                  : hookMsgs;
              const sliced = filtered.slice(
                Math.max(0, filtered.length - effectiveLimit)
              );
              resultTranscript = {
                found: true,
                harness: "opencode",
                sessionId: harnessSessionId,
                transcriptPath: fallbackHookPath,
                messages: sliced,
                hasMore: sliced.length > 0 && (sliced[0]?.index ?? 0) > 0,
                truncated: false,
              };
            }
          }
        }
      }
    }

    // 2. Claude Code session: prefer ~/.claude/projects/<project>/<id>.jsonl over ~/.claude/transcripts/,
    //    and use our enhanced parser that handles assistant text/thinking/tool_use & skips api-request-blob.
    if (!resultTranscript && effectiveHarness === "claude-code") {
      const nativeProjectJsonl = locateClaudeProjectJsonl(
        context.homeDir,
        harnessSessionId
      );
      const preferredPath =
        nativeProjectJsonl ??
        (transcriptPath && fs.existsSync(transcriptPath)
          ? transcriptPath
          : null);
      if (preferredPath) {
        const parsedMsgs = extractClaudeOrHookJsonlMessages(preferredPath);
        if (parsedMsgs) {
          const filtered =
            before !== undefined
              ? parsedMsgs.filter((m) => m.index < before)
              : parsedMsgs;
          const sliced = filtered.slice(
            Math.max(0, filtered.length - effectiveLimit)
          );
          resultTranscript = {
            found: true,
            harness: "claude-code",
            sessionId: harnessSessionId,
            transcriptPath: preferredPath,
            messages: sliced,
            hasMore: sliced.length > 0 && (sliced[0]?.index ?? 0) > 0,
            truncated: false,
          };
        }
      }
    }

    // 3. Antigravity session: prefer transcript_full.jsonl and extract only user/assistant turns (no GENERIC tool dumps)
    if (!resultTranscript && effectiveHarness === "antigravity") {
      const agyJsonl = locateAntigravityJsonl(
        context.homeDir,
        harnessSessionId,
        transcriptPath
      );
      if (agyJsonl) {
        const parsedMsgs = extractClaudeOrHookJsonlMessages(agyJsonl);
        if (parsedMsgs) {
          const filtered =
            before !== undefined
              ? parsedMsgs.filter((m) => m.index < before)
              : parsedMsgs;
          const sliced = filtered.slice(
            Math.max(0, filtered.length - effectiveLimit)
          );
          resultTranscript = {
            found: true,
            harness: "antigravity",
            sessionId: harnessSessionId,
            transcriptPath: agyJsonl,
            messages: sliced,
            hasMore: sliced.length > 0 && (sliced[0]?.index ?? 0) > 0,
            truncated: false,
          };
        }
      }
    }

    // 4. Fallback to core readHarnessTranscript for codex, cursor, etc.
    if (!resultTranscript) {
      resultTranscript = readHarnessTranscript(
        effectiveHarness,
        harnessSessionId,
        {
          homeDir: context.homeDir,
          transcriptPath,
          limit: effectiveLimit,
          before,
        }
      );
    }

    // 4. Merge any headless GUI turns recorded for this session/driver
    const asdSessionIdParam =
      parsedUrl.searchParams.get("asdSessionId")?.trim() || undefined;
    const guiTurns = readGuiTurnMessages(resolvedProjectRoot, [
      harnessSessionId,
      ...(asdSessionIdParam ? [asdSessionIdParam] : []),
    ]);
    let normalizedMessages = mergeWithGuiTurns(
      resultTranscript.messages
        .map(normalizeTranscriptMessage)
        .filter((m) => m.text && m.text.trim().length > 0),
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
