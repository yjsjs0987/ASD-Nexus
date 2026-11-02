// T4.1 — 실제 하네스 DB/JSONL 트랜스크립트 대화 표시 + 실시간 드라이버 실행 리본 & 스트리밍
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as api from "../api.ts";
import { useApp, type HarnessId, type LiveJob } from "../store";
import { useWsDriverOutputChunk, useWsSubagentLogChunk } from "../events.ts";
import type { JobKind, TranscriptMessage } from "../../shared/protocol.ts";
import Markdown from "./Markdown";
import { ChevronIcon, CopyIcon, LinkIcon, RefreshIcon, TerminalIcon } from "./Icons";
import { HARNESS_LABEL } from "./DriverBar.tsx";

const KIND_LABEL: Record<JobKind, string> = {
  dispatch: "디스패치",
  debate: "토론",
  driver_turn: "드라이버 턴",
  subagent_action: "서브에이전트",
  resolve_conflict: "충돌 해결",
};

const KIND_CLASS: Record<JobKind, string> = {
  dispatch: "agent",
  debate: "debate",
  driver_turn: "draft",
  subagent_action: "synth",
  resolve_conflict: "review",
};

type NodeState = "wait" | "run" | "ok" | "fail";
interface RibbonNode {
  key: string;
  title: string;
  sub: string;
  state: NodeState;
  kind: string;
}

