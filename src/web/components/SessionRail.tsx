import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { applyTheme, loadTheme, watchSystem, type ThemeChoice } from "../lib/theme";
import { baseName } from "../lib/api";
import { ask } from "../lib/confirm";
import { useApp } from "../store";
import { AutoIcon, FolderIcon, MoonIcon, PanelIcon, PlusIcon, SunIcon, TrashIcon } from "./Icons";

// T1.1 수정 이식: Elysium SessionRail.tsx의 useApp(Elysium store)·baseName 결합을 asd-gui 스토어/세션 모델로 치환.
//  - conversations/conversationId → sessions/foregroundSessionId (protocol.ts SessionRow 기반)
//  - live → busySessions(작업 중 세션 id 목록)
//  - engines/setDialog(사용량·스킬·설정 창)는 이번 이식에서 제외 — T3.1이 셸 크롬으로 다시 얹는다.
//  - 스토어 본체는 임시 스텁(src/web/store.tsx)이며 T2.1/T3.1이 정식 구현으로 갈아낀다.

const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = { system: "dark", dark: "light", light: "system" };
const THEME_LABEL: Record<ThemeChoice, string> = { system: "시스템 따라가기", dark: "다크 모드", light: "화이트 모드" };

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

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}일 전`;
  return new Date(iso).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

/** 왼쪽 도크: 로고, 새 세션, 세션 패널 열고 닫기, 테마 */
export function Dock({ panelOpen, onTogglePanel }: { panelOpen: boolean; onTogglePanel: () => void }) {
  const { openSession, busySessions } = useApp();
  return (
    <nav className="dock" aria-label="ASD GUI">
      <div className={`dock-logo ${busySessions.length ? "busy" : ""}`} title="ASD GUI" aria-hidden>
        <img src="/logo.svg" alt="" draggable={false} />
      </div>
      <button className="dock-btn primary" onClick={() => openSession(null)} aria-label="새 세션" data-tip="새 세션 (Ctrl+N)">
        <PlusIcon />
      </button>
      <button className={`dock-btn ${panelOpen ? "on" : ""}`} onClick={onTogglePanel} aria-label="세션 목록" aria-pressed={panelOpen} data-tip={panelOpen ? "세션 목록 접기" : "세션 목록 펼치기"}>
        <PanelIcon />
      </button>
      <div className="dock-gap" />
      <ThemeButton />
    </nav>
  );
}

/** 세션 패널: 세션마다 카드 한 장. 카드에 그 세션의 작업 폴더(프로젝트 루트)가 보인다. */
export default function SessionPanel({ open, onPicked }: { open: boolean; onPicked: () => void }) {
  const { sessions, foregroundSessionId, openSession, deleteSession, busySessions } = useApp();
  const [q, setQ] = useState("");
  const busy = new Set(busySessions);
  const list = useMemo(() => sessions.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()) || (c.workspaceDir ?? "").toLowerCase().includes(q.toLowerCase())), [sessions, q]);

  return (
    <aside className={`panel ${open ? "open" : ""}`} aria-label="세션" aria-hidden={!open} inert={!open}>
      <div className="panel-inner">
        <div className="panel-head">
          <span className="panel-brand">
            <img src="/logo.svg" alt="" aria-hidden draggable={false} />
            <span className="panel-word">ASD GUI</span>
          </span>
          <span className="panel-count">{sessions.length}개 세션</span>
        </div>
        <input type="text" className="rail-search" placeholder="세션·폴더 검색" value={q} onChange={(e) => setQ(e.target.value)} aria-label="세션 검색" />
        <nav className="sessions">
          {list.length === 0 && <div className="rail-empty">{q ? "찾는 세션이 없습니다" : "첫 세션을 시작해 보세요"}</div>}
          {list.map((c, i) => (
            <div
              key={c.id}
              className={`session ${c.id === foregroundSessionId ? "on" : ""} ${busy.has(c.id) ? "busy" : ""}`}
              style={{ "--i": i } as CSSProperties}
              onClick={() => {
                openSession(c.id);
                onPicked();
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  openSession(c.id);
                  onPicked();
                }
              }}
            >
              <div className="session-title">{c.title}</div>
              <div className="session-meta">
                <span className="session-folder" title={c.workspaceDir ?? "기본 작업 폴더"}>
                  <FolderIcon /> {c.workspaceDir ? baseName(c.workspaceDir) : "기본 폴더"}
                </span>
                <span>{busy.has(c.id) ? "작업 중" : ago(c.updatedAt)}</span>
              </div>
              <button
                className="session-del"
                aria-label="세션 삭제"
                title="삭제"
                onClick={async (e) => {
                  e.stopPropagation();
                  const ok = await ask({
                    title: `'${c.title}' 세션을 삭제할까요?`,
                    body: "이 세션의 대화 기록, 작업 계획(.asd/PLAN.md), 메모가 모두 지워지고 되돌릴 수 없습니다. 작업 폴더의 파일은 지우지 않습니다.",
                    confirmLabel: "영구 삭제",
                    danger: true,
                  });
                  if (ok) deleteSession(c.id);
                }}
              >
                <TrashIcon />
              </button>
            </div>
          ))}
        </nav>
      </div>
    </aside>
  );
}
