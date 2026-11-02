// T4.2 — PLAN 보드: KPI 진행률 바 + 작업 카드(Turn/Track/Role/Model/Diff) + 적대적 토론(Debates) + PLAN.md 편집기 + 디스패치
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp, type HarnessId } from "../store";
import * as api from "../api.ts";
import type {
  TaskStatus,
  GetPlanMdResponse,
  PutPlanMdRequest,
  DispatchTasksRequest,
} from "../../shared/protocol.ts";
import {
  PlayIcon,
  RefreshIcon,
  SaveIcon,
  AlertTriangleIcon,
  GitBranchIcon,
} from "./Icons";
import { HARNESS_LABEL } from "./DriverBar.tsx";

const STATUS_ORDER: TaskStatus[] = [
  "running",
  "verifying",
  "merge_conflict",
  "pending",
  "failed",
  "escalated",
  "done",
];

function statusTagClass(status: TaskStatus): string {
  if (status === "done") return "tag ok";
  if (
    status === "failed" ||
    status === "escalated" ||
    status === "merge_conflict"
  ) {
    return "tag asd-tag-err";
  }
  if (status === "running" || status === "verifying") return "tag warn";
  return "tag";
}

function statusLabel(status: TaskStatus): string {
  const map: Record<TaskStatus, string> = {
    pending: "대기",
    running: "실행 중",
    verifying: "검증 대기",
    done: "완료",
    failed: "실패",
    escalated: "에스컬레이션",
    merge_conflict: "병합 충돌",
  };
  return map[status] ?? status;
}

interface ParsedDebateVerdict {
  verdict?: string;
  decisions?: string[];
  hard_constraints?: string[];
  risks?: string[];
  diversity_degraded?: boolean;
}

