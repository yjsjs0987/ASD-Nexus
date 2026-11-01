// T4.2 — 오른쪽 인스펙터: 선택된 작업의 서브에이전트 로그 스트림 + 제어 버튼(kill/retry/fallback/custom/resume).
// 선택된 작업이 없으면 전경 세션의 서브에이전트 목록 표시.
// WS subagent_log_chunk 스트리밍 + api.subagentAction으로 제어.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../store";
import * as api from "../api.ts";
import { useWsSubagentLogChunk, useWsLogClosed } from "../events.ts";
import type { SubagentControlActionType, SubagentActionRequest } from "../../shared/protocol.ts";
import { StopIcon, RefreshIcon, ArrowDownIcon, SparkIcon, PlayIcon, TerminalIcon, AlertTriangleIcon } from "./Icons";

interface SubagentLogEntry {
  subSessionId: string;
  lines: string[];
  closed: boolean;
  reason?: "finished" | "deleted";
}

const ACTION_LABELS: Record<SubagentControlActionType, string> = {
  kill: "중지",
  retry: "재시도",
  fallback: "폴백",
  custom: "커스텀",
  resume: "이어하기",
};

const ACTION_ICONS: Record<SubagentControlActionType, React.ReactNode> = {
  kill: <StopIcon />,
  retry: <RefreshIcon />,
  fallback: <ArrowDownIcon />,
  custom: <SparkIcon />,
  resume: <PlayIcon />,
};

