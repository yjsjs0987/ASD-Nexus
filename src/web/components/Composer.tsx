// T4.1 — Elysium Composer를 asd-gui 드라이버 프롬프트 입력으로 재작성한다(Elysium Composer는
// engines/skills/conversations 도메인에 결합돼 있어 복사하지 않고 계약만 맞춘다).
// 전송은 api.driverPrompt(mode:"chat") — jobId 회신을 기록하고, 리본 활성화는 job_started가 담당한다.
// 실행 중 판정은 store의 liveJob(job_started~finished 사이) — 낙관적 갱신 없음.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import * as api from "../api.ts";
import { useApp, type HarnessId } from "../store";
import type { TranscriptMessage } from "../../shared/protocol.ts";
import { ChevronIcon, CopyIcon, FolderIcon, ListIcon, SendIcon, StopIcon } from "./Icons";

const TX_LIMIT = 30;

export default function Composer() {
  const app = useApp();
  const fgId = app.foregroundSessionId;
  const projectRoot = app.projectRoot;
  const fg = app.snapshot?.sessions.find((s) => s.session_id === fgId) ?? null;
  const job = app.liveJob;
  const running = !!(fgId && job && job.sessionId === fgId && !job.finished);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [txOpen, setTxOpen] = useState(false);
  const [txLoading, setTxLoading] = useState(false);
  const [txMessages, setTxMessages] = useState<TranscriptMessage[] | null>(null);
  const [resume, setResume] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  const harness = (fg?.main_harness as HarnessId | undefined) ?? null;
  const harnessSessionId = fg?.harness_session_id ?? null;

  useEffect(() => ref.current?.focus(), [fgId]);

  // 입력에 맞춰 높이를 늘린다(Elysium Composer와 같다).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  async function submit() {
    const t = text.trim();
    if (!t || !projectRoot || !fgId || sending || running) return;
    setSending(true);
    try {
      const r = await api.driverPrompt({ projectRoot, sessionId: fgId, prompt: t, mode: "chat" });
      app.recordPrompt(fgId, t, r.jobId);
      setText("");
    } catch (e) {
      app.reportError(api.errorText(e));
    } finally {
      setSending(false);
    }
  }

  async function stop() {
    if (!projectRoot || !fgId || !job?.runId) return;
    try {
      await api.cancelDriver({ projectRoot, sessionId: fgId, runId: job.runId });
    } catch (e) {
      app.reportError(api.errorText(e));
    }
  }

  async function loadTranscripts() {
    if (!projectRoot || !harness || !harnessSessionId) return;
    setTxLoading(true);
    try {
      const r = await api.getTranscript({ projectRoot, harness, harnessSessionId, limit: TX_LIMIT });
      setTxMessages(r.found ? r.messages : []);
    } catch (e) {
      app.reportError(api.errorText(e));
    } finally {
      setTxLoading(false);
    }
  }

  function toggleTranscripts() {
    const next = !txOpen;
    setTxOpen(next);
    if (next && txMessages == null && !txLoading) void loadTranscripts();
  }

  async function loadResume() {
    if (!harness || resume != null) return;
    try {
      const r = await api.getResumeCommand({ harness, harnessSessionId: harnessSessionId ?? undefined });
      setResume(r.cliString || [r.command, ...r.args].join(" "));
    } catch (e) {
      app.reportError(api.errorText(e));
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  }

  const canTranscript = !!(projectRoot && harness && harnessSessionId);

  return (
    <div className="composer-wrap">
      {txOpen && (
        <div className="asd-tx-panel" role="region" aria-label="최근 대화 기록">
          <div className="asd-tx-head">
            <b>최근 대화</b>
            <button className="pill-x" onClick={() => setTxOpen(false)} aria-label="대화 기록 닫기">
              ×
            </button>
          </div>
          {txLoading && <p className="asd-dim">불러오는 중…</p>}
          {txMessages != null && txMessages.length === 0 && <p className="asd-dim">기록이 없습니다.</p>}
          {txMessages == null && !txLoading && <p className="asd-dim">기록을 불러올 수 없습니다.</p>}
          <div className="asd-tx-list">
            {(txMessages ?? []).map((m) => (
              <div key={m.index} className="asd-tx-item">
                <span className={`tag ${m.role === "user" ? "work" : ""}`}>{m.role}</span>
                <span className="asd-tx-text" title={m.text}>
                  {m.text || "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="composer">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            running
              ? "드라이버가 실행 중입니다 — 중지 버튼으로 멈출 수 있습니다"
              : "드라이버에게 보낼 프롬프트를 적으세요 (Enter 전송 · Shift+Enter 줄바꿈)"
          }
          aria-label="드라이버 프롬프트 입력"
        />
        <div className="composer-bar">
          <span className="folder-chip">
            <span className="pill" title={fg?.project_root ?? ""}>
              <FolderIcon /> <span className="pill-text">{fg?.project_root ? api.baseName(fg.project_root) : "세션 폴더"}</span>
            </span>
          </span>
          <button className="pill" onClick={toggleTranscripts} disabled={!canTranscript} aria-expanded={txOpen} title="최근 대화 기록">
            <ListIcon /> <span className="pill-text">대화 기록</span>
          </button>
          <details className="asd-resume" onToggle={(e) => (e.target as HTMLDetailsElement).open && void loadResume()}>
            <summary className="pill" title="이 세션을 CLI에서 이어서 열 때 쓰는 명령">
              재개 명령 <ChevronIcon />
            </summary>
            <div className="asd-pop">
              {resume ? (
                <>
                  <code className="asd-resume-cmd">{resume}</code>
                  <button
                    className="btn sm"
                    onClick={() => navigator.clipboard.writeText(resume)}
                  >
                    <CopyIcon /> 복사
                  </button>
                </>
              ) : (
                <p className="asd-dim">명령을 불러오는 중…</p>
              )}
            </div>
          </details>
          <div className="spacer" />
          {running ? (
            <button className="send stop" onClick={() => void stop()} aria-label="중지" title="실행 중인 드라이버 턴을 중지합니다">
              <StopIcon />
            </button>
          ) : (
            <button
              className="send"
              onClick={() => void submit()}
              disabled={!text.trim() || sending}
              aria-label="전송"
              title="드라이버에게 프롬프트를 보냅니다 (Enter)"
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
      <div className="composer-note">Enter 전송 · Shift+Enter 줄바꿈 — 실행 결과는 위 대화 카드의 리본과 본문에 표시됩니다.</div>
    </div>
  );
}