export default function PlanBoard() {
  const app = useApp();
  const fgId = app.foregroundSessionId;
  const baseSessionId = useMemo(() => {
    if (!fgId) return null;
    const idx = fgId.indexOf("::");
    return idx !== -1 ? fgId.slice(0, idx) : fgId;
  }, [fgId]);
  const projectRoot = app.projectRoot;

  const tasks = useMemo(() => {
    const all = app.snapshot?.allTasks ?? [];
    return all.filter(
      (t) => t.session_id === fgId || t.session_id === baseSessionId,
    );
  }, [app.snapshot?.allTasks, fgId, baseSessionId]);

  const debates = useMemo(() => {
    const all = app.snapshot?.allDebates ?? [];
    return all.filter(
      (d) => d.session_id === fgId || d.session_id === baseSessionId,
    );
  }, [app.snapshot?.allDebates, fgId, baseSessionId]);

  const [planContent, setPlanContent] = useState("");
  const [planVersion, setPlanVersion] = useState<number | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchJobId, setDispatchJobId] = useState<string | null>(null);
  const [showDispatchConfirm, setShowDispatchConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadPlan = useCallback(async () => {
    if (!projectRoot || !baseSessionId) return;
    try {
      const res: GetPlanMdResponse = await api.getPlanMd(projectRoot);
      setPlanContent(res.content);
      setPlanVersion(res.stateVersion);
      setDirty(false);
      setSaveError(null);
    } catch (e) {
      setSaveError(api.errorText(e));
    }
  }, [projectRoot, baseSessionId]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan, app.snapshot?.timestamp]);

  useEffect(() => {
    setDirty(false);
    setSaveError(null);
  }, [fgId]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPlanContent(e.target.value);
    setDirty(true);
    setSaveError(null);
  };

  const handleSave = useCallback(async () => {
    if (!projectRoot || !baseSessionId || planVersion === undefined || !dirty)
      return;
    setSaving(true);
    setSaveError(null);
    try {
      const req: PutPlanMdRequest = {
        projectRoot,
        sessionId: baseSessionId,
        content: planContent,
        baseVersion: planVersion,
      };
      const res = await api.putPlanMd(req);
      setPlanVersion(res.stateVersion);
      setDirty(false);
      await app.refreshSnapshot();
      setSaveError("저장됨");
      setTimeout(() => setSaveError(null), 1500);
    } catch (e) {
      const msg = api.errorText(e);
      setSaveError(msg);
      if (msg.includes("CONFLICT") || msg.includes("state_version")) {
        try {
          const fresh = await api.getPlanMd(projectRoot);
          setPlanContent(fresh.content);
          setPlanVersion(fresh.stateVersion);
          setDirty(false);
          setSaveError("다른 세션이 수정함 — 최신 내용으로 갱신됨");
        } catch {}
      }
    } finally {
      setSaving(false);
    }
  }, [projectRoot, baseSessionId, planVersion, planContent, dirty, app]);

  const confirmDispatch = useCallback(async () => {
    if (!projectRoot || !baseSessionId) return;
    setDispatching(true);
    setShowDispatchConfirm(false);
    try {
      const req: DispatchTasksRequest = {
        projectRoot,
        sessionId: baseSessionId,
      };
      const res = await api.dispatchTasks(req);
      setDispatchJobId(res.jobId);
    } catch (e) {
      setSaveError(api.errorText(e));
    } finally {
      setDispatching(false);
    }
  }, [projectRoot, baseSessionId]);

  if (!projectRoot || !fgId) {
    return (
      <div className="thread empty asd-fill">
        <div className="welcome">
          <div className="orb-anchor" data-orb-anchor aria-hidden />
          <h1>PLAN 보드</h1>
          <p className="welcome-sub">프로젝트를 열고 전경 세션을 선택하세요</p>
        </div>
      </div>
    );
  }

  const doneCount = tasks.filter((t) => t.status === "done").length;
  const totalCount = tasks.length;
  const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

  const grouped = STATUS_ORDER.map((status) => ({
    status,
    tasks: tasks.filter((t) => t.status === status),
  })).filter((g) => g.tasks.length > 0);

  return (
    <div className="asd-planboard">
      {/* KPI 진행 현황 요약 카드 (asd ui 진행률 바) */}
      <section className="card asd-kpi-card">
        <div className="asd-info-head" style={{ justifyContent: "space-between" }}>
          <div className="row" style={{ gap: 10 }}>
            <b>📊 태스크 진행 현황</b>
            <span className="tag ok">
              완료 {doneCount} / {totalCount} ({pct}%)
            </span>
            {debates.length > 0 && (
              <span className="tag accent">적대적 토론 {debates.length}건</span>
            )}
          </div>
          <div className="row" style={{ gap: 6 }}>
            {app.selectedTaskId && (
              <button
                type="button"
                className="btn xs ghost"
                onClick={() => app.setSelectedTaskId(null)}
              >
                선택 필터 해제 ({app.selectedTaskId})
              </button>
            )}
            <button
              type="button"
              className="btn sm primary"
              disabled={dispatching || tasks.length === 0}
              onClick={() => setShowDispatchConfirm(true)}
            >
              <PlayIcon /> {dispatching ? "디스패치 중…" : "태스크 디스패치"}
            </button>
          </div>
        </div>
        <div className="asd-progress-track" aria-label={`진행률 ${pct}%`}>
          <div className="asd-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </section>

      {/* 작업 카드 목록 */}
      <section className="card asd-task-board">
        <header className="card-ask">
          <div className="ask-text">작업 목록 — 전체 {tasks.length}개</div>
          <div className="ask-tags">
            {STATUS_ORDER.map((s) => {
              const n = tasks.filter((t) => t.status === s).length;
              return n > 0 ? (
                <span key={s} className={statusTagClass(s)}>
                  {statusLabel(s)} {n}
                </span>
              ) : null;
            })}
          </div>
        </header>
        <div className="card-body asd-task-groups">
          {grouped.length === 0 ? (
            <p className="asd-dim" style={{ textAlign: "center", padding: "24px 0" }}>
              등록된 태스크가 없습니다 — 아래 PLAN.md 편집기에서 작성 후 저장하거나 대화 탭에서 계획 작성을 지시하세요
            </p>
          ) : (
            grouped.map((g) => (
              <div key={g.status} className="asd-task-group">
                <div className="asd-task-group-head">
                  <span className={statusTagClass(g.status)}>
                    {statusLabel(g.status)}
                  </span>
                  <span className="asd-dim">{g.tasks.length}개</span>
                </div>
                <div className="asd-task-cards">
                  {g.tasks.map((t) => {
                    const isSelected = app.selectedTaskId === t.task_id;
                    const hLabel = t.assigned_harness
                      ? (HARNESS_LABEL[t.assigned_harness as HarnessId] ??
                        t.assigned_harness)
                      : null;
                    return (
                      <div
                        key={t.task_id}
                        className={`asd-task-card ${isSelected ? "selected" : ""}`}
                        onClick={() => app.setSelectedTaskId(t.task_id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            app.setSelectedTaskId(t.task_id);
                          }
                        }}
                        title={`태스크 ${t.task_id} — 클릭하면 오른쪽 인스펙터에서 상세 및 서브에이전트 로그 보기`}
                      >
                        <code className="asd-task-id">{t.task_id}</code>
                        <span className="tag" style={{ fontSize: 10.5 }}>
                          Turn {t.turn} · {t.track}
                        </span>
                        <span className="tag" style={{ fontSize: 10.5 }}>
                          {t.role}
                        </span>
                        {t.follow_up_of && (
                          <span className="tag accent" style={{ fontSize: 10.5 }}>
                            ↪ {t.follow_up_of}
                          </span>
                        )}
                        <span className="asd-task-title">{t.title}</span>
                        {hLabel && (
                          <code className="asd-dim" style={{ fontSize: 11 }}>
                            {hLabel}
                            {t.assigned_model ? `/${t.assigned_model}` : ""}
                          </code>
                        )}
                        {(t.status === "verifying" ||
                          t.status === "merge_conflict" ||
                          t.worktree_path) && (
                          <button
                            type="button"
                            className="btn xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              app.openDiff(t.task_id);
                            }}
                          >
                            <GitBranchIcon /> Diff·검증
                          </button>
                        )}
                        <span className={`asd-task-status ${statusTagClass(t.status)}`}>
                          {statusLabel(t.status)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
        {dispatchJobId && (
          <footer className="card-foot">
            <span className="asd-dim" style={{ fontFamily: "var(--mono)", fontSize: 12 }}>
              최근 디스패치 Job: {dispatchJobId}
            </span>
          </footer>
        )}
      </section>

      {/* 적대적 토론 (Adversarial Debates) 섹션 (asd ui 포트) */}
      {debates.length > 0 && (
        <section className="card asd-debates-board">
          <header className="card-ask">
            <div className="ask-text">⚔️ 적대적 토론 (Adversarial Debates) — {debates.length}건</div>
          </header>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {debates.map((d) => {
              let parsed: ParsedDebateVerdict | null = null;
              if (d.insight_verdict_json) {
                try {
                  parsed = JSON.parse(d.insight_verdict_json) as ParsedDebateVerdict;
                } catch {
                  parsed = null;
                }
              }
              const verdict = parsed?.verdict ?? d.status.toUpperCase();
              const verdictClass =
                verdict === "APPROVE"
                  ? "tag ok"
                  : verdict === "REVISE"
                    ? "tag asd-tag-err"
                    : "tag warn";
              const isSelected = app.selectedTaskId === d.debate_id;

              return (
                <div
                  key={d.debate_id}
                  className={`asd-debate-card ${isSelected ? "selected" : ""}`}
                  onClick={() => app.setSelectedTaskId(d.debate_id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="asd-info-head" style={{ justifyContent: "space-between" }}>
                    <div className="row" style={{ gap: 8 }}>
                      <code>{d.debate_id}</code>
                      {d.task_id && <span className="tag">태스크: {d.task_id}</span>}
                      <b>{d.topic}</b>
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      {parsed?.diversity_degraded && (
                        <span className="tag warn">단일 계열 주의</span>
                      )}
                      <span className={verdictClass}>{verdict}</span>
                    </div>
                  </div>
                  {parsed && (
                    <div className="asd-debate-details">
                      {Array.isArray(parsed.decisions) && parsed.decisions.length > 0 && (
                        <div>
                          <b className="asd-dim">합의 결정:</b>{" "}
                          {parsed.decisions.join(" · ")}
                        </div>
                      )}
                      {Array.isArray(parsed.hard_constraints) &&
                        parsed.hard_constraints.length > 0 && (
                          <div>
                            <b className="asd-dim">필수 제약:</b>{" "}
                            {parsed.hard_constraints.join(" · ")}
                          </div>
                        )}
                      {Array.isArray(parsed.risks) && parsed.risks.length > 0 && (
                        <div>
                          <b className="asd-dim">리스크:</b> {parsed.risks.join(" · ")}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* PLAN.md 에디터 */}
      <section className="card asd-plan-editor">
        <header className="card-ask">
          <div className="ask-text">
            PLAN.md 편집기 — {planVersion !== undefined ? `v${planVersion}` : "동기화 대기"}
          </div>
          <div className="ask-tags">
            <span className={dirty ? "tag warn" : "tag ok"}>
              {dirty ? "미저장" : "동기화됨"}
            </span>
          </div>
        </header>
        <div className="card-body">
          <textarea
            ref={textareaRef}
            className="asd-plan-textarea"
            value={planContent}
            onChange={handleChange}
            placeholder="PLAN.md가 비어 있습니다 — 마크다운 태스크 계획을 작성하고 저장하세요"
            aria-label="PLAN.md 편집기"
            spellCheck={false}
          />
          {saveError && (
            <div className={`asd-plan-status ${saveError === "저장됨" ? "ok" : "err"}`}>
              {saveError}
            </div>
          )}
        </div>
        <footer className="card-foot">
          <div className="details">
            <button
              type="button"
              className="btn primary"
              disabled={saving || !dirty}
              onClick={() => void handleSave()}
            >
              <SaveIcon /> {saving ? "저장 중…" : "PLAN.md 저장"}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={saving}
              onClick={() => {
                void loadPlan();
                void app.refreshSnapshot();
              }}
            >
              <RefreshIcon /> 새로고침
            </button>
          </div>
        </footer>
      </section>

      {/* 디스패치 확인 모달 */}
      {showDispatchConfirm && (
        <div className="modal-back" onClick={() => setShowDispatchConfirm(false)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-icon">
              <AlertTriangleIcon />
            </div>
            <h2>태스크 디스패치</h2>
            <p>
              전경 세션(<code>{baseSessionId}</code>)의 대기 태스크를 서브에이전트로 병렬 디스패치합니다.
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setShowDispatchConfirm(false)}
              >
                취소
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => void confirmDispatch()}
                disabled={dispatching}
              >
                {dispatching ? "실행 중…" : "디스패치 실행"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
