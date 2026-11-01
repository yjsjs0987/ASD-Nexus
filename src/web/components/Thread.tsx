// T4.1 — Elysium Thread.tsx의 "릴레이 리본 + 결과 카드" 패턴을 asd-gui 드라이버 실행으로 개조한다.
// 데이터 소스는 store(useApp)의 liveJob(WS job_started/progress/finished가 확정)과
// events.ts의 스트리밍 훅(useWsDriverOutputChunk · useWsSubagentLogChunk)이다.
// 카드 구조는 Elysium과 같다: 요청 머리 → 릴레이 리본 → 결과 본문 → 과정·복사 꼬리.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useApp, type LiveJob } from "../store";
import { useWsDriverOutputChunk, useWsSubagentLogChunk } from "../events.ts";
import type { JobKind } from "../../shared/protocol.ts";
import Markdown from "./Markdown";
import { ChevronIcon, CopyIcon } from "./Icons";

const KIND_LABEL: Record<JobKind, string> = {
  dispatch: "디스패치",
  debate: "토론",
  driver_turn: "드라이버 턴",
  subagent_action: "서브에이전트",
  resolve_conflict: "충돌 해결",
};

/** 리본 노드 칸은 Elysium 이식본 CSS(.ribbon-node.{kind})의 점 색을 그대로 쓴다 */
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

function fmtTime(ms: number) {
  return new Date(ms).toLocaleTimeString("ko-KR", { hour12: false });
}

/** 릴레이 리본: job_started → job_progress → job_finished를 노드로 잇는다. 진행 중이면 선이 흐르고 노드가 맥박친다. */
function Ribbon({ nodes }: { nodes: RibbonNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <div className="ribbon" role="list" aria-label="처리 과정">
      {nodes.map((n, i) => (
        <div key={n.key} className="ribbon-seg" role="listitem" style={{ "--i": i } as CSSProperties}>
          {i > 0 && <span className={`ribbon-link ${n.state === "wait" ? "" : n.state === "run" ? "flow" : "done"}`} aria-hidden />}
          <div className={`ribbon-node ${n.kind} ${n.state}`} title={`${n.title} · ${n.sub}`}>
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
      sub: job.progress.at(-1)?.message ?? "대기",
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

/** 서브에이전트 로그: 최근 몇 줄만 요약해서 보여 준다(상세 인스펙터는 T4.2) */
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
          <span className="asd-tl-what">job_finished · {job.finished.ok ? "성공" : job.finished.error ?? "실패"}</span>
        </div>
      )}
    </div>
  );
}

/** 서브에이전트 로그 청크를 최근 N줄로만 유지한다(부분 줄 포함) */
const SUBLOG_LINES = 9;

export default function Thread() {
  const app = useApp();
  const fgId = app.foregroundSessionId;
  const job = app.liveJob;
  const mine = job && job.sessionId === fgId ? job : null;

  // 스트리밍 본문은 여기만 다시 그리면 되는 고빈도 상태라 store가 아니라 로컬로 둔다.
  const [output, setOutput] = useState("");
  const [subLog, setSubLog] = useState("");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const runRef = useRef<string | null>(null);

  // 전경 세션이 바뀌거나 새 run이 시작되면 스트리밍 본문을 비운다.
  useEffect(() => {
    runRef.current = mine?.runId ?? null;
    setOutput("");
    setSubLog("");
  }, [fgId, mine?.runId]);

  useWsDriverOutputChunk((p) => {
    if (p.sessionId !== fgId) return;
    if (runRef.current !== p.runId) {
      runRef.current = p.runId;
      setOutput(p.chunk);
    } else {
      setOutput((o) => o + p.chunk);
    }
  });

  useWsSubagentLogChunk((p) => {
    if (p.sessionId !== fgId) return;
    setSubLog((b) => (b + p.chunk).split("\n").slice(-SUBLOG_LINES).join("\n"));
  });

  // 맨 아래를 보고 있을 때만 따라 내려간다(Elysium Thread의 stick 스크롤).
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [output.length, subLog.length, mine?.progress.length, mine?.finished?.at]);

  if (!mine) {
    return (
      <div className="thread empty asd-fill">
        <div className="welcome">
          <div className="orb-anchor" data-orb-anchor aria-hidden />
          <h1>
            드라이버 <em>대화</em>
          </h1>
          <p className="welcome-sub">
            아래 입력창에서 드라이버에게 프롬프트를 보내면 실행 리본과 출력이 여기에 표시됩니다
          </p>
        </div>
      </div>
    );
  }

  const running = !mine.finished;
  const failed = !!mine.finished && !mine.finished.ok;
  const prompt = app.lastPrompt && app.lastPrompt.sessionId === fgId ? app.lastPrompt.text : null;
  const subLines = subLog.split("\n").filter((l) => l.trim().length > 0).slice(-6);

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
              <Markdown text={output} />
            ) : running ? (
              <div className="typing" aria-label="준비 중">
                <i />
                <i />
                <i />
              </div>
            ) : (
              <p className="asd-dim" style={{ textAlign: "left" }}>
                드라이버 출력이 없었습니다.
              </p>
            )}
            <SubLog lines={subLines} />
          </div>
          <footer className="card-foot">
            <div className="details">
              <button className="details-line" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
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
      </div>
    </div>
  );
}
