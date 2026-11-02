import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { applyTheme, loadTheme, watchSystem, type ThemeChoice } from "../lib/theme";
import { baseName } from "../lib/api";
import { useApp, type HarnessId } from "../store";
import {
  AutoIcon,
  FolderIcon,
  LinkIcon,
  MoonIcon,
  PanelIcon,
  PlusIcon,
  SunIcon,
  TerminalIcon,
} from "./Icons";
import { HARNESS_LABEL } from "./DriverBar.tsx";
import logoUrl from "../logo.svg";

const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = {
  system: "dark",
  dark: "light",
  light: "system",
};
const THEME_LABEL: Record<ThemeChoice, string> = {
  system: "시스템 따라가기",
  dark: "다크 모드",
  light: "화이트 모드",
};

function ThemeButton() {
  const [t, setT] = useState<ThemeChoice>(loadTheme);
  const ref = useRef(t);
  ref.current = t;
  useEffect(() => watchSystem(() => ref.current), []);
  return (
    <button
      className="dock-btn"
      onClick={() => {
        const n = THEME_NEXT[t];
        setT(n);
        applyTheme(n);
      }}
      aria-label={`테마: ${THEME_LABEL[t]}`}
      data-tip={`${THEME_LABEL[t]} (누르면 바뀜)`}
    >
      <span className="dock-swap" key={t}>
        {t === "light" ? <SunIcon /> : t === "dark" ? <MoonIcon /> : <AutoIcon />}
      </span>
    </button>
  );
}

