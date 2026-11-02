// T4.2 — 오른쪽 인스펙터: 태스크/토론 상세 메타데이터 + 서브에이전트 목록 + 프롬프트(prompt.md)/출력(output.log) 뷰어 + 5대 제어 액션
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp, type HarnessId } from "../store";
import * as api from "../api.ts";
import { useWsSubagentLogChunk, useWsLogClosed } from "../events.ts";
import type {
  SubagentControlActionType,
  SubagentActionRequest,
} from "../../shared/protocol.ts";
import {
  StopIcon,
  RefreshIcon,
  ArrowDownIcon,
  SparkIcon,
  PlayIcon,
  TerminalIcon,
  GitBranchIcon,
} from "./Icons";
import { HARNESS_ALL, HARNESS_LABEL } from "./DriverBar.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

interface SubagentLogEntry {
  subSessionId: string;
  lines: string[];
  closed: boolean;
  reason?: "finished" | "deleted";
}

const ACTION_LABELS: Record<SubagentControlActionType, string> = {
  kill: "강제 종료",
  retry: "재시도",
  fallback: "폴백 전환",
  custom: "커스텀 실행",
  resume: "후속 이어하기",
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
  const baseSessionId = useMemo(() => {
    if (!fgId) return null;
    const idx = fgId.indexOf("::");
    return idx !== -1 ? fgId.slice(0, idx) : fgId;
  }, [fgId]);
  const selectedTaskId = app.selectedTaskId;
  const snapshot = app.snapshot;

  const selectedTask = useMemo(() => {
    if (!selectedTaskId || !snapshot) return null;
    return (
      snapshot.allTasks?.find(
        (t) =>
          (t.session_id === fgId || t.session_id === baseSessionId) &&
          t.task_id === selectedTaskId,
      ) ?? null
    );
  }, [selectedTaskId, snapshot, fgId, baseSessionId]);

  const selectedDebate = useMemo(() => {
    if (!selectedTaskId || !snapshot) return null;
    return (
      snapshot.allDebates?.find(
        (d) =>
          (d.session_id === fgId || d.session_id === baseSessionId) &&
          d.debate_id === selectedTaskId,
      ) ?? null
    );
  }, [selectedTaskId, snapshot, fgId, baseSessionId]);

  const sessionSubagentLogs = useMemo(() => {
    if (!fgId || !snapshot) return [];
    return (
      snapshot.subagentLogs?.filter(
        (l) => l.sessionId === fgId || l.sessionId === baseSessionId,
      ) ?? []
    );
  }, [fgId, baseSessionId, snapshot]);

  const filteredSubagentLogs = useMemo(() => {
    if (!selectedTaskId) return sessionSubagentLogs;
    return sessionSubagentLogs.filter(
      (l) =>
        l.taskId === selectedTaskId ||
        l.subSessionId === selectedTask?.sub_session_id ||
        l.subSessionId.includes(`-deb-${selectedTaskId}-`),
    );
  }, [sessionSubagentLogs, selectedTaskId, selectedTask?.sub_session_id]);

  const [logBuffers, setLogBuffers] = useState<Map<string, SubagentLogEntry>>(
    new Map(),
  );
  const [activeSubSessionId, setActiveSubSessionId] = useState<string | null>(
    null,
  );
  const [actionStates, setActionStates] = useState<
    Map<string, { loading: boolean; error: string | null }>
  >(new Map());

  const defaultSubSessionId = useMemo(() => {
    if (selectedTask?.sub_session_id) return selectedTask.sub_session_id;
    return (
      filteredSubagentLogs[0]?.subSessionId ??
      sessionSubagentLogs[0]?.subSessionId ??
      null
    );
  }, [selectedTask?.sub_session_id, filteredSubagentLogs, sessionSubagentLogs]);

  useEffect(() => {
    if (
      defaultSubSessionId &&
      (!activeSubSessionId ||
        !filteredSubagentLogs.some((l) => l.subSessionId === activeSubSessionId))
    ) {
      setActiveSubSessionId(defaultSubSessionId);
    }
  }, [defaultSubSessionId, activeSubSessionId, filteredSubagentLogs]);

  useWsSubagentLogChunk((p) => {
    if (
      !projectRoot ||
      p.projectRoot !== projectRoot ||
      (p.sessionId !== fgId && p.sessionId !== baseSessionId)
    )
      return;
    setLogBuffers((prev) => {
      const next = new Map(prev);
      const existing = next.get(p.subSessionId) ?? {
        subSessionId: p.subSessionId,
        lines: [],
        closed: false,
      };
      const newLines = existing.lines.concat(p.chunk.split("\n")).slice(-300);
      next.set(p.subSessionId, { ...existing, lines: newLines });
      return next;
    });
  });

  useWsLogClosed((p) => {
    if (
      !projectRoot ||
      p.projectRoot !== projectRoot ||
      (p.sessionId !== fgId && p.sessionId !== baseSessionId) ||
      !p.subSessionId
    )
      return;
    const subId = p.subSessionId;
    setLogBuffers((prev) => {
      const next = new Map(prev);
      const existing = next.get(subId);
      if (existing) {
        next.set(subId, { ...existing, closed: true, reason: p.reason });
      }
      return next;
    });
  });

  const runAction = useCallback(
    async (
      action: SubagentControlActionType,
      subSessionId: string,
      opts?: { harness?: HarnessId; model?: string; prompt?: string },
    ) => {
      if (!projectRoot || !baseSessionId) return;
      setActionStates((prev) => {
        const next = new Map(prev);
        next.set(subSessionId, { loading: true, error: null });
        return next;
      });
      try {
        const req: SubagentActionRequest = {
          projectRoot,
          sessionId: baseSessionId,
          subSessionId,
          action,
          ...(opts?.harness ? { harness: opts.harness } : {}),
          ...(opts?.model?.trim() ? { model: opts.model.trim() } : {}),
          ...(opts?.prompt?.trim() ? { prompt: opts.prompt.trim() } : {}),
        };
        await api.subagentAction(req);
        await app.refreshSnapshot();
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
    },
    [projectRoot, baseSessionId, app],
  );

  // Custom / Resume modal state
  const [modalTarget, setModalTarget] = useState<{
    subSessionId: string;
    action: "custom" | "resume";
    defaultHarness: HarnessId;
    defaultModel: string;
  } | null>(null);
  const [customHarness, setCustomHarness] = useState<HarnessId>("claude-code");
  const [customModel, setCustomModel] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");

  const activeSubRecord = useMemo(
    () =>
      sessionSubagentLogs.find((l) => l.subSessionId === activeSubSessionId) ??
      null,
    [sessionSubagentLogs, activeSubSessionId],
  );

  const openActionModal = (
    subSessionId: string,
    action: "custom" | "resume",
  ) => {
    const rec = sessionSubagentLogs.find((l) => l.subSessionId === subSessionId);
    const h = (rec?.harness as HarnessId | undefined) ?? "claude-code";
    const m = rec?.model && rec.model !== "default" ? rec.model : "";
    setModalTarget({
      subSessionId,
      action,
      defaultHarness: h,
      defaultModel: m,
    });
    setCustomHarness(h);
    setCustomModel(m);
    setCustomPrompt("");
  };

  const confirmActionModal = () => {
    if (!modalTarget) return;
    if (modalTarget.action === "custom") {
      void runAction("custom", modalTarget.subSessionId, {
        harness: customHarness,
        model: customModel,
        prompt: customPrompt,
      });
    } else {
      void runAction("resume", modalTarget.subSessionId, {
        model: customModel,
        prompt: customPrompt || "작업을 이어서 진행하라.",
      });
    }
    setModalTarget(null);
    setCustomPrompt("");
  };

  const activeLog = activeSubSessionId
    ? logBuffers.get(activeSubSessionId)
    : null;
  const activeActionState = activeSubSessionId
    ? actionStates.get(activeSubSessionId)
    : null;

  // Combine snapshot output.log with any live WS stream lines
  const displayLines = useMemo(() => {
    if (activeLog && activeLog.lines.length > 0) {
      return activeLog.lines;
    }
    if (activeSubRecord?.output) {
      return activeSubRecord.output.split(/\r?\n/);
    }
    return [];
  }, [activeLog, activeSubRecord?.output]);

  const isSubFinished =
    activeLog?.closed ||
    activeSubRecord?.status === "done" ||
    activeSubRecord?.status === "failed";

  if (!projectRoot || !fgId) {
    return (
      <div className="tools-inner">
        <div className="tool-empty">프로젝트를 열고 전경 세션을 선택하세요</div>
      </div>
    );
  }

  // Parse task target files & done claim if a task is selected
  let targetFiles: string[] = [];
  if (selectedTask?.target_files_json) {
    try {
      targetFiles = JSON.parse(selectedTask.target_files_json) as string[];
    } catch {
      targetFiles = [];
    }
  }
  let doneClaim: {
    summary?: string;
    key_decisions?: string[];
    changed_files?: string[];
    risks?: string[];
  } | null = null;
  if (selectedTask?.done_claim_json) {
    try {
      doneClaim = JSON.parse(selectedTask.done_claim_json);
    } catch {
      doneClaim = null;
    }
  }
  const worktreeStatusLines =
    selectedTask && baseSessionId
      ? snapshot?.worktreeStatuses?.[`${baseSessionId}::${selectedTask.task_id}`] ??
        []
      : [];

  return (
    <div className="tools-inner">
      {/* 헤더 및 필터 해제 */}
      <div className="tool-sec">
        <div className="sec-head">
          <h4>
            {selectedTask ? (
              <>
                <span className="agent-count">{selectedTask.task_id}</span>
                <span style={{ marginLeft: 6 }}>{selectedTask.title}</span>
              </>
            ) : selectedDebate ? (
              <>
                <span className="agent-count">{selectedDebate.debate_id}</span>
                <span style={{ marginLeft: 6 }}>{selectedDebate.topic}</span>
              </>
            ) : (
              <>
                <span className="agent-count">서브에이전트 인스펙터</span>
              </>
            )}
          </h4>
          {selectedTaskId && (
            <button
              type="button"
              className="btn xs ghost"
              onClick={() => app.setSelectedTaskId(null)}
              title="전체 서브에이전트 목록 보기"
            >
              전체 보기 ({sessionSubagentLogs.length})
            </button>
          )}
        </div>

        {/* 선택된 태스크 상세 메타데이터 카드 (asd ui 포트) */}
        {selectedTask && (
          <div className="asd-inspector-meta">
            <div className="row" style={{ gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
              <span className="tag">Turn {selectedTask.turn}</span>
              <span className="tag">{selectedTask.track}</span>
              <span className="tag">{selectedTask.role}</span>
              <span className="tag">{selectedTask.status}</span>
              <span className="tag">시도 {selectedTask.attempts}회</span>
              {(selectedTask.status === "verifying" ||
                selectedTask.status === "merge_conflict" ||
                selectedTask.worktree_path) && (
                <button
                  type="button"
                  className="btn xs"
                  onClick={() => app.openDiff(selectedTask.task_id)}
                >
                  <GitBranchIcon /> Diff·승인/충돌해결
                </button>
              )}
            </div>
            {targetFiles.length > 0 && (
              <div className="asd-meta-line">
                <b>대상 파일:</b> <code>{targetFiles.join(", ")}</code>
              </div>
            )}
            {selectedTask.context_hint && (
              <div className="asd-meta-line">
                <b>힌트:</b> {selectedTask.context_hint}
              </div>
            )}
            {selectedTask.verify_cmd && (
              <div className="asd-meta-line">
                <b>검증 명령:</b> <code>{selectedTask.verify_cmd}</code>
              </div>
            )}
            {worktreeStatusLines.length > 0 && (
              <div className="asd-meta-line">
                <b>워크트리 변경:</b>{" "}
                <code>{worktreeStatusLines.join(" | ")}</code>
              </div>
            )}
            {doneClaim?.summary && (
              <div className="asd-meta-line ok">
                <b>완료 요약:</b> {doneClaim.summary}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 서브에이전트 목록 */}
      {filteredSubagentLogs.length > 0 && (
        <div className="tool-sec" style={{ maxHeight: 190, overflowY: "auto" }}>
          <h4>
            서브에이전트 실행 기록{" "}
            <span className="agent-count">{filteredSubagentLogs.length}</span>
          </h4>
          {filteredSubagentLogs.map((log) => {
            const isHere = activeSubSessionId === log.subSessionId;
            const st = log.status ?? "running";
            const stateClass =
              st === "done" ? "ok" : st === "failed" ? "fail" : "run";
            const durSec = log.durationMs
              ? `${(log.durationMs / 1000).toFixed(1)}s`
              : "";
            return (
              <button
                key={log.subSessionId}
                type="button"
                className={`agent-task ${isHere ? "here" : ""}`}
                onClick={() => setActiveSubSessionId(log.subSessionId)}
              >
                <div className="agent-task-head">
                  <b>{log.taskId || log.role || log.subSessionId.slice(0, 14)}</b>
                  <span className="agent-time">
                    {HARNESS_LABEL[log.harness as HarnessId] ?? log.harness}{" "}
                    {durSec && `· ${durSec}`}
                  </span>
                </div>
                <div className="agent-runs">
                  <div className={`agent-run ${stateClass}`}>
                    <i className="agent-dot" aria-hidden />
                    <div className="agent-main">
                      <div className="agent-line">
                        <b>{log.model || "default"}</b>
                        <span className="agent-role">
                          {log.subSessionId.slice(0, 18)}
                        </span>
                        <span className={`agent-state ${stateClass}`}>
                          {st === "done"
                            ? "완료"
                            : st === "failed"
                              ? "실패"
                              : "실행 중"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* 선택된 서브에이전트 프롬프트 & 로그 뷰어 + 제어 액션 */}
      {activeSubSessionId && (
        <div
          className="tool-sec"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div className="sec-head">
            <h4>
              <span className="agent-count">
                {activeSubRecord?.taskId || activeSubSessionId.slice(0, 14)}
              </span>{" "}
              실행 출력
            </h4>
            <div className="row" style={{ gap: 4 }}>
              {activeSubRecord?.harness && (
                <span className="tag">
                  {HARNESS_LABEL[activeSubRecord.harness as HarnessId] ??
                    activeSubRecord.harness}
                </span>
              )}
              {activeSubRecord?.status && (
                <span
                  className={`tag ${
                    activeSubRecord.status === "done"
                      ? "ok"
                      : activeSubRecord.status === "failed"
                        ? "asd-tag-err"
                        : "warn"
                  }`}
                >
                  {activeSubRecord.status}
                </span>
              )}
            </div>
          </div>

          {/* 전달된 프롬프트 (prompt.md) 접기/펼치기 (asd ui 포트) */}
          {activeSubRecord?.prompt && (
            <details className="asd-prompt-details">
              <summary>전달된 프롬프트 (prompt.md) 보기</summary>
              <pre className="asd-prompt-pre">{activeSubRecord.prompt}</pre>
            </details>
          )}

          {/* 출력 로그 뷰어 */}
          <div
            className="asd-sublog-viewer"
            style={{
              flex: 1,
              minHeight: 120,
              overflow: "auto",
              fontFamily: "var(--mono)",
              fontSize: "12px",
              lineHeight: 1.55,
            }}
            role="log"
            aria-live="polite"
          >
            {displayLines.map((line, i) => (
              <div
                key={i}
                style={{
                  padding: "1px 4px",
                  borderBottom: "1px solid var(--line)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {line || <span style={{ color: "var(--dim)" }}>␤</span>}
              </div>
            ))}
            {displayLines.length === 0 && (
              <div
                className="asd-dim"
                style={{ padding: "16px", textAlign: "center" }}
              >
                {isSubFinished
                  ? "기록된 출력 로그가 없습니다"
                  : "로그 수신 대기 중…"}
              </div>
            )}
          </div>

          {/* 5대 제어 버튼 + PTY 터미널 열기 */}
          <div
            className="asd-inspector-actions"
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              paddingTop: 6,
              borderTop: "1px solid var(--line)",
            }}
          >
            {(
              [
                "kill",
                "retry",
                "fallback",
                "custom",
                "resume",
              ] as SubagentControlActionType[]
            ).map((action) => {
              const disabled =
                activeActionState?.loading ||
                (action === "resume" && !isSubFinished);
              return (
                <button
                  key={action}
                  type="button"
                  className={`btn sm ${action === "kill" ? "danger" : ""} ${action === "custom" ? "ghost" : ""}`}
                  disabled={disabled}
                  onClick={() =>
                    action === "custom" || action === "resume"
                      ? openActionModal(activeSubSessionId, action)
                      : void runAction(action, activeSubSessionId)
                  }
                  title={ACTION_LABELS[action]}
                >
                  {ACTION_ICONS[action]} {ACTION_LABELS[action]}
                </button>
              );
            })}
            {activeSubRecord?.harness && (
              <button
                type="button"
                className="btn sm ghost"
                title="하단 PTY 터미널에서 이 서브에이전트 세션 열기"
                onClick={() =>
                  app.openTerminalTab({
                    title: `Subagent (${activeSubRecord.taskId || activeSubRecord.role})`,
                    cwd:
                      activeSubRecord.worktreePath || projectRoot || undefined,
                    harness: activeSubRecord.harness as HarnessId,
                    harnessSessionId:
                      activeSubRecord.harnessSessionId ?? undefined,
                    model:
                      activeSubRecord.model &&
                      activeSubRecord.model !== "default"
                        ? activeSubRecord.model
                        : undefined,
                  })
                }
              >
                <TerminalIcon /> PTY
              </button>
            )}
            {activeActionState?.error && (
              <span className="tag asd-tag-err" style={{ alignSelf: "center" }}>
                {activeActionState.error}
              </span>
            )}
          </div>
        </div>
      )}

      {filteredSubagentLogs.length === 0 && (
        <div className="tool-empty">
          {selectedTaskId
            ? `선택된 항목(${selectedTaskId})에 연결된 서브에이전트 실행 로그가 아직 없습니다.`
            : "이 세션에 실행된 서브에이전트가 없습니다.\nPLAN 보드에서 태스크를 디스패치하거나 적대적 토론을 실행하세요."}
        </div>
      )}

      {/* 커스텀 실행 / 이어하기 모달 (하네스 + ModelPicker + 프롬프트) */}
      {modalTarget && (
        <div
          className="modal-back"
          onClick={() => {
            setModalTarget(null);
            setCustomPrompt("");
          }}
        >
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-icon">
              <SparkIcon />
            </div>
            <h2>
              {modalTarget.action === "custom"
                ? "서브에이전트 커스텀 실행"
                : "서브에이전트 후속 이어하기 (Resume)"}
            </h2>
            <p className="asd-dim">
              대상: <code>{modalTarget.subSessionId}</code>
            </p>

            <div
              className="row"
              style={{ gap: 8, marginTop: 10, marginBottom: 8, flexWrap: "wrap" }}
            >
              {modalTarget.action === "custom" ? (
                <select
                  className="asd-select"
                  value={customHarness}
                  onChange={(e) => {
                    const nextH = e.target.value as HarnessId;
                    setCustomHarness(nextH);
                    const list =
                      app.snapshot?.availableModels?.[nextH] ?? [];
                    setCustomModel(list[0] ?? "");
                  }}
                  aria-label="커스텀 하네스"
                >
                  {HARNESS_ALL.map((h) => (
                    <option key={h} value={h}>
                      {HARNESS_LABEL[h]}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="tag ok">
                  하네스 고정:{" "}
                  {HARNESS_LABEL[modalTarget.defaultHarness] ??
                    modalTarget.defaultHarness}
                </span>
              )}

              <ModelPicker
                harness={
                  modalTarget.action === "custom"
                    ? customHarness
                    : modalTarget.defaultHarness
                }
                value={customModel}
                onChange={setCustomModel}
                ariaLabel="서브에이전트 모델 선택"
              />
            </div>

            <textarea
              className="asd-plan-textarea"
              style={{ minHeight: "100px", marginTop: "6px", marginBottom: "8px" }}
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              placeholder={
                modalTarget.action === "resume"
                  ? "후속 작업 지시사항을 입력하세요 (완료된 태스크인 경우 후속 태스크가 자동 생성됩니다)"
                  : "커스텀 프롬프트 지시사항 (비워두면 기존 태스크 프롬프트로 실행)"
              }
              autoFocus
            />
            <div className="confirm-actions">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setModalTarget(null);
                  setCustomPrompt("");
                }}
              >
                취소
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={confirmActionModal}
                disabled={
                  modalTarget.action === "resume" &&
                  customPrompt.trim().length === 0
                }
              >
                실행
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
