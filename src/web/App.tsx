// T3.1 / T4.x / T5.1 — Elysium App.tsx의 레이어 구조(입자 배경 → 도크 · 세션 레일 · 본문 · 오른쪽 인스펙터 · 모달)를
// ASD 멀티에이전트 콘솔로 완성한다. 3컬럼 폭은 styles.css의 .app grid-template-columns가
// 명시적으로 잡는다(84px | minmax(0, 1fr) | 84px — 구버전 결함 1 재발 방지).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { useApp, type HarnessId, type SessionRow } from "./store";
import SessionPanel, { Dock } from "./components/SessionRail";
import ParticleOrb from "./components/ParticleOrb";
import Segmented from "./components/Segmented";
import ConfirmDialog from "./components/ConfirmDialog";
import Thread from "./components/Thread";
import Composer from "./components/Composer";
import PlanBoard from "./components/PlanBoard";
import SubagentInspector from "./components/SubagentInspector";
import TerminalPane, { type TerminalPaneHandle } from "./components/TerminalPane";
import WorktreeDiffModal from "./components/WorktreeDiffModal";
import RoutingConfigPanel from "./components/RoutingConfigPanel";
import DriverBar from "./components/DriverBar";
import { GlassDefs, useGlassLight, useLiquidRefraction } from "./lib/glass";
import * as api from "./api.ts";
import { baseName } from "./api.ts";
import { AgentsIcon, FolderIcon, InfoIcon, ListIcon, TerminalIcon } from "./components/Icons";

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

export default function App() {
  const app = useApp();
  useGlassLight();
  useLiquidRefraction();
  const [panel, setPanel] = useState(() => window.innerWidth >= PANEL_WIDE);
  const togglePanel = useCallback(() => setPanel((p) => !p), []);
  const [inspectorOpen, setInspectorOpen] = useState(() => window.innerWidth >= PANEL_WIDE);
  const toggleInspector = useCallback(() => setInspectorOpen((p) => !p), []);
  const [tab, setTab] = useState<CenterTab>("chat");
  const terminalRef = useRef<TerminalPaneHandle | null>(null);

  // 스토어의 openTerminalTab 요청을 TerminalPane ref로 연결
  useEffect(() => {
    app.registerTerminalOpener((params) => {
      terminalRef.current?.openTab(params);
    });
    return () => app.registerTerminalOpener(null);
  }, [app.registerTerminalOpener]);

  // 작업 카드 클릭(selectedTaskId 변경) 시 오른쪽 인스펙터 자동 오픈 (구버전 결함 5 방지)
  useEffect(() => {
    if (app.selectedTaskId) {
      setInspectorOpen(true);
    }
  }, [app.selectedTaskId]);

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

  const subagentCount = useMemo(() => {
    if (!fg || !app.snapshot?.subagentLogs) return 0;
    return app.snapshot.subagentLogs.filter((l) => l.sessionId === fg.session_id).length;
  }, [fg, app.snapshot]);

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
              <SessionHead
                fg={fg}
                inspectorOpen={inspectorOpen}
                onToggleInspector={toggleInspector}
              />
              <CenterPanel fg={fg} tab={tab} onTab={setTab} terminalRef={terminalRef} />
              <div className="asd-composer-row">
                <Composer />
              </div>
            </>
          )
        )}
      </main>

      {/* 오른쪽 도크 + 서브에이전트 인스펙터 패널 */}
      <nav className="dock tools-dock" aria-label="인스펙터 및 도구">
        <button
          type="button"
          className={`dock-btn ${inspectorOpen ? "on" : ""}`}
          onClick={toggleInspector}
          data-tip="서브에이전트 인스펙터"
          aria-label="서브에이전트 인스펙터 토글"
          aria-expanded={inspectorOpen}
        >
          <AgentsIcon />
          {subagentCount > 0 && <span className="dock-count">{subagentCount}</span>}
        </button>
        <button
          type="button"
          className={`dock-btn ${app.showWorktreeDiff ? "on" : ""}`}
          disabled={!fg}
          onClick={() => app.openDiff(app.selectedTaskId ?? undefined)}
          data-tip="워크트리 Diff"
          aria-label="워크트리 Diff 모달 열기"
        >
          <ListIcon />
        </button>
        <button
          type="button"
          className="dock-btn"
          disabled={!app.projectRoot}
          onClick={() =>
            app.openTerminalTab({
              title: "새 터미널",
              cwd: app.projectRoot ?? undefined,
            })
          }
          data-tip="터미널 열기"
          aria-label="새 터미널 탭 열기"
        >
          <TerminalIcon />
        </button>
        <div className="dock-gap" />
        <button
          type="button"
          className="dock-btn"
          onClick={toggleInspector}
          data-tip={inspectorOpen ? "인스펙터 접기" : "인스펙터 열기"}
          aria-label="인스펙터 상태"
        >
          <InfoIcon />
        </button>
      </nav>

      <aside className={`tools-panel ${inspectorOpen && fg ? "open" : ""}`} aria-label="서브에이전트 인스펙터">
        <SubagentInspector />
      </aside>

      <WorktreeDiffModal />

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