function fmtTime(msOrIso?: number | string) {
  if (!msOrIso) return "";
  const d = typeof msOrIso === "number" ? new Date(msOrIso) : new Date(msOrIso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ko-KR", { hour12: false });
}

function Ribbon({ nodes }: { nodes: RibbonNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <div className="ribbon" role="list" aria-label="처리 과정">
      {nodes.map((n, i) => (
        <div
          key={n.key}
          className="ribbon-seg"
          role="listitem"
          style={{ "--i": i } as CSSProperties}
        >
          {i > 0 && (
            <span
              className={`ribbon-link ${n.state === "wait" ? "" : n.state === "run" ? "flow" : "done"}`}
              aria-hidden
            />
          )}
          <div
            className={`ribbon-node ${n.kind} ${n.state}`}
            title={`${n.title} · ${n.sub}`}
          >
            <i className="ribbon-dot" aria-hidden />
            <div>
              <b>{n.title}</b>
              <span>{n.sub}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function jobNodes(job: LiveJob): RibbonNode[] {
  const fin = job.finished;
  return [
    {
      key: "start",
      kind: KIND_CLASS[job.kind],
      title: KIND_LABEL[job.kind],
      sub: `시작 ${fmtTime(job.startedAt)}`,
      state: "ok",
    },
    {
      key: "prog",
      kind: "jev",
      title: "진행",
      sub: job.progress.at(-1)?.message ?? "실행 중",
      state: fin ? "ok" : "run",
    },
    {
      key: "done",
      kind: "judge",
      title: "완료",
      sub: fin ? (fin.ok ? "성공" : "실패") : "대기",
      state: fin ? (fin.ok ? "ok" : "fail") : "wait",
    },
  ];
}

function SubLog({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="asd-sublog" aria-label="서브에이전트 로그">
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

function Timeline({ job }: { job: LiveJob }) {
  return (
    <div className="asd-timeline">
      <div className="asd-tl-row">
        <span className="asd-tl-time">{fmtTime(job.startedAt)}</span>
        <code>{job.kind}</code>
        <span className="asd-tl-what">job_started</span>
      </div>
      {job.progress.map((p, i) => (
        <div key={i} className="asd-tl-row">
          <span className="asd-tl-time">{fmtTime(p.at)}</span>
          <code>progress</code>
          <span className="asd-tl-what">{p.message}</span>
        </div>
      ))}
      {job.finished && (
        <div className="asd-tl-row">
          <span className="asd-tl-time">{fmtTime(job.finished.at)}</span>
          <code>{job.kind}</code>
          <span className="asd-tl-what">
            job_finished · {job.finished.ok ? "성공" : job.finished.error ?? "실패"}
          </span>
        </div>
      )}
    </div>
  );
}

interface TranscriptTarget {
  key: string;
  driverId?: string;
  harness: HarnessId;
  harnessSessionId: string;
  model?: string | null;
  transcriptPath?: string | null;
  label: string;
  isActive?: boolean;
}

function parseAssistantThinking(rawText: string): {
  thinkingBlocks: string[];
  mainText: string;
} {
  const thinkingBlocks: string[] = [];
  const withoutAsdThinking = rawText.replace(
    /<asd-thinking>\s*([\s\S]*?)\s*<\/asd-thinking>/gi,
    (_m, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) thinkingBlocks.push(trimmed);
      return "";
    },
  );
  const withoutThink = withoutAsdThinking.replace(
    /<think>\s*([\s\S]*?)\s*<\/think>/gi,
    (_m, inner: string) => {
      const trimmed = inner.trim();
      if (trimmed) thinkingBlocks.push(trimmed);
      return "";
    },
  );
  return {
    thinkingBlocks,
    mainText: withoutThink.replace(/\n{3,}/g, "\n\n").trim(),
  };
}

function AssistantMessageBody({ text }: { text: string }) {
  const { thinkingBlocks, mainText } = useMemo(
    () => parseAssistantThinking(text),
    [text],
  );
  const [expanded, setExpanded] = useState(false);

  if (thinkingBlocks.length === 0) {
    return <Markdown text={text} />;
  }

  const combinedThinking = thinkingBlocks.join("\n\n---\n\n");
  const lineCount = combinedThinking.split(/\r?\n/).length;
  const previewLine =
    thinkingBlocks[0]
      ?.split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.replace(/^[#*>-]+\s*/, "")
      .trim()
      .slice(0, 90) ?? "";

  return (
    <div className="asd-assistant-body">
      <div className={`asd-thinking-box ${expanded ? "open" : "collapsed"}`}>
        <button
          type="button"
          className="asd-thinking-head"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="asd-thinking-badge">
            💭 사고 과정 (Thinking)
            {thinkingBlocks.length > 1 ? ` · ${thinkingBlocks.length}단계` : ""}
            <span className="asd-thinking-meta">{lineCount}줄</span>
          </span>
          {!expanded && previewLine && (
            <span className="asd-thinking-preview">{previewLine}…</span>
          )}
          <span className="asd-thinking-toggle">
            {expanded ? "접기" : "펼치기"} <ChevronIcon open={expanded} />
          </span>
        </button>
        {expanded && (
          <div className="asd-thinking-body">
            <Markdown text={combinedThinking} />
          </div>
        )}
      </div>
      {mainText && <Markdown text={mainText} />}
    </div>
  );
}

const SUBLOG_LINES = 9;
const PAGE_LIMIT = 120;

export default function Thread() {
  const app = useApp();
  const projectRoot = app.projectRoot;
  const fgId = app.foregroundSessionId;
  const baseSessionId = useMemo(() => {
    if (!fgId) return null;
    const idx = fgId.indexOf("::");
    return idx !== -1 ? fgId.slice(0, idx) : fgId;
  }, [fgId]);

  const activeCli = app.activeCliSession;
  const job = app.liveJob;
  const mine =
    !activeCli &&
    job &&
    (job.sessionId === fgId || job.sessionId === baseSessionId)
      ? job
      : null;

  // Build list of available transcript sources for the active ASD session (or standalone CLI session)
  const targets = useMemo<TranscriptTarget[]>(() => {
    if (activeCli) {
      const effectiveHarness: HarnessId = activeCli.harnessSessionId.startsWith(
        "ses_",
      )
        ? "opencode"
        : activeCli.harness;
      const hLabel = HARNESS_LABEL[effectiveHarness] ?? effectiveHarness;
      return [
        {
          key: `cli::${effectiveHarness}::${activeCli.harnessSessionId}`,
          harness: effectiveHarness,
          harnessSessionId: activeCli.harnessSessionId,
          model: activeCli.model,
          transcriptPath: activeCli.transcriptPath,
          label: `${hLabel} · ${activeCli.summary || activeCli.harnessSessionId.slice(0, 8)}`,
          isActive: true,
        },
      ];
    }

    if (!app.snapshot || !baseSessionId) return [];
    const list: TranscriptTarget[] = [];
    const seen = new Set<string>();
    const cliRecent = app.snapshot.cliRecentSessions ?? [];
    const sessionRow =
      app.snapshot.sessions.find((s) => s.session_id === fgId) ??
      app.snapshot.sessions.find((s) => s.session_id === baseSessionId) ??
      null;
    const drvList = app.snapshot.drivers?.[baseSessionId] ?? [];

    const hasAnyRealSidDriver = drvList.some((d) => Boolean(d.harness_session_id));

    for (const d of drvList) {
      // Skip detached placeholder drivers that never acquired a harness_session_id
      if (d.detached_at !== null && !d.harness_session_id && hasAnyRealSidDriver) {
        continue;
      }
      const targetSid = d.harness_session_id || d.driver_id;
      const effectiveHarness: HarnessId = targetSid.startsWith("ses_")
        ? "opencode"
        : (d.harness as HarnessId);
      const dedupKey = `${effectiveHarness}::${targetSid}`;
      if (seen.has(dedupKey)) {
        if (d.detached_at === null) {
          const existing = list.find(
            (item) =>
              item.harness === effectiveHarness &&
              item.harnessSessionId === targetSid,
          );
          if (existing) {
            existing.isActive = true;
            existing.key = d.driver_id;
            existing.driverId = d.driver_id;
            if (d.model) existing.model = d.model;
          }
        }
        continue;
      }
      seen.add(dedupKey);
      const matchedCli = d.harness_session_id
        ? cliRecent.find((c) => c.harnessSessionId === d.harness_session_id)
        : undefined;
      const hLabel = HARNESS_LABEL[effectiveHarness] ?? effectiveHarness;
      list.push({
        key: d.driver_id,
        driverId: d.driver_id,
        harness: effectiveHarness,
        harnessSessionId: targetSid,
        model: d.model,
        transcriptPath: matchedCli?.transcriptPath ?? null,
        label: `${hLabel}${d.model ? ` (${d.model})` : ""} · ${(d.harness_session_id || "새 대화").slice(0, 8)}`,
        isActive: d.detached_at === null,
      });
    }

    if (sessionRow?.harness_session_id) {
      const h: HarnessId = sessionRow.harness_session_id.startsWith("ses_")
        ? "opencode"
        : ((sessionRow.main_harness as HarnessId) || "claude-code");
      const dedupKey = `${h}::${sessionRow.harness_session_id}`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        const matchedCli = cliRecent.find(
          (c) => c.harnessSessionId === sessionRow.harness_session_id,
        );
        const hLabel = HARNESS_LABEL[h] ?? h;
        list.push({
          key: `sess::${sessionRow.harness_session_id}`,
          harness: h,
          harnessSessionId: sessionRow.harness_session_id,
          model: sessionRow.main_model,
          transcriptPath: matchedCli?.transcriptPath ?? null,
          label: `${hLabel}${sessionRow.main_model ? ` (${sessionRow.main_model})` : ""} · ${sessionRow.harness_session_id.slice(0, 8)}`,
          isActive: list.length === 0,
        });
      }
    }

    for (const c of cliRecent) {
      if (c.asdSessionId !== baseSessionId) continue;
      const effectiveHarness: HarnessId = c.harnessSessionId.startsWith("ses_")
        ? "opencode"
        : c.harness;
      const dedupKey = `${effectiveHarness}::${c.harnessSessionId}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      const hLabel = HARNESS_LABEL[effectiveHarness] ?? effectiveHarness;
      list.push({
        key: `linked::${c.harnessSessionId}`,
        harness: effectiveHarness,
        harnessSessionId: c.harnessSessionId,
        model: c.model,
        transcriptPath: c.transcriptPath,
        label: `${hLabel} · ${c.summary || c.harnessSessionId.slice(0, 8)}`,
        isActive: list.length === 0,
      });
    }

    return list;
  }, [activeCli, app.snapshot, baseSessionId, fgId]);

  const currentTarget = useMemo<TranscriptTarget | null>(() => {
    if (targets.length === 0) return null;
    if (app.selectedDriverId) {
      const byDrv = targets.find(
        (t) => t.driverId === app.selectedDriverId || t.key === app.selectedDriverId,
      );
      if (byDrv) return byDrv;
    }
    return targets.find((t) => t.isActive) ?? targets[0] ?? null;
  }, [targets, app.selectedDriverId]);

  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [txLoading, setTxLoading] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  const loadTranscript = useCallback(
    async (opts?: { before?: number; appendOlder?: boolean }) => {
      if (!projectRoot || !currentTarget) {
        setMessages([]);
        setHasMore(false);
        setTxError(null);
        return;
      }
      setTxLoading(true);
      setTxError(null);
      try {
        const res = await api.getTranscript({
          projectRoot,
          harness: currentTarget.harness,
          harnessSessionId: currentTarget.harnessSessionId,
          asdSessionId: !activeCli && fgId ? fgId : undefined,
          transcriptPath: currentTarget.transcriptPath ?? undefined,
          limit: PAGE_LIMIT,
          before: opts?.before,
        });
        if (!res.found) {
          if (!opts?.appendOlder) {
            setMessages([]);
            setHasMore(false);
          }
          if (res.error && res.error !== "not_found") {
            setTxError(res.error);
          }
        } else {
          setHasMore(res.hasMore);
          if (opts?.appendOlder) {
            setMessages((prev) => [...res.messages, ...prev]);
          } else {
            setMessages(res.messages);
          }
        }
      } catch (e) {
        setTxError(api.errorText(e));
      } finally {
        setTxLoading(false);
      }
    },
    [projectRoot, currentTarget, activeCli, fgId],
  );

  useEffect(() => {
    void loadTranscript();
  }, [loadTranscript, mine?.finished?.at, app.lastPrompt?.jobId]);

  // Live streaming state for active job
  const [output, setOutput] = useState("");
  const [subLog, setSubLog] = useState("");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const runRef = useRef<string | null>(null);

  useEffect(() => {
    runRef.current = mine?.runId ?? null;
    setOutput("");
    setSubLog("");
  }, [fgId, mine?.runId]);

  useWsDriverOutputChunk((p) => {
    if (p.sessionId !== fgId && p.sessionId !== baseSessionId) return;
    if (runRef.current !== p.runId) {
      runRef.current = p.runId;
      setOutput(p.chunk);
    } else {
      setOutput((o) => o + p.chunk);
    }
  });

  useWsSubagentLogChunk((p) => {
    if (p.sessionId !== fgId && p.sessionId !== baseSessionId) return;
    setSubLog((b) => (b + p.chunk).split("\n").slice(-SUBLOG_LINES).join("\n"));
  });

  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [
    messages.length,
    output.length,
    subLog.length,
    mine?.progress.length,
    mine?.finished?.at,
  ]);

  const unlinkedCliSessions = useMemo(() => {
    const all = app.snapshot?.cliRecentSessions ?? [];
    return all.slice(0, 5);
  }, [app.snapshot?.cliRecentSessions]);

  // Empty state ONLY when there are no transcript messages AND no live job AND no switcher targets
  if (!mine && messages.length === 0 && !txLoading && !activeCli && targets.length <= 1) {
    return (
      <div className="thread empty asd-fill">
        <div className="welcome">
          <div className="orb-anchor" data-orb-anchor aria-hidden />
          <h1>
            드라이버 <em>대화</em>
          </h1>
          <p className="welcome-sub">
            {currentTarget
              ? `연결된 드라이버(${currentTarget.label})의 대화 기록이 아직 없습니다 — 아래 입력창에서 첫 메시지를 보내세요`
              : "아래 입력창에서 드라이버에게 프롬프트를 보내거나, 현재 프로젝트의 일반 CLI 세션을 연결해 대화를 불러오세요"}
          </p>
          {unlinkedCliSessions.length > 0 && (
            <div className="card" style={{ maxWidth: 620, width: "100%", textAlign: "left" }}>
              <div className="asd-info-head" style={{ justifyContent: "space-between" }}>
                <b>현재 프로젝트의 최근 CLI 대화 연결하기</b>
                <span className="asd-dim" style={{ fontSize: 12 }}>
                  클릭하면 이 세션의 메인 드라이버로 연결되어 대화를 불러옵니다
                </span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {unlinkedCliSessions.map((c) => {
                  const hLabel = HARNESS_LABEL[c.harness] ?? c.harness;
                  return (
                    <div
                      key={`${c.harness}::${c.harnessSessionId}`}
                      className="asd-driver-history-item"
                    >
                      <span className="tag ok">{hLabel}</span>
                      {c.model && <span className="tag">{c.model}</span>}
                      <span
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {c.summary || c.harnessSessionId}
                      </span>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => void app.attachCliSessionToCurrentAsd(c)}
                      >
                        <LinkIcon /> 이 대화 연결
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => app.selectCliSession(c)}
                      >
                        대화 열기
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const running = Boolean(mine && !mine.finished);
  const failed = Boolean(mine?.finished && !mine.finished.ok);
  const prompt =
    app.lastPrompt &&
    (app.lastPrompt.sessionId === fgId || app.lastPrompt.sessionId === baseSessionId)
      ? app.lastPrompt.text
      : null;
  const subLines = subLog
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-6);

  return (
    <div
      className="thread"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      aria-live="polite"
    >
      <div className="thread-inner">
        {/* Standalone CLI session banner */}
        {activeCli && (
          <div className="card asd-cli-banner">
            <div className="asd-info-head" style={{ justifyContent: "space-between" }}>
              <div className="row" style={{ gap: 8 }}>
                <span className="tag ok">
                  일반 CLI 세션 · {HARNESS_LABEL[activeCli.harness] ?? activeCli.harness}
                </span>
                {activeCli.model && <code>{activeCli.model}</code>}
                <code className="asd-dim">{activeCli.harnessSessionId}</code>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => void app.promoteCliSessionToAsd(activeCli)}
                >
                  ASD 세션으로 승격
                </button>
                {fgId && (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => void app.attachCliSessionToCurrentAsd(activeCli)}
                  >
                    <LinkIcon /> 현재 ASD 세션에 연결
                  </button>
                )}
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() =>
                    app.openTerminalTab({
                      title: `${HARNESS_LABEL[activeCli.harness] ?? activeCli.harness} (${activeCli.harnessSessionId.slice(0, 8)})`,
                      cwd: projectRoot ?? undefined,
                      harness: activeCli.harness,
                      harnessSessionId: activeCli.harnessSessionId,
                      model: activeCli.model ?? undefined,
                    })
                  }
                >
                  <TerminalIcon /> PTY 터미널로 열기
                </button>
              </div>
            </div>
            {activeCli.summary && (
              <div className="asd-dim" style={{ fontSize: 12.5 }}>
                {activeCli.summary}
              </div>
            )}
          </div>
        )}

        {/* Driver transcript switcher when multiple drivers exist */}
        {!activeCli && targets.length > 0 && (
          <div className="asd-tx-toolbar">
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="asd-dim" style={{ fontSize: 12 }}>
                대화 트랜스크립트:
              </span>
              {targets.map((t) => {
                const selected = currentTarget?.key === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    className={`btn xs ${selected ? "primary" : "ghost"}`}
                    onClick={() => app.setSelectedDriverId(t.driverId ?? t.key)}
                  >
                    {t.label}
                    {t.isActive ? " (활성)" : ""}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="btn xs ghost"
              disabled={txLoading}
              onClick={() => void loadTranscript()}
              title="트랜스크립트 새로고침"
            >
              <RefreshIcon /> {txLoading ? "불러오는 중…" : `메시지 ${messages.length}개`}
            </button>
          </div>
        )}

        {hasMore && messages.length > 0 && (
          <div style={{ textAlign: "center" }}>
            <button
              type="button"
              className="btn sm ghost"
              disabled={txLoading}
              onClick={() =>
                void loadTranscript({
                  before: messages[0]?.index,
                  appendOlder: true,
                })
              }
            >
              ⬆ 이전 대화 더 불러오기
            </button>
          </div>
        )}

        {txError && (
          <div className="card failed" style={{ padding: 12 }}>
            <span className="tag err">트랜스크립트 오류</span>{" "}
            <span className="asd-dim">{txError}</span>
          </div>
        )}

        {!mine && messages.length === 0 && !txLoading && (
          <div className="card" style={{ padding: "18px 22px", textAlign: "center" }}>
            <p style={{ margin: 0, color: "var(--muted)" }}>
              {currentTarget
                ? `선택된 트랜스크립트(${currentTarget.label})에 저장된 대화가 없습니다. 상단 '대화 트랜스크립트' 탭에서 다른 하네스 대화를 선택하거나 아래 입력창에서 새 메시지를 보내세요.`
                : "저장된 대화 기록이 없습니다."}
            </p>
          </div>
        )}

        {/* Actual Conversation Messages from Harness Transcript */}
        {messages.map((m) => {
          const isUser = m.role === "user";
          const isSystem = m.role === "system" || m.role === "tool";
          return (
            <article
              key={`${m.index}-${m.role}`}
              className={`card asd-msg-card ${isUser ? "asd-msg-user" : isSystem ? "asd-msg-sys" : "asd-msg-assistant"}`}
            >
              <header className="card-ask">
                <div className="row" style={{ gap: 8 }}>
                  <span className={`tag ${isUser ? "work" : isSystem ? "" : "ok"}`}>
                    {isUser
                      ? "사용자"
                      : isSystem
                        ? m.role.toUpperCase()
                        : currentTarget
                          ? HARNESS_LABEL[currentTarget.harness] ?? currentTarget.harness
                          : "어시스턴트"}
                  </span>
                  {!isUser && currentTarget?.model && (
                    <code className="asd-dim" style={{ fontSize: 11.5 }}>
                      {currentTarget.model}
                    </code>
                  )}
                  {m.timestamp && (
                    <span className="asd-dim" style={{ fontSize: 11.5 }}>
                      {fmtTime(m.timestamp)}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  className="foot-btn"
                  title="메시지 복사"
                  onClick={() => void navigator.clipboard?.writeText(m.text)}
                >
                  <CopyIcon />
                </button>
              </header>
              <div className="card-body">
                {isUser ? (
                  <div className="asd-user-text">{m.text}</div>
                ) : (
                  <AssistantMessageBody text={m.text} />
                )}
              </div>
            </article>
          );
        })}

        {/* Live Job Execution Ribbon & Streaming Output */}
        {mine && (
          <article className={`card ${running ? "live" : ""} ${failed ? "failed" : ""}`}>
            <header className="card-ask">
              <div className="ask-text">{prompt ?? KIND_LABEL[mine.kind]}</div>
              <div className="ask-tags">
                <span className="tag work">{KIND_LABEL[mine.kind]}</span>
              </div>
            </header>
            <Ribbon nodes={jobNodes(mine)} />
            <div className="card-body">
              {output ? (
                <AssistantMessageBody text={output} />
              ) : running ? (
                <div className="typing" aria-label="준비 중">
                  <i />
                  <i />
                  <i />
                </div>
              ) : (
                <p className="asd-dim" style={{ textAlign: "left" }}>
                  실행이 완료되었습니다.
                </p>
              )}
              <SubLog lines={subLines} />
            </div>
            <footer className="card-foot">
              <div className="details">
                <button
                  className="details-line"
                  onClick={() => setOpen((o) => !o)}
                  aria-expanded={open}
                >
                  과정 보기
                  <span>{mine.progress.length + 2} 이벤트</span>
                  <ChevronIcon open={open} />
                </button>
                {open && (
                  <div className="details-body">
                    <Timeline job={mine} />
                  </div>
                )}
              </div>
              <button
                className="foot-btn"
                disabled={!output}
                onClick={() =>
                  navigator.clipboard.writeText(output).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  })
                }
              >
                <CopyIcon /> {copied ? "복사됨" : "복사"}
              </button>
            </footer>
          </article>
        )}
      </div>
    </div>
  );
}