function ago(isoOrMs: string | number): string {
  const ms = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return new Date(ms).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

/** 왼쪽 도크: 로고, 새 세션, 세션 패널 열고 닫기, 프로젝트 변경, 테마 */
export function Dock({
  panelOpen,
  onTogglePanel,
}: {
  panelOpen: boolean;
  onTogglePanel: () => void;
}) {
  const { openSession, busySessions, showProjectPicker } = useApp();
  return (
    <nav className="dock" aria-label="ASD GUI">
      <div
        className={`dock-logo ${busySessions.length ? "busy" : ""}`}
        title="ASD GUI — 1+3 Fractal Delta Formation"
        aria-hidden
      >
        <img src={logoUrl} alt="ASD" draggable={false} />
      </div>
      <button
        className="dock-btn primary"
        onClick={() => openSession(null)}
        aria-label="새 세션"
        data-tip="새 세션 (Ctrl+N)"
      >
        <PlusIcon />
      </button>
      <button
        className={`dock-btn ${panelOpen ? "on" : ""}`}
        onClick={onTogglePanel}
        aria-label="세션 목록"
        aria-pressed={panelOpen}
        data-tip={panelOpen ? "세션 목록 접기" : "세션 목록 펼치기"}
      >
        <PanelIcon />
      </button>
      <button
        className="dock-btn"
        onClick={() => showProjectPicker()}
        aria-label="프로젝트 변경"
        data-tip="다른 프로젝트 폴더 열기"
      >
        <FolderIcon />
      </button>
      <div className="dock-gap" />
      <ThemeButton />
    </nav>
  );
}

/** 세션 패널: ASD 세션 + 현재 프로젝트의 일반 CLI 세션(여기서 열기, 메인 에이전트 연결, ASD 승격) */
export default function SessionPanel({
  open,
  onPicked,
}: {
  open: boolean;
  onPicked: () => void;
}) {
  const app = useApp();
  const {
    sessions,
    foregroundSessionId,
    openSession,
    busySessions,
    activeCliSession,
    selectCliSession,
    promoteCliSessionToAsd,
    attachCliSessionToCurrentAsd,
    openTerminalTab,
  } = app;
  const [q, setQ] = useState("");
  const busy = new Set(busySessions);

  const list = useMemo(
    () =>
      sessions.filter(
        (c) =>
          !q ||
          c.title.toLowerCase().includes(q.toLowerCase()) ||
          c.id.toLowerCase().includes(q.toLowerCase()) ||
          (c.workspaceDir ?? "").toLowerCase().includes(q.toLowerCase()),
      ),
    [sessions, q],
  );

  const cliSessions = useMemo(() => {
    const raw = app.snapshot?.cliRecentSessions ?? [];
    const query = q.trim().toLowerCase();
    return raw.filter((item) => {
      if (!query) return true;
      return (
        (item.summary || "").toLowerCase().includes(query) ||
        item.harnessSessionId.toLowerCase().includes(query) ||
        item.harness.toLowerCase().includes(query) ||
        (item.model || "").toLowerCase().includes(query)
      );
    });
  }, [app.snapshot?.cliRecentSessions, q]);

  return (
    <aside
      className={`panel ${open ? "open" : ""}`}
      aria-label="세션"
      aria-hidden={!open}
      inert={!open}
    >
      <div className="panel-inner">
        <div className="panel-head">
          <span className="panel-brand">
            <img src={logoUrl} alt="ASD" aria-hidden draggable={false} />
            <span className="panel-word">ASD GUI</span>
          </span>
          <span className="panel-count">
            ASD {sessions.length} · CLI {cliSessions.length}
          </span>
        </div>

        <input
          type="text"
          className="rail-search"
          placeholder="세션·하네스·메모 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="세션 검색"
        />

        <nav className="sessions">
          <div className="rail-sec-label">
            <span>ASD 오케스트레이션 세션</span>
            <span>{list.length}</span>
          </div>

          {list.length === 0 && (
            <div className="rail-empty">
              {q ? "일치하는 ASD 세션이 없습니다" : "첫 세션을 시작해 보세요"}
            </div>
          )}

          {list.map((c, i) => {
            const isActive =
              !activeCliSession && c.id === foregroundSessionId && !app.newSessionMode;
            const hLabel =
              HARNESS_LABEL[(c.harness as HarnessId) ?? "claude-code"] ??
              c.harness ??
              "";
            return (
              <div
                key={c.id}
                className={`session ${isActive ? "on" : ""} ${busy.has(c.id) ? "busy" : ""}`}
                style={{ "--i": i } as CSSProperties}
                onClick={() => {
                  openSession(c.id);
                  if (window.innerWidth < 960) onPicked();
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openSession(c.id);
                    if (window.innerWidth < 960) onPicked();
                  }
                }}
              >
                <div className="session-title" title={c.title}>
                  {c.title}
                </div>
                <div className="session-meta">
                  <span
                    className="session-folder"
                    title={c.workspaceDir ?? "기본 작업 폴더"}
                  >
                    <FolderIcon />{" "}
                    {c.workspaceDir ? baseName(c.workspaceDir) : "기본 폴더"}
                  </span>
                  {hLabel && <span className="rail-chip">{hLabel}</span>}
                  {c.phase && <span className="rail-chip">{c.phase}</span>}
                  <span>{busy.has(c.id) ? "작업 중" : ago(c.updatedAt)}</span>
                </div>
              </div>
            );
          })}

          <div className="rail-sec-label" style={{ marginTop: 12 }}>
            <span>현재 프로젝트 일반 CLI 세션</span>
            <span>{cliSessions.length}</span>
          </div>

          {cliSessions.length === 0 ? (
            <div className="rail-empty" style={{ padding: "10px 8px" }}>
              감지된 일반 CLI 세션이 없습니다
            </div>
          ) : (
            cliSessions.map((entry, idx) => {
              const isSelectedCli =
                activeCliSession?.harnessSessionId === entry.harnessSessionId &&
                activeCliSession?.harness === entry.harness;
              const hLabel =
                HARNESS_LABEL[entry.harness as HarnessId] ?? entry.harness;
              const titleText =
                entry.summary?.trim() ||
                `${hLabel} (${entry.harnessSessionId.slice(0, 8)})`;

              return (
                <div
                  key={`${entry.harness}::${entry.harnessSessionId}`}
                  className={`session cli-session ${isSelectedCli ? "on" : ""}`}
                  style={{ "--i": idx } as CSSProperties}
                  onClick={() => {
                    selectCliSession(entry);
                    if (window.innerWidth < 960) onPicked();
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      selectCliSession(entry);
                      if (window.innerWidth < 960) onPicked();
                    }
                  }}
                >
                  <div className="session-title" title={titleText}>
                    {titleText}
                  </div>
                  <div className="session-meta">
                    <span className="rail-chip accent">{hLabel}</span>
                    {entry.model && (
                      <span className="rail-chip" title={entry.model}>
                        {entry.model.slice(0, 16)}
                      </span>
                    )}
                    {entry.asdSessionId && (
                      <span className="rail-chip ok" title={`연결된 ASD 세션: ${entry.asdSessionId}`}>
                        ASD 연결됨
                      </span>
                    )}
                    <span>{ago(entry.updatedAt || entry.startedAt)}</span>
                  </div>
                  <div
                    className="cli-session-actions"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="btn xs"
                      title="이 일반 CLI 세션을 새 ASD 오케스트레이션 세션으로 승격"
                      onClick={() => void promoteCliSessionToAsd(entry)}
                    >
                      ASD 승격
                    </button>
                    {foregroundSessionId && (
                      <button
                        type="button"
                        className="btn xs ghost"
                        title="현재 전경 ASD 세션의 메인 드라이버로 연결"
                        onClick={() => void attachCliSessionToCurrentAsd(entry)}
                      >
                        <LinkIcon /> 드라이버 연결
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn xs ghost"
                      title="하단 PTY 터미널에서 대화형으로 재개"
                      onClick={() => {
                        openTerminalTab({
                          title: `${hLabel} (${entry.harnessSessionId.slice(0, 8)})`,
                          cwd: app.projectRoot ?? undefined,
                          harness: entry.harness,
                          harnessSessionId: entry.harnessSessionId,
                          model: entry.model ?? undefined,
                        });
                      }}
                    >
                      <TerminalIcon />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </nav>
      </div>
    </aside>
  );
}
