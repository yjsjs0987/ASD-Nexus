// T4.2 — xterm.js 터미널: pty_spawn/pty_input/pty_resize/pty_kill WS 프로토콜 사용.
// @xterm/xterm + @xterm/addon-fit 사용. 컴포넌트 언마운트 시 dispose + WS pty_kill 정리.
import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useApp } from "../store";
import { getWsClient } from "../ws.ts";
import { usePty, usePtyInput, usePtyResize, usePtyKill } from "../events.ts";
import type { HarnessId } from "../../shared/protocol.ts";
import { TerminalIcon, ChevronIcon, RefreshIcon, StopIcon } from "./Icons";

interface TerminalTab {
  id: string;
  title: string;
  harness?: HarnessId;
  harnessSessionId?: string;
  model?: string;
  asDriverOf?: { sessionId: string; driverId: string };
  cwd?: string;
  cols: number;
  rows: number;
}

export interface TerminalPaneHandle {
  openTab: (params: Omit<TerminalTab, "id" | "cols" | "rows">) => string;
}

export interface TerminalPaneProps {
  /** 초기 탭 목록 (세션 복원 등) */
  initialTabs?: Omit<TerminalTab, "id" | "cols" | "rows">[];
}

interface MountedTerm {
  term: Terminal;
  fit: FitAddon;
  element: HTMLDivElement;
  dispose: () => void;
}