export default function SubagentInspector() {
  const app = useApp();
  const projectRoot = app.projectRoot;
  const fgId = app.foregroundSessionId;
  const selectedTaskId = app.selectedTaskId;
  const snapshot = app.snapshot;

  // 선택된 작업의 subSessionId 찾기
  const selectedTask = useMemo(() => {
    if (!selectedTaskId || !snapshot) return null;
    return snapshot.allTasks?.find((t) => t.task_id === selectedTaskId) ?? null;
  }, [selectedTaskId, snapshot]);

  const selectedSubSessionId = selectedTask?.sub_session_id ?? null;

  // 전경 세션의 서브에이전트 로그들 (작업 미선택 시)
  const fgSubagentLogs = useMemo(() => {
    if (!fgId || !snapshot) return [];
    return snapshot.subagentLogs?.filter((l) => l.sessionId === fgId) ?? [];
  }, [fgId, snapshot]);

  // 로그 스트리밍 상태
  const [logBuffers, setLogBuffers] = useState<Map<string, SubagentLogEntry>>(new Map());
  const [activeSubSessionId, setActiveSubSessionId] = useState<string | null>(null);
  const [actionStates, setActionStates] = useState<Map<string, { loading: boolean; error: string | null }>>(new Map());

  // 선택된 작업이 있으면 그 subSessionId로, 없으면 첫 번째 fg 서브에이전트로
  const defaultSubSessionId = useMemo(() => {
    if (selectedSubSessionId) return selectedSubSessionId;
    return fgSubagentLogs[0]?.subSessionId ?? null;
  }, [selectedSubSessionId, fgSubagentLogs]);

  // 활성 subSessionId 동기화
  useEffect(() => {
    if (defaultSubSessionId && defaultSubSessionId !== activeSubSessionId) {
      setActiveSubSessionId(defaultSubSessionId);
    }
  }, [defaultSubSessionId, activeSubSessionId]);

  // WS 로그 청크 구독
  useWsSubagentLogChunk((p) => {
    if (!projectRoot || p.projectRoot !== projectRoot || !fgId || p.sessionId !== fgId) return;
    setLogBuffers((prev) => {
      const next = new Map(prev);
      const existing = next.get(p.subSessionId) ?? { subSessionId: p.subSessionId, lines: [], closed: false };
      const newLines = (existing.lines.concat(p.chunk.split("\n"))).slice(-200); // 최근 200줄만
      next.set(p.subSessionId, { ...existing, lines: newLines });
      return next;
    });
  });

  // 로그 스트림 종료
  useWsLogClosed((p) => {
    if (!projectRoot || p.projectRoot !== projectRoot || !fgId || p.sessionId !== fgId) return;
    setLogBuffers((prev) => {
      const next = new Map(prev);
      const existing = next.get(p.subSessionId);
      if (existing) {
        next.set(p.subSessionId, { ...existing, closed: true, reason: p.reason });
      }
      return next;
    });
  });

  // 서브에이전트 액션 실행
  const runAction = useCallback(async (action: SubagentControlActionType, subSessionId: string, prompt?: string) => {
    if (!projectRoot || !fgId) return;
    setActionStates((prev) => {
      const next = new Map(prev);
      next.set(subSessionId, { loading: true, error: null });
      return next;
    });
    try {
      const req: SubagentActionRequest = {
        projectRoot,
        sessionId: fgId,
        subSessionId,
        action,
        prompt,
      };
      const res = await api.subagentAction(req);
      // job 이벤트는 Thread가 표시
      setActionStates((prev) => {
        const next = new Map(prev);
        next.set(subSessionId, { loading: false, error: null });
        return next;
      });
    } catch (e) {
      setActionStates((prev) => {
        const next = new Map(prev);
        next.set(subSessionId, { loading: false, error: api.errorText(e) });
        return next;
      });
    }
  }, [projectRoot, fgId]);

  // 커스텀 프롬프트 모달 상태
  const [customPrompt, setCustomPrompt] = useState("");
  const [customTarget, setCustomTarget] = useState<{ subSessionId: string; action: SubagentControlActionType } | null>(null);

  const openCustomPrompt = (subSessionId: string, action: SubagentControlActionType) => {
    setCustomTarget({ subSessionId, action });
    setCustomPrompt("");
  };

  const confirmCustomPrompt = () => {
    if (customTarget && customPrompt.trim()) {
      runAction(customTarget.action, customTarget.subSessionId, customPrompt.trim());
    }
    setCustomTarget(null);
    setCustomPrompt("");
  };

  // 표시할 로그 엔트리
  const activeLog = activeSubSessionId ? logBuffers.get(activeSubSessionId) : null;
  const activeActionState = activeSubSessionId ? actionStates.get(activeSubSessionId) : null;

  if (!projectRoot || !fgId) {
    return (
      <div className="tools-inner">
        <div className="tool-empty">프로젝트를 열고 전경 세션을 선택하세요</div>
      </div>
    );
  }

  // 서브에이전트 목록 (작업 미선택 시)
  const showList = !selectedTaskId && fgSubagentLogs.length > 0;

  return (
    <div className="tools-inner">
      {/* 헤더: 선택된 작업 또는 세션 정보 */}
      <div className="tool-sec">
        <h4>
          {selectedTask ? (
            <>
              <span className="agent-count">{selectedTask.task_id}</span>
              {selectedTask.title && <span style={{ marginLeft: 8, color: "var(--muted)" }}>{selectedTask.title}</span>}
            </>
          ) : (
            <>
              <span className="agent-count">세션</span>
              <span style={{ marginLeft: 8, color: "var(--muted)" }}>{fgId?.slice(0, 12)}</span>
            </>
          )}
        </h4>
        {selectedTask && (
          <div className="tool-folder">
            <TerminalIcon /> subSession: <code>{selectedSubSessionId ?? "—"}</code>
          </div>
        )}
      </div>

      {/* 서브에이전트 선택 (작업 미선택 시) */}
      {showList && (
        <div className="tool-sec">
          <h4>서브에이전트 <span className="agent-count">{fgSubagentLogs.length}</span></h4>
          {fgSubagentLogs.map((log) => (
            <button
              key={log.subSessionId}
              className={`agent-task ${activeSubSessionId === log.subSessionId ? "here" : ""}`}
              onClick={() => setActiveSubSessionId(log.subSessionId)}
            >
              <div className="agent-task-head">
                <b>{log.subSessionId.slice(0, 16)}…</b>
                <span className="agent-time">{log.harness ?? "—"}</span>
              </div>
              <div className="agent-runs">
                <div className={`agent-run ${log.harnessSessionId ? "ok" : "wait"}`}>
                  <i className="agent-dot" aria-hidden />
                  <div className="agent-main">
                    <div className="agent-line">
                      <b>{log.harness ?? "알 수 없음"}</b>
                      <span className="agent-role">{log.taskId ? `태스크: ${log.taskId}` : "독립 실행"}</span>
                      <span className={`agent-state ${log.harnessSessionId ? "ok" : "wait"}`}>
                        {log.harnessSessionId ? "연결됨" : "연결 대기"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* 로그 스트림 뷰어 */}
      {activeSubSessionId && (
        <div className="tool-sec" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <div className="sec-head">
            <h4>
              <span className="agent-count">{activeSubSessionId.slice(0, 16)}…</span>
              로그 스트림
            </h4>
            {activeLog?.closed && (
              <span className="tag warn">{activeLog.reason === "finished" ? "완료됨" : "삭제됨"}</span>
            )}
          </div>
          <div
            className="asd-sublog-viewer"
            style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: "var(--mono)", fontSize: "12px", lineHeight: 1.6 }}
            role="log"
            aria-live="polite"
          >
            {activeLog?.lines.map((line, i) => (
              <div key={i} style={{ padding: "1px 4px", borderBottom: "1px solid var(--line)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {line || <span style={{ color: "var(--dim)" }}>␤</span>}
              </div>
            ))}
            {!activeLog?.lines.length && (
              <div className="asd-dim" style={{ padding: "16px", textAlign: "center" }}>
                {activeLog?.closed ? "로그 스트림이 종료되었습니다" : "로그 수신 대기 중…"}
              </div>
            )}
          </div>
          {/* 제어 버튼 */}
          <div className="asd-inspector-actions" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
            {(["kill", "retry", "fallback", "custom", "resume"] as SubagentControlActionType[]).map((action) => {
              const disabled = activeActionState?.loading || (action === "resume" && !activeLog?.closed);
              return (
                <button
                  key={action}
                  className={`btn sm ${action === "kill" ? "danger" : ""} ${action === "custom" ? "ghost" : ""}`}
                  disabled={disabled}
                  onClick={() => action === "custom" ? openCustomPrompt(activeSubSessionId!, action) : runAction(action, activeSubSessionId!)}
                  title={ACTION_LABELS[action]}
                >
                  {ACTION_ICONS[action]} {ACTION_LABELS[action]}
                </button>
              );
            })}
            {activeActionState?.error && (
              <span className="tag asd-tag-err" style={{ alignSelf: "center" }}>{activeActionState.error}</span>
            )}
          </div>
        </div>
      )}

      {/* 작업 선택 안내 */}
      {!selectedTaskId && fgSubagentLogs.length === 0 && (
        <div className="tool-empty">
          이 세션에 실행 중인 서브에이전트가 없습니다.<br />
          PLAN 보드에서 태스크를 디스패치하거나 드라이버 턴을 실행하세요.
        </div>
      )}

      {/* 커스텀 프롬프트 모달 */}
      {customTarget && (
        <div className="modal-back" onClick={() => { setCustomTarget(null); setCustomPrompt(""); }}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-icon"><SparkIcon /></div>
            <h2>커스텀 프롬프트 — {ACTION_LABELS[customTarget.action]}</h2>
            <p className="asd-dim">서브에이전트 <code>{customTarget.subSessionId.slice(0, 16)}…</code>에 보낼 추가 프롬프트</p>
            <textarea
              className="asd-plan-textarea"
              style={{ minHeight: "100px", marginTop: "8px", marginBottom: "8px" }}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder="추가 지시사항을 입력하세요 (선택 사항)"
              autoFocus
            />
            <div className="confirm-actions">
              <button className="btn" onClick={() => { setCustomTarget(null); setCustomPrompt(""); }}>취소</button>
              <button className="btn primary" onClick={confirmCustomPrompt} disabled={customPrompt.trim().length === 0}>전송</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}