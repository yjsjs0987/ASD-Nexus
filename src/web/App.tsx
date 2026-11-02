// T3.1 / T4.x / T5.1 — Elysium App.tsx의 레이어 구조(입자 배경 → 도크 · 세션 레일 · 본문 · 오른쪽 인스펙터 · 모달)를
// ASD 멀티에이전트 콘솔로 완성한다. 3컬럼 폭은 styles.css의 .app grid-template-columns가
// 명시적으로 잡는다(84px | minmax(0, 1fr) | 84px — 구버전 결함 1 재발 방지).
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { useApp, type HarnessId, type SessionRow } from "./store";
import type { CliRecentSessionEntry } from "../shared/protocol.ts";
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
import ModelPicker, { HarnessModelsModal } from "./components/ModelPicker";
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

  // 전경 세션 행
  const fg = useMemo(
    () => app.snapshot?.sessions.find((s) => s.session_id === app.foregroundSessionId) ?? null,
    [app.snapshot, app.foregroundSessionId],
  );
  const cliSession = app.activeCliSession;

  // 세션이나 CLI 대화를 선택할 때 자동으로 '대화' 탭으로 전환
  useEffect(() => {
    if (app.foregroundSessionId || cliSession?.harnessSessionId) {
      setTab("chat");
    }
  }, [app.foregroundSessionId, cliSession?.harnessSessionId]);

  const orbMode = app.error ? "error" : app.busySessions.length > 0 ? "thinking" : "idle";
  const welcomeMode =
    app.projectRoot == null
      ? "projects"
      : app.newSessionMode
        ? "new"
        : fg == null && cliSession == null
          ? "empty"
          : null;

  const subagentCount = useMemo(() => {
    if (!fg || !app.snapshot?.subagentLogs) return 0;
    return app.snapshot.subagentLogs.filter((l) => l.sessionId === fg.session_id).length;
  }, [fg, app.snapshot]);

  const installedHarnessCount = useMemo(() => {
    const h = app.snapshot?.harnesses;
    if (!h) return 0;
    return HARNESS_ALL.filter((k) => h[k]?.installed).length;
  }, [app.snapshot?.harnesses]);

  return (
    <div
      className={`app${panel ? " panel-is-open" : ""}${
        inspectorOpen && fg ? " inspector-is-open" : ""
      }`}
    >
      <GlassDefs />
      <ParticleOrb mode={orbMode} />
      <Dock panelOpen={panel} onTogglePanel={togglePanel} />
      <SessionPanel open={panel} onPicked={() => window.innerWidth < PANEL_WIDE && setPanel(false)} />
      <main className="main">
        {welcomeMode ? (
          <Welcome mode={welcomeMode} />
        ) : (
          (fg || cliSession) && (
            <>
              <SessionHead fg={fg} cliSession={cliSession} />
              <CenterPanel
                fg={fg}
                cliSession={cliSession}
                tab={tab}
                onTab={setTab}
                terminalRef={terminalRef}
              />
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
          data-tip={inspectorOpen ? "인스펙터 접기" : "서브에이전트 인스펙터"}
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
          className={`dock-btn ${app.showHarnessModal ? "on" : ""}`}
          onClick={() => app.setShowHarnessModal(true)}
          data-tip={`하네스 및 모델 상태 (${installedHarnessCount}/5 설치됨)`}
          aria-label="하네스 및 사용 가능한 모델 확인"
        >
          <InfoIcon />
          {installedHarnessCount > 0 && <span className="dock-count">{installedHarnessCount}</span>}
        </button>
      </nav>

      <aside className={`tools-panel ${inspectorOpen && fg ? "open" : ""}`} aria-label="서브에이전트 인스펙터">
        <SubagentInspector />
      </aside>

      <WorktreeDiffModal />
      {app.showHarnessModal && <HarnessModelsModal onClose={() => app.setShowHarnessModal(false)} />}

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
  const [path, setPath] = useState(() => app.projectRoot ?? "");
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

  const visibleProjects = useMemo(
    () => app.projects.filter((p) => p.existsOnDisk !== false).slice(0, 8),
    [app.projects],
  );

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
            : visibleProjects.length > 0
              ? "작업할 프로젝트를 선택하거나 새 폴더 경로를 열어 시작하세요"
              : "아직 열었던 프로젝트가 없습니다 — 폴더 경로로 시작하세요"}
        </p>
        {visibleProjects.length > 0 && (
          <div className="welcome-cards">
            {visibleProjects.map((p, i) => (
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
                  <button
                    type="button"
                    className="btn sm primary"
                    onClick={() => void app.openProject(browseData.currentDir)}
                  >
                    이 폴더 열기
                  </button>
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
  const [initialPrompt, setInitialPrompt] = useState("");
  const harnessOptions = useMemo(() => {
    const h = app.snapshot?.harnesses;
    if (!h) return HARNESS_ALL;
    const installed = HARNESS_ALL.filter((k) => h[k]?.installed);
    return installed.length > 0 ? installed : HARNESS_ALL;
  }, [app.snapshot]);
  const [harness, setHarness] = useState<HarnessId>("claude-code");
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    if (!harnessOptions.includes(harness)) setHarness(harnessOptions[0]);
  }, [harnessOptions, harness]);

  const modelsForHarness = useMemo(
    () => app.snapshot?.availableModels?.[harness] ?? [],
    [app.snapshot?.availableModels, harness],
  );

  useEffect(() => {
    const nextDefault = modelsForHarness[0] ?? "";
    if (!model || !modelsForHarness.includes(model)) {
      setModel(nextDefault);
    }
  }, [harness, modelsForHarness]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const promptText = initialPrompt.trim();
    const memoText = memo.trim() || (promptText ? promptText.slice(0, 60) : undefined);
    const createdId = await app.createSession({
      harness,
      model: model.trim() || undefined,
      memo: memoText,
    });
    if (createdId && promptText && app.projectRoot) {
      try {
        const r = await api.driverPrompt({
          projectRoot: app.projectRoot,
          sessionId: createdId,
          prompt: promptText,
        });
        app.recordPrompt(createdId, promptText, r.jobId, r.runId);
      } catch (err) {
        app.reportError(api.errorText(err));
      }
    }
  };

  const existingSessions = app.snapshot?.sessions ?? [];

  return (
    <div className="thread empty asd-fill">
      <div className="welcome">
        <div className="orb-anchor" data-orb-anchor aria-hidden />
        <h1>새 세션</h1>
        <p className="welcome-sub">
          <b>{app.projectRoot ? baseName(app.projectRoot) : ""}</b>에서 새 ASD 세션을 만듭니다
        </p>
        <form className="asd-form" onSubmit={(e) => void submit(e)}>
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="세션 메모 — 작업 주제 한 줄 (비우면 첫 프롬프트로 자동 설정)"
              aria-label="세션 메모"
              style={{ flex: 1, minWidth: 220 }}
            />
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
            <select
              className="asd-select"
              value={harness}
              onChange={(e) => {
                const nextH = e.target.value as HarnessId;
                setHarness(nextH);
                const nextModels = app.snapshot?.availableModels?.[nextH] ?? [];
                setModel(nextModels[0] ?? "");
              }}
              aria-label="드라이버 하네스"
            >
              {harnessOptions.map((h) => (
                <option key={h} value={h}>
                  {HARNESS_LABEL[h]}
                </option>
              ))}
            </select>
            <ModelPicker
              harness={harness}
              value={model}
              models={modelsForHarness}
              onChange={setModel}
              placeholder="모델 선택"
              style={{ flex: 1, minWidth: 220 }}
            />
            <button type="submit" className="btn primary" disabled={app.loading}>
              {initialPrompt.trim() ? "세션 생성 및 전송" : "세션 생성"}
            </button>
          </div>
          <textarea
            className="asd-plan-textarea"
            style={{ minHeight: 84, maxHeight: 180, fontSize: 13 }}
            value={initialPrompt}
            onChange={(e) => setInitialPrompt(e.target.value)}
            placeholder="(선택) 시작 프롬프트를 입력하면 새 세션 생성 직후 바로 전송합니다"
            aria-label="시작 프롬프트"
          />
          <p className="asd-dim">새 세션은 자동으로 전경 세션으로 고정되며 이전 세션으로 되돌아가지 않습니다.</p>
        </form>
        <div className="asd-actions">
          {existingSessions.length > 0 && (
            <button
              type="button"
              className="btn sm"
              onClick={() => void app.openSession(existingSessions[0].session_id)}
            >
              취소 (이전 세션으로)
            </button>
          )}
          <button type="button" className="btn sm ghost" onClick={() => app.showProjectPicker()}>
            <FolderIcon /> 다른 프로젝트 열기
          </button>
          <button type="button" className="btn sm ghost" onClick={() => app.setShowHarnessModal(true)}>
            하네스·모델 목록 확인
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
          <button className="btn" onClick={() => app.showProjectPicker()}>
            <FolderIcon /> 다른 프로젝트 열기
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 세션 화면: 머리 + 중앙 패널(대화 / PLAN / Routing + 터미널) ──

function SessionHead({
  fg,
  cliSession,
}: {
  fg: SessionRow | null;
  cliSession: CliRecentSessionEntry | null;
}) {
  const app = useApp();
  const [editingMemo, setEditingMemo] = useState(false);
  const [memoDraft, setMemoDraft] = useState(fg?.memo ?? "");

  useEffect(() => {
    setMemoDraft(fg?.memo ?? "");
    setEditingMemo(false);
  }, [fg?.session_id, fg?.memo]);

  const isCliView = Boolean(cliSession);
  const busy = !isCliView && fg ? app.busySessions.includes(fg.session_id) : false;
  const phaseAction =
    isCliView || fg == null
      ? null
      : fg.phase === "paused"
        ? ({ label: "재개", next: "running" } as const)
        : fg.phase === "done"
          ? null
          : ({ label: "일시정지", next: "paused" } as const);

  const projectRoot =
    cliSession?.projectRoot ?? fg?.project_root ?? app.projectRoot ?? "";
  const title = cliSession
    ? cliSession.summary?.trim() ||
      `${HARNESS_LABEL[cliSession.harness as HarnessId] ?? cliSession.harness} (${cliSession.harnessSessionId.slice(0, 8)})`
    : fg
      ? fg.memo?.trim() || fg.session_id
      : "세션";

  const saveMemoInline = async () => {
    if (!fg) return;
    await app.saveMemo(fg.session_id, memoDraft.trim());
    setEditingMemo(false);
  };

  const harnesses = app.snapshot?.harnesses;

  return (
    <header className="session-head">
      <span className="head-orb" data-orb-anchor="mini" aria-hidden />
      {editingMemo && fg && !isCliView ? (
        <div className="row" style={{ gap: 6, flex: "0 1 380px", minWidth: 180 }}>
          <input
            type="text"
            value={memoDraft}
            onChange={(e) => setMemoDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveMemoInline();
              if (e.key === "Escape") setEditingMemo(false);
            }}
            placeholder="세션 메모 입력"
            aria-label="세션 메모"
            autoFocus
            style={{ height: 30, padding: "0 10px", fontSize: 13 }}
          />
          <button type="button" className="btn sm primary" onClick={() => void saveMemoInline()}>
            저장
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setEditingMemo(false)}>
            취소
          </button>
        </div>
      ) : (
        <span
          className="head-title"
          onClick={() => !isCliView && fg && setEditingMemo(true)}
          title={
            !isCliView && fg
              ? `${title} (${fg.session_id}) — 클릭하여 메모 수정`
              : title
          }
          style={{ cursor: !isCliView && fg ? "pointer" : "default" }}
        >
          <span className={`head-dot ${busy ? "busy" : ""}`} aria-hidden />
          {title}
        </span>
      )}

      <button
        type="button"
        className="head-folder"
        onClick={() => app.showProjectPicker()}
        title={`${projectRoot} — 클릭하여 다른 프로젝트 폴더 열기`}
        aria-label="프로젝트 폴더 변경"
      >
        <FolderIcon /> {baseName(projectRoot)}
      </button>

      {cliSession ? (
        <>
          <span className="tag ok">일반 CLI 세션</span>
          <span className="tag">
            {HARNESS_LABEL[cliSession.harness as HarnessId] ?? cliSession.harness}
          </span>
          {fg && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => app.selectCliSession(null)}
              title="전경 ASD 세션으로 돌아가기"
            >
              ← ASD 세션으로
            </button>
          )}
        </>
      ) : (
        fg && (
          <>
            <span className="tag" title={`세션 ID: ${fg.session_id}`}>
              {fg.phase}
            </span>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => setEditingMemo(true)}
              title="세션 메모 수정"
            >
              메모 수정
            </button>
          </>
        )
      )}

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

      {/* 5대 하네스 상태 미니 뱃지 + 모달 열기 */}
      <button
        type="button"
        className="btn sm"
        onClick={() => app.setShowHarnessModal(true)}
        title="설치된 하네스 및 사용 가능한 모델 목록 확인"
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {HARNESS_ALL.map((h) => {
            const inst = harnesses?.[h]?.installed;
            return (
              <span
                key={h}
                title={`${HARNESS_LABEL[h]}: ${inst ? "설치됨" : "미설치"}`}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: inst ? "var(--hl)" : "var(--line-2)",
                  display: "inline-block",
                }}
              />
            );
          })}
          <span style={{ marginLeft: 4 }}>하네스·모델</span>
        </span>
      </button>

      {cliSession && (
        <button
          type="button"
          className="btn sm primary"
          onClick={() => void app.promoteCliSessionToAsd(cliSession)}
        >
          ASD 세션으로 승격
        </button>
      )}

      {phaseAction && fg && !isCliView && (
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
  cliSession,
  tab,
  onTab,
  terminalRef,
}: {
  fg: SessionRow | null;
  cliSession: CliRecentSessionEntry | null;
  tab: CenterTab;
  onTab: (t: CenterTab) => void;
  terminalRef: RefObject<TerminalPaneHandle | null>;
}) {
  const app = useApp();
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
        {cliSession ? (
          <div className="asd-driver-bar">
            <div className="asd-driver-bar-main">
              <span className="tag ok">
                CLI 세션: {HARNESS_LABEL[cliSession.harness as HarnessId] ?? cliSession.harness}
              </span>
              {cliSession.model && <code className="asd-driver-model">{cliSession.model}</code>}
              <code className="asd-dim">{cliSession.harnessSessionId.slice(0, 18)}</code>
              <span className="spacer" />
              <button
                type="button"
                className="btn sm primary"
                onClick={() => void app.promoteCliSessionToAsd(cliSession)}
              >
                ASD 세션으로 승격하여 계속 대화
              </button>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  app.openTerminalTab({
                    title: `${HARNESS_LABEL[cliSession.harness as HarnessId] ?? cliSession.harness}: ${cliSession.harnessSessionId.slice(0, 8)}`,
                    cwd: cliSession.projectRoot || app.projectRoot || undefined,
                    harness: cliSession.harness,
                    harnessSessionId: cliSession.harnessSessionId,
                  })
                }
              >
                &gt;_ 터미널에서 재개
              </button>
            </div>
          </div>
        ) : (
          fg && <DriverBar />
        )}
      </div>
      <div className={`asd-center-body${tab === "chat" ? " asd-chat-body" : ""}`}>
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
