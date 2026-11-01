import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

export interface TerminalPaneProps {
  tabId: string;
}

export function TerminalPane({ tabId }: TerminalPaneProps): React.ReactElement {
  const { locale, ptyTabs, ptyBuffers, sendWs, closePtyTab } = useAsdStore();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenLenRef = useRef<number>(0);

  const tab = ptyTabs.find((tk) => tk.tabId === tabId);
  const buffer = ptyBuffers[tabId] ?? "";

  useEffect(() => {
    if (!containerRef.current || !tab || tab.error) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "Consolas, 'Courier New', monospace",
      theme: {
        background: "#0b1120",
        foreground: "#e2e8f0",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    try {
      fitAddon.fit();
    } catch {
      // Ignore layout fit errors in hidden containers
    }

    termRef.current = term;
    fitRef.current = fitAddon;
    writtenLenRef.current = 0;

    if (buffer) {
      term.write(buffer);
      writtenLenRef.current = buffer.length;
    }

    const dataDisp = term.onData((data) => {
      sendWs({ type: "pty_input", tabId, data });
    });

    const handleResize = () => {
      try {
        fitAddon.fit();
        sendWs({
          type: "pty_resize",
          tabId,
          cols: term.cols,
          rows: term.rows,
        });
      } catch {
        // Ignore
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      dataDisp.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [tabId, tab?.error, sendWs]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (buffer.length > writtenLenRef.current) {
      const delta = buffer.slice(writtenLenRef.current);
      term.write(delta);
      writtenLenRef.current = buffer.length;
    } else if (buffer.length < writtenLenRef.current) {
      term.clear();
      term.write(buffer);
      writtenLenRef.current = buffer.length;
    }
  }, [buffer]);

  if (!tab) {
    return <div className="empty-state">터미널 탭을 찾을 수 없습니다.</div>;
  }

  return (
    <div className="terminal-pane" data-testid={`terminal-pane-${tabId}`}>
      <div className="terminal-toolbar">
        <div>
          <strong>{tab.title}</strong>{" "}
          <span className="mono-small">({tab.cwd || tab.projectRoot})</span>
          {tab.exited && (
            <span className="status-pill status-done">
              Exited ({tab.exitCode ?? 0})
            </span>
          )}
        </div>
        <button
          className="btn btn-danger btn-sm"
          onClick={() => closePtyTab(tabId)}
        >
          ✕ 닫기
        </button>
      </div>

      {tab.error ? (
        <div className="pty-fallback-box" role="alert">
          <p>{t(locale, "ptyUnavailable")}</p>
          <pre className="log-pre">{tab.error}</pre>
        </div>
      ) : (
        <div
          ref={containerRef}
          className="xterm-container"
          style={{ flex: 1, minHeight: "360px" }}
        />
      )}
    </div>
  );
}
