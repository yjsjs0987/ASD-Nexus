// T4.2 — PLAN 보드: PLAN.md 원문 조회/편집/저장, 작업 카드(상태별 색 태그), 디스패치 버튼.
// 작업 카드 클릭 → store.selectedTaskId 갱신 → SubagentInspector 연동.
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../store";
import * as api from "../api.ts";
import type { TaskStatus, GetPlanMdResponse, PutPlanMdRequest, DispatchTasksRequest } from "../../shared/protocol.ts";
import { ChevronIcon, PlayIcon, RefreshIcon, SaveIcon, AlertTriangleIcon } from "./Icons";

const STATUS_ORDER: TaskStatus[] = ["pending", "running", "verifying", "done", "failed", "merge_conflict"];

function statusTagClass(status: TaskStatus): string {
  if (status === "done") return "tag ok";
  if (status === "failed" || status === "merge_conflict") return "tag asd-tag-err";
  if (status === "running" || status === "verifying") return "tag warn";
  return "tag";
}

function statusLabel(status: TaskStatus): string {
  const map: Record<TaskStatus, string> = {
    pending: "대기",
    running: "실행",
    verifying: "검증",
    done: "완료",
    failed: "실패",
    merge_conflict: "충돌",
  };
  return map[status];
}

export default function PlanBoard() {
  const app = useApp();
  const fgId = app.foregroundSessionId;
  const projectRoot = app.projectRoot;
  const tasks = app.snapshot?.allTasks?.filter((t) => t.session_id === fgId) ?? [];

  // PLAN.md 편집 상태
  const [planContent, setPlanContent] = useState("");
  const [planVersion, setPlanVersion] = useState<number | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchJobId, setDispatchJobId] = useState<string | null>(null);
  const [showDispatchConfirm, setShowDispatchConfirm] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 초기 로드: 전경 세션이 있고 프로젝트가 열려 있을 때
  useEffect(() => {
    if (!projectRoot || !fgId) return;
    let cancelled = false;
    api.getPlanMd(projectRoot).then((res: GetPlanMdResponse) => {
      if (cancelled) return;
      setPlanContent(res.content);
      setPlanVersion(res.stateVersion);
      setDirty(false);
      setSaveError(null);
    }).catch((e) => {
      if (cancelled) return;
      setSaveError(api.errorText(e));
    });
    return () => { cancelled = true; };
  }, [projectRoot, fgId]);

  // 전경 세션이 바뀌면 에디터 리셋
  useEffect(() => {
    setPlanContent("");
    setPlanVersion(undefined);
    setDirty(false);
    setSaveError(null);
  }, [fgId]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPlanContent(e.target.value);
    setDirty(true);
    setSaveError(null);
  };

  const handleSave = useCallback(async () => {
    if (!projectRoot || !fgId || planVersion === undefined || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const req: PutPlanMdRequest = {
        projectRoot,
        sessionId: fgId,
        content: planContent,
        baseVersion: planVersion,
      };
      const res = await api.putPlanMd(req);
      setPlanVersion(res.stateVersion);
      setDirty(false);
      // 성공 토스트는 store의 error로 올리지 않고 로컬 상태로만
      setTimeout(() => setSaveError("저장됨"), 0);
      setTimeout(() => setSaveError(null), 1500);
    } catch (e) {
      const msg = api.errorText(e);
      setSaveError(msg);
      // CONFLICT(409)면 최신 버전으로 다시 GET
      if (msg.includes("CONFLICT") || msg.includes("state_version 불일치")) {
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
  }, [projectRoot, fgId, planVersion, planContent, dirty]);

  const handleDispatch = useCallback(async () => {
    if (!projectRoot || !fgId || dispatching) return;
    setShowDispatchConfirm(true);
  }, [projectRoot, fgId, dispatching]);

  const confirmDispatch = useCallback(async () => {
    if (!projectRoot || !fgId) return;
    setDispatching(true);
    setShowDispatchConfirm(false);
    try {
      const req: DispatchTasksRequest = { projectRoot, sessionId: fgId };
      const res = await api.dispatchTasks(req);
      setDispatchJobId(res.jobId);
      // job 이벤트는 Thread가 표시
    } catch (e) {
      setSaveError(api.errorText(e));
    } finally {
      setDispatching(false);
    }
  }, [projectRoot, fgId]);

  // 작업 카드 클릭 → store.selectedTaskId 설정
  const selectTask = useCallback((taskId: string) => {
    app.setSelectedTaskId(taskId);
  }, [app]);

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

  // 상태별 그룹핑
  const grouped = STATUS_ORDER.map((status) => ({
    status,
    tasks: tasks.filter((t) => t.status === status),
  })).filter((g) => g.tasks.length > 0);

  return (
    <div className="asd-planboard">
      {/* PLAN.md 에디터 */}
      <section className="card asd-plan-editor">
        <header className="card-ask">
          <div className="ask-text">PLAN.md — {planVersion !== undefined ? `v${planVersion}` : "새 파일"}</div>
          <div className="ask-tags">
            <span className={dirty ? "tag warn" : "tag ok"}>{dirty ? "미저장" : "동기화됨"}</span>
          </div>
        </header>
        <div className="card-body">
          <textarea
            ref={textareaRef}
            className="asd-plan-textarea"
            value={planContent}
            onChange={handleChange}
            placeholder="PLAN.md가 비어 있습니다 — 내용을 작성하고 저장하세요"
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
            <button className="btn primary" disabled={saving || !dirty} onClick={handleSave}>
              <SaveIcon /> {saving ? "저장 중…" : "저장"}
            </button>
            <button className="btn sm" disabled={saving} onClick={() => window.location.reload()}>
              <RefreshIcon /> 새로고침
            </button>
          </div>
        </footer>
      </section>

      {/* 작업 카드 목록 */}
      <section className="card asd-task-board">
        <header className="card-ask">
          <div className="ask-text">작업 목록 — 전체 {tasks.length}개</div>
          <div className="ask-tags">
            {STATUS_ORDER.map((s) => {
              const n = tasks.filter((t) => t.status === s).length;
              return n > 0 ? <span key={s} className={statusTagClass(s)}>{statusLabel(s)} {n}</span> : null;
            })}
          </div>
        </header>
        <div className="card-body asd-task-groups">
          {grouped.length === 0 ? (
            <p className="asd-dim" style={{ textAlign: "center", padding: "24px 0" }}>태스크가 없습니다 — PLAN.md를 작성하고 저장하면 태스크가 생성됩니다</p>
          ) : (
            grouped.map((g) => (
              <div key={g.status} className="asd-task-group">
                <div className="asd-task-group-head">
                  <span className={statusTagClass(g.status)}>{statusLabel(g.status)}</span>
                  <span className="asd-dim">{g.tasks.length}개</span>
                </div>
                <div className="asd-task-cards">
                  {g.tasks.map((t) => (
                    <button
                      key={t.task_id}
                      className={`asd-task-card ${app.selectedTaskId === t.task_id ? "selected" : ""}`}
                      onClick={() => selectTask(t.task_id)}
                      title={`태스크 ${t.task_id} — 클릭하면 인스펙터에서 상세 보기`}
                    >
                      <code className="asd-task-id">{t.task_id}</code>
                      {t.title && <span className="asd-task-title">{t.title}</span>}
                      <span className={`asd-task-status ${statusTagClass(t.status)}`}>{statusLabel(t.status)}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
        <footer className="card-foot">
          <div className="details">
            <button className="btn primary" disabled={dispatching} onClick={handleDispatch}>
              <PlayIcon /> {dispatching ? "디스패치 중…" : "디스패치"}
            </button>
            {dispatchJobId && (
              <span className="asd-dim" style={{ fontFamily: "var(--mono)", fontSize: "12px" }}>
                job: {dispatchJobId}
              </span>
            )}
          </div>
        </footer>
      </section>

      {/* 디스패치 확인 모달 */}
      {showDispatchConfirm && (
        <div className="modal-back" onClick={() => setShowDispatchConfirm(false)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-icon"><AlertTriangleIcon /></div>
            <h2>태스크 디스패치</h2>
            <p>전경 세션(<code>{fgId}</code>)의 대기/실행 태스크를 워크트리에 디스패치합니다.</p>
            <p className="asd-dim">job_started / job_progress / job_finished 이벤트는 대화 탭(Thread)에서 확인하세요.</p>
            <div className="confirm-actions">
              <button className="btn" onClick={() => setShowDispatchConfirm(false)}>취소</button>
              <button className="btn danger solid" onClick={confirmDispatch} disabled={dispatching}>
                {dispatching ? "실행 중…" : "디스패치 실행"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}