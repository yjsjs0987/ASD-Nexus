// T3.1 — Elysium App.tsx의 레이어 구조(입자 배경 → 도크 · 세션 레일 · 본문 · 확인 창)를
// ASD 멀티에이전트 콘솔로 완성한다. 3컬럼 폭은 styles.css의 .app grid-template-columns가
// 명시적으로 잡는다(84px | 1fr | 84px — 구버전 결함 1 재발 방지). 중앙 패널 본문과
// 오른쪽 인스펙터 내용은 T4.x/T5.1이 채운다.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useApp, type HarnessId, type SessionRow } from "./store";
import SessionPanel, { Dock } from "./components/SessionRail";
import ParticleOrb from "./components/ParticleOrb";
import Segmented from "./components/Segmented";
import ConfirmDialog from "./components/ConfirmDialog";
import { GlassDefs, useGlassLight, useLiquidRefraction } from "./lib/glass";
import { baseName } from "./api.ts";
import { FolderIcon, InfoIcon } from "./components/Icons";

const PANEL_WIDE = 1560;

type CenterTab = "chat" | "plan" | "routing";

const HARNESS_ALL: HarnessId[] = ["claude-code", "opencode", "codex", "antigravity", "cursor"];
const HARNESS_LABEL: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
};
/** 첫 화면 프로젝트 카드의 색 캡슐(Elysium 톤 순환) */
const TONES = ["tone-salmon", "tone-aqua", "tone-blush", "tone-rose"];

function statusTagClass(status: string): string {
  if (status === "done") return "tag ok";
  if (status === "failed" || status === "merge_conflict") return "tag asd-tag-err";
  if (status === "running" || status === "verifying" || status === "escalated") return "tag warn";
  return "tag";
}

export default function App() {
  const app = useApp();
  useGlassLight();
  useLiquidRefraction();
  const [panel, setPanel] = useState(() => window.innerWidth >= PANEL_WIDE);
  const togglePanel = useCallback(() => setPanel((p) => !p), []);
  const [tab, setTab] = useState<CenterTab>("chat");

  // 도크 툴팁이 약속하는 Ctrl+N → 새 세션 화면
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        app.openSession(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [app.openSession]);

  // 전경 세션 행(서버 스냅샷에서만 찾는다 — 로컬 선택 상태 없음)
  const fg = useMemo(
    () => app.snapshot?.sessions.find((s) => s.session_id === app.foregroundSessionId) ?? null,
    [app.snapshot, app.foregroundSessionId],
  );

  const orbMode = app.error ? "error" : app.busySessions.length > 0 ? "thinking" : "idle";
  const welcomeMode =
    app.projectRoot == null ? "projects" : app.newSessionMode ? "new" : fg == null ? "empty" : null;

  return (
    <div className="app">
      <GlassDefs />
      <ParticleOrb mode={orbMode} />
      <Dock panelOpen={panel} onTogglePanel={togglePanel} />
      <SessionPanel open={panel} onPicked={() => window.innerWidth < PANEL_WIDE && setPanel(false)} />
      <main className="main">
        {welcomeMode ? (
          <Welcome mode={welcomeMode} />
        ) : (
          fg && (
            <>
              <SessionHead fg={fg} />
              <CenterPanel fg={fg} tab={tab} onTab={setTab} />
            </>
          )
        )}
      </main>
      {/* 오른쪽 인스펙터 자리(임시) — T4.x가 SubagentInspector를 얹는다 */}
      <nav className="dock tools-dock" aria-label="인스펙터 (준비 중)">
        <button className="dock-btn" disabled aria-label="인스펙터 — T4.x에서 연결됩니다">
          <InfoIcon />
        </button>
      </nav>
      {app.error && (
        <div className="toasts">
          <div className="toast error" role="alert">
            {app.error}
            <button className="pill-x" onClick={app.clearError} aria-label="알림 닫기">
              ×
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog />
    </div>
  );
}

// ── 첫 화면(환영): 프로젝트 선택 / 새 세션 / 빈 상태 ──

function Welcome({ mode }: { mode: "projects" | "new" | "empty" }) {
  if (mode === "projects") return <ProjectPicker />;
  if (mode === "new") return <NewSessionForm />;
  return <EmptyState />;
}

/** 프로젝트 목록 조회 → 선택(api.openProject). 폴더 입력은 T5.1까지의 임시 통로. */
function ProjectPicker() {
  const app = useApp();
  const [path, setPath] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (p) void app.openProject(p);
  };
  return (
    <div className="thread empty asd-fill">
      <div className="welcome">
        <div className="orb-anchor" data-orb-anchor aria-hidden />
        <h1>
          ASD <em>콘솔</em>
        </h1>
        <p className="welcome-sub">
          {app.loading
            ? "프로젝트를 여는 중…"
            : app.projects.length > 0
              ? "작업할 프로젝트를 선택하세요"
              : "아직 열었던 프로젝트가 없습니다 — 폴더 경로로 시작하세요"}
        </p>
        {app.projects.length > 0 && (
          <div className="welcome-cards">
            {app.projects.map((p, i) => (
              <button
                key={p.projectHash}
                className={TONES[i % TONES.length]}
                disabled={app.loading}
                onClick={() => void app.openProject(p.projectRoot)}
              >
                <b>{baseName(p.projectRoot)}</b>
                <span title={p.projectRoot}>{p.projectRoot}</span>
                <span>세션 {p.sessionCount}개</span>
              </button>
            ))}
          </div>
        )}
        <form className="asd-form" onSubmit={submit}>
          <div className="row">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="프로젝트 폴더 경로 (예: C:\Users\me\Projects\my-app)"
              aria-label="프로젝트 폴더 경로"
            />
            <button type="submit" className="btn primary" disabled={app.loading || !path.trim()}>
              폴더 열기
            </button>
          </div>
          <p className="asd-dim">폴더 선택 대화상자는 T5.1에서 연결됩니다 — 지금은 경로를 직접 입력하세요.</p>
        </form>
      </div>
    </div>
  );
}

/** 새 세션 만들기(api.createSession, makeForeground=true) */
function NewSessionForm() {
  const app = useApp();
  const [memo, setMemo] = useState("");
  const harnessOptions = useMemo(() => {
    const h = app.snapshot?.harnesses;
    if (!h) return HARNESS_ALL;
    const installed = HARNESS_ALL.filter((k) => h[k]?.installed);
    return installed.length > 0 ? installed : HARNESS_ALL;
  }, [app.snapshot]);
  const [harness, setHarness] = useState<HarnessId>("claude-code");
  useEffect(() => {
    if (!harnessOptions.includes(harness)) setHarness(harnessOptions[0]);
  }, [harnessOptions, harness]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void app.createSession({ harness, memo: memo.trim() || undefined });
  };
  return (
    <div className="thread empty asd-fill">
      <div className="welcome">
        <div className="orb-anchor" data-orb-anchor aria-hidden />
        <h1>새 세션</h1>
        <p className="welcome-sub">
          <b>{app.projectRoot ? baseName(app.projectRoot) : ""}</b>에서 새 ASD 세션을 만듭니다
        </p>
        <form className="asd-form" onSubmit={submit}>
          <div className="row">
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="세션 메모 — 작업 주제 한 줄"
              aria-label="세션 메모"
            />
            <select
              className="asd-select"
              value={harness}
              onChange={(e) => setHarness(e.target.value as HarnessId)}
              aria-label="드라이버 하네스"
            >
              {harnessOptions.map((h) => (
                <option key={h} value={h}>
                  {HARNESS_LABEL[h]}
                </option>
              ))}
            </select>
            <button type="submit" className="btn primary" disabled={app.loading}>
              세션 생성
            </button>
          </div>
          <p className="asd-dim">새 세션은 자동으로 전경(PLAN.md 표시)이 됩니다.</p>
        </form>
        <div className="asd-actions">
          <button className="link" onClick={() => app.showProjectPicker()}>
            다른 프로젝트 열기
          </button>
        </div>
      </div>
    </div>
  );
}

/** 프로젝트는 열렸지만 전경 세션이 없을 때 */
function EmptyState() {
  const app = useApp();
  return (
    <div className="thread empty asd-fill">
      <div className="welcome">
        <div className="orb-anchor" data-orb-anchor aria-hidden />
        <h1>세션을 선택하세요</h1>
        <p className="welcome-sub">왼쪽 세션 목록에서 세션을 고르거나 새 세션을 만드세요</p>
        <div className="asd-actions">
          <button className="btn primary" onClick={() => app.openSession(null)}>
            새 세션 만들기
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 세션 화면: 머리 + 중앙 패널(탭 자리) ──

function SessionHead({ fg }: { fg: SessionRow }) {
  const app = useApp();
  const busy = app.busySessions.includes(fg.session_id);
  const phaseAction =
    fg.phase === "paused"
      ? ({ label: "재개", next: "running" } as const)
      : fg.phase === "done"
        ? null
        : ({ label: "일시정지", next: "paused" } as const);
  return (
    <header className="session-head">
      <span className="head-orb" data-orb-anchor="mini" aria-hidden />
      <span className="head-title">
        <span className={`head-dot ${busy ? "busy" : ""}`} aria-hidden />
        {fg.memo?.trim() || fg.session_id}
      </span>
      <span className="head-folder" title={fg.project_root}>
        <FolderIcon /> {baseName(fg.project_root)}
      </span>
      <span className="tag">{fg.phase}</span>
      <span className="spacer" />
      {phaseAction && (
        <button className="btn sm" onClick={() => void app.setPhase(fg.session_id, phaseAction.next)}>
          {phaseAction.label}
        </button>
      )}
    </header>
  );
}

/** 중앙 패널: Segmented 탭 자리(대화/PLAN/Routing) + 전경 세션 정보 · PLAN 요약 플레이스홀더.
 *  실제 대화 뷰·PLAN 보드·라우팅 편집기는 T4.x/T5.1이 탭 내용을 채운다. */
function CenterPanel({ fg, tab, onTab }: { fg: SessionRow; tab: CenterTab; onTab: (t: CenterTab) => void }) {
  const app = useApp();
  const tasks = useMemo(
    () => (app.snapshot?.allTasks ?? []).filter((t) => t.session_id === fg.session_id),
    [app.snapshot, fg.session_id],
  );
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) m.set(t.status, (m.get(t.status) ?? 0) + 1);
    return [...m.entries()];
  }, [tasks]);
  return (
    <div className="asd-center">
      <Segmented
        as="tab"
        label="중앙 패널 보기"
        value={tab}
        onChange={onTab}
        options={[
          { value: "chat", label: "대화" },
          { value: "plan", label: "PLAN" },
          { value: "routing", label: "Routing" },
        ]}
      />
      <div className="asd-center-body">
        <section className="card asd-info">
          <div className="asd-info-head">
            <code>{fg.session_id}</code>
            <span className="tag">{fg.phase}</span>
            <span className="tag">{HARNESS_LABEL[fg.main_harness as HarnessId] ?? fg.main_harness}</span>
          </div>
          <MemoRow fg={fg} />
        </section>
        {tab === "chat" && (
          <section className="card asd-placeholder">
            <p className="asd-dim">대화 뷰 — 드라이버 트랜스크립트와 실시간 출력은 T4.x에서 연결됩니다.</p>
          </section>
        )}
        {tab === "plan" && (
          <section className="card asd-placeholder">
            <b>PLAN 요약</b>
            <div className="asd-info-head">
              <span className="tag">전체 {tasks.length}</span>
              {counts.map(([status, n]) => (
                <span key={status} className={statusTagClass(status)}>
                  {status} {n}
                </span>
              ))}
            </div>
            {tasks.length === 0 && (
              <p className="asd-dim">아직 태스크가 없습니다 — PLAN.md 편집기와 디스패치는 T4.x에서 연결됩니다.</p>
            )}
          </section>
        )}
        {tab === "routing" && (
          <section className="card asd-placeholder">
            <p className="asd-dim">라우팅 편집기(routing.jsonc)는 T5.x에서 연결됩니다.</p>
          </section>
        )}
      </div>
    </div>
  );
}

/** 메모 저장(api.saveSessionMemo) — 저장 확정은 state_updated가 가져온다 */
function MemoRow({ fg }: { fg: SessionRow }) {
  const app = useApp();
  const [draft, setDraft] = useState(fg.memo ?? "");
  useEffect(() => {
    setDraft(fg.memo ?? "");
  }, [fg.session_id, fg.memo]);
  const dirty = draft !== (fg.memo ?? "");
  return (
    <div className="row">
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="세션 메모"
        aria-label="세션 메모"
      />
      <button className="btn sm" disabled={!dirty} onClick={() => void app.saveMemo(fg.session_id, draft)}>
        메모 저장
      </button>
    </div>
  );
}