const TerminalPane = forwardRef<TerminalPaneHandle, TerminalPaneProps>((props, ref) => {
  const app = useApp();
  const projectRoot = app.projectRoot;
  const fgId = app.foregroundSessionId;

  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRefs = useRef<Map<string, MountedTerm>>(new Map());
  const tabsRef = useRef<TerminalTab[]>([]);
  tabsRef.current = tabs;
  const wsClient = getWsClient();

  const ptyInput = usePtyInput();
  const ptyResize = usePtyResize();
  const ptyKill = usePtyKill();

  // 탭 생성 헬퍼
  const createTab = useCallback((params: Omit<TerminalTab, "id" | "cols" | "rows">) => {
    const id = `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const cols = 80;
    const rows = 24;
    const tab: TerminalTab = { ...params, id, cols, rows };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    setShowTerminal(true);
    return id;
  }, []);

  // 탭 닫기
  const closeTab = useCallback(
    (id: string) => {
      const tabData = termRefs.current.get(id);
      if (tabData) {
        tabData.dispose();
        termRefs.current.delete(id);
      }
      ptyKill(id);
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id);
        if (next.length === 0) {
          setShowTerminal(false);
        }
        return next;
      });
      setActiveTabId((prev) => (prev === id ? null : prev));
    },
    [ptyKill],
  );

  // 초기 탭 복원
  useEffect(() => {
    if (props.initialTabs?.length && tabs.length === 0) {
      props.initialTabs.forEach((t) => createTab(t));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ref를 통해 openTab 노출
  useImperativeHandle(
    ref,
    () => ({
      openTab: createTab,
    }),
    [createTab],
  );

  // 활성 탭의 xterm 인스턴스 마운트 및 표시 전환
  useEffect(() => {
    termRefs.current.forEach((mounted, id) => {
      mounted.element.style.display = id === activeTabId ? "block" : "none";
    });

    if (!activeTabId || !containerRef.current) return;
    const tab = tabsRef.current.find((t) => t.id === activeTabId);
    if (!tab) return;

    const existing = termRefs.current.get(activeTabId);
    if (existing) {
      requestAnimationFrame(() => {
        try {
          existing.fit.fit();
        } catch {
          // ignore fit errors when hidden
        }
      });
      return;
    }

    const element = document.createElement("div");
    element.style.width = "100%";
    element.style.height = "100%";
    element.style.minHeight = "150px";
    containerRef.current.appendChild(element);

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono Variable", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.45,
      letterSpacing: 0,
      theme: {
        background: "#0d1318",
        foreground: "#e6edf3",
        cursor: "#56d4c8",
        cursorAccent: "#0d1318",
        selectionBackground: "rgba(86, 212, 200, 0.28)",
      },
      convertEol: true,
      scrollback: 5000,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    try {
      fit.fit();
    } catch {
      // ignore initial fit error
    }

    const initialCols = term.cols || tab.cols || 80;
    const initialRows = term.rows || tab.rows || 24;

    if (projectRoot) {
      wsClient.spawnPty({
        tabId: activeTabId,
        projectRoot,
        cwd: tab.cwd,
        harness: tab.harness,
        harnessSessionId: tab.harnessSessionId,
        model: tab.model,
        asDriverOf: tab.asDriverOf,
        cols: initialCols,
        rows: initialRows,
      });
    }

    const dataDisp = term.onData((data: string) => {
      ptyInput(activeTabId, data);
    });

    let lastCols = initialCols;
    let lastRows = initialRows;
    const ro = new ResizeObserver(() => {
      const current = termRefs.current.get(activeTabId);
      if (!current) return;
      try {
        current.fit.fit();
      } catch {
        return;
      }
      const newCols = current.term.cols;
      const newRows = current.term.rows;
      if (newCols > 0 && newRows > 0 && (newCols !== lastCols || newRows !== lastRows)) {
        lastCols = newCols;
        lastRows = newRows;
        setTabs((prev) =>
          prev.map((t) => (t.id === activeTabId ? { ...t, cols: newCols, rows: newRows } : t)),
        );
        ptyResize(activeTabId, newCols, newRows);
      }
    });
    ro.observe(element);

    const dispose = () => {
      dataDisp.dispose();
      ro.disconnect();
      term.dispose();
      if (element.parentNode) {
        element.parentNode.removeChild(element);
      }
    };

    termRefs.current.set(activeTabId, { term, fit, element, dispose });
  }, [activeTabId, projectRoot, ptyInput, ptyResize, wsClient]);

  // 언마운트 시 전체 정리
  useEffect(() => {
    const map = termRefs.current;
    return () => {
      map.forEach((mounted, id) => {
        mounted.dispose();
        ptyKill(id);
      });
      map.clear();
    };
  }, [ptyKill]);

  // WS pty_output 구독
  usePty({
    tabId: activeTabId ?? "",
    onOutput: (data) => {
      const tabData = termRefs.current.get(activeTabId ?? "");
      if (tabData) tabData.term.write(data);
    },
    onExit: (exitCode) => {
      const tabData = termRefs.current.get(activeTabId ?? "");
      if (tabData) {
        tabData.term.write(`\r\n[프로세스 종료: exit code ${exitCode}]\r\n`);
      }
    },
    onError: (message) => {
      const tabData = termRefs.current.get(activeTabId ?? "");
      if (tabData) {
        tabData.term.write(`\r\n[오류: ${message}]\r\n`);
      }
    },
  });

  // 프로젝트/세션 변경 시 터미널 초기화
  useEffect(() => {
    if (!projectRoot || !fgId) {
      termRefs.current.forEach((mounted, id) => {
        mounted.dispose();
        ptyKill(id);
      });
      termRefs.current.clear();
      setTabs([]);
      setActiveTabId(null);
      setShowTerminal(false);
    }
  }, [projectRoot, fgId, ptyKill]);

  if (!showTerminal && tabs.length === 0) {
    return null;
  }

  return (
    <div
      className="asd-terminal-pane"
      style={{ display: "flex", flexDirection: "column", height: "230px", minHeight: 0 }}
    >
      {/* 탭 바 */}
      <div
        className="asd-terminal-tabs"
        style={{
          display: "flex",
          gap: 2,
          padding: "4px 8px",
          borderBottom: "1px solid var(--line)",
          background: "var(--surface)",
          flexShrink: 0,
        }}
      >
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === activeTabId}
            className={`asd-terminal-tab ${tab.id === activeTabId ? "active" : ""}`}
            onClick={() => setActiveTabId(tab.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") setActiveTabId(tab.id);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 10px",
              borderRadius: "8px 8px 0 0",
              border: "1px solid var(--line)",
              borderBottom: "none",
              background: tab.id === activeTabId ? "var(--card)" : "var(--surface)",
              color: tab.id === activeTabId ? "var(--ink)" : "var(--muted)",
              fontSize: "12.5px",
              fontWeight: tab.id === activeTabId ? 600 : 400,
              cursor: "pointer",
              transition: "all 0.15s ease",
              maxWidth: "180px",
              minWidth: "80px",
            }}
          >
            <TerminalIcon size={12} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {tab.title}
            </span>
            {tab.harness && (
              <span className="tag" style={{ fontSize: "9px", padding: "0 4px" }}>
                {tab.harness}
              </span>
            )}
            <button
              type="button"
              className="asd-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.id);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "18px",
                height: "18px",
                borderRadius: "4px",
                border: "none",
                background: "transparent",
                color: "var(--dim)",
                cursor: "pointer",
                padding: 0,
              }}
              aria-label="탭 닫기"
            >
              <ChevronIcon size={10} />
            </button>
          </div>
        ))}
        {tabs.length === 0 && (
          <span className="asd-dim" style={{ padding: "4px 8px", fontSize: "12.5px" }}>
            터미널 탭이 없습니다 — [터미널] 버튼으로 새 탭 열기
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => createTab({ title: "새 터미널", cwd: projectRoot ?? undefined })}
          disabled={!projectRoot}
          style={{ marginRight: 4 }}
        >
          <TerminalIcon size={14} /> 새 탭
        </button>
      </div>

      {/* 터미널 본문 */}
      <div
        ref={containerRef}
        className="asd-terminal-container"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "hidden",
          background: "#0d1318",
          position: "relative",
        }}
      />

      {/* 툴바 (하단) */}
      <div
        className="asd-terminal-toolbar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          borderTop: "1px solid var(--line)",
          background: "var(--surface)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => activeTabId && ptyResize(activeTabId, 80, 24)}
            title="기본 크기(80x24)로 리셋"
          >
            <RefreshIcon size={14} />
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => activeTabId && ptyKill(activeTabId)}
            title="터미널 프로세스 강제 종료"
          >
            <StopIcon size={14} />
          </button>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => activeTabId && ptyInput(activeTabId, "\x03")}
            title="SIGINT (Ctrl+C) 전송"
          >
            <span style={{ fontFamily: "var(--mono)", fontSize: "11px" }}>^C</span>
          </button>
        </div>
        <div style={{ flex: 1 }} />
        {activeTabId && (
          <span className="asd-dim" style={{ fontFamily: "var(--mono)", fontSize: "11px" }}>
            {tabs.find((t) => t.id === activeTabId)?.cols ?? 80}×
            {tabs.find((t) => t.id === activeTabId)?.rows ?? 24}
          </span>
        )}
      </div>
    </div>
  );
});

TerminalPane.displayName = "TerminalPane";

export default TerminalPane;