/** 프로젝트 목록 조회 → 선택(api.openProject) + 서버 폴더 탐색기(api.browseDirs) */
function ProjectPicker() {
  const app = useApp();
  const [path, setPath] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [browseData, setBrowseData] = useState<api.BrowseDirsResponse | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (p) void app.openProject(p);
  };

  const loadDir = async (dir?: string) => {
    try {
      const res = await api.browseDirs(dir);
      setBrowseData(res);
      setPath(res.currentDir);
      setBrowsing(true);
    } catch (e) {
      app.reportError(api.errorText(e));
    }
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
            <button
              type="button"
              className="btn"
              disabled={app.loading}
              onClick={() => void loadDir(path.trim() || undefined)}
            >
              <FolderIcon /> 폴더 찾아보기
            </button>
            <button type="submit" className="btn primary" disabled={app.loading || !path.trim()}>
              폴더 열기
            </button>
          </div>
          {browsing && browseData && (
            <div className="card asd-dir-browser">
              <div className="asd-info-head" style={{ justifyContent: "space-between" }}>
                <code>{browseData.currentDir}</code>
                <div className="row" style={{ gap: 6 }}>
                  {browseData.isGitRepo && <span className="tag ok">Git 저장소</span>}
                  {browseData.parentDir && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => void loadDir(browseData.parentDir!)}
                    >
                      상위 폴더
                    </button>
                  )}
                  <button type="button" className="btn sm ghost" onClick={() => setBrowsing(false)}>
                    닫기
                  </button>
                </div>
              </div>
              <div className="asd-dir-list">
                {browseData.directories.map((d) => {
                  const sep = browseData.currentDir.includes("\\") ? "\\" : "/";
                  const nextPath = `${browseData.currentDir.replace(/[\\/]+$/, "")}${sep}${d}`;
                  return (
                    <button
                      key={d}
                      type="button"
                      className="asd-dir-item"
                      onClick={() => void loadDir(nextPath)}
                    >
                      <FolderIcon /> {d}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
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

// ── 세션 화면: 머리 + 중앙 패널(대화 / PLAN / Routing + 터미널) ──

function SessionHead({
  fg,
  inspectorOpen,
  onToggleInspector,
}: {
  fg: SessionRow;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
}) {
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
      {app.selectedTaskId && (
        <button
          type="button"
          className="btn sm"
          onClick={() => app.openDiff(app.selectedTaskId ?? undefined)}
          title="선택된 태스크의 워크트리 Diff 열기"
        >
          Diff: {app.selectedTaskId}
        </button>
      )}
      <span className="spacer" />
      <button
        type="button"
        className="btn sm"
        onClick={() => app.openDiff(app.selectedTaskId ?? undefined)}
      >
        Diff 보기
      </button>
      <button
        type="button"
        className="btn sm"
        onClick={() =>
          app.openTerminalTab({
            title: "새 터미널",
            cwd: fg.project_root,
          })
        }
      >
        <TerminalIcon /> 터미널
      </button>
      <button type="button" className="btn sm" onClick={onToggleInspector}>
        {inspectorOpen ? "인스펙터 닫기" : "인스펙터 열기"}
      </button>
      {phaseAction && (
        <button className="btn sm" onClick={() => void app.setPhase(fg.session_id, phaseAction.next)}>
          {phaseAction.label}
        </button>
      )}
    </header>
  );
}

/** 중앙 패널: Segmented 탭(대화/PLAN/Routing) + DriverBar + 탭 본문 + TerminalPane */
function CenterPanel({
  fg,
  tab,
  onTab,
  terminalRef,
}: {
  fg: SessionRow;
  tab: CenterTab;
  onTab: (t: CenterTab) => void;
  terminalRef: RefObject<TerminalPaneHandle | null>;
}) {
  return (
    <div className="asd-center">
      <div className="asd-center-top">
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
        <DriverBar />
      </div>
      <div className={`asd-center-body${tab === "chat" ? " asd-chat-body" : ""}`}>
        <section className="card asd-info">
          <div className="asd-info-head">
            <code>{fg.session_id}</code>
            <span className="tag">{fg.phase}</span>
            <span className="tag">{HARNESS_LABEL[fg.main_harness as HarnessId] ?? fg.main_harness}</span>
          </div>
          <MemoRow fg={fg} />
        </section>
        {tab === "chat" && <Thread />}
        {tab === "plan" && <PlanBoard />}
        {tab === "routing" && <RoutingConfigPanel />}
      </div>
      <div className="asd-terminal-slot">
        <TerminalPane ref={terminalRef} />
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
