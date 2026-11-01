import React, { useEffect } from "react";
import "./styles.css";
import { useAsdStore } from "./store/useAsdStore.ts";
import { TopBar } from "./components/TopBar/TopBar.tsx";
import { Sidebar } from "./components/Sidebar/Sidebar.tsx";
import { PlanBoard } from "./components/PlanBoard/PlanBoard.tsx";
import { t } from "./i18n/index.ts";

declare global {
  interface Window {
    asdDesktop?: {
      pickDirectory: () => Promise<string | null>;
    };
  }
}

export function App(): React.ReactElement {
  const initApp = useAsdStore((s) => s.initApp);
  const error = useAsdStore((s) => s.error);
  const setError = useAsdStore((s) => s.setError);
  const toasts = useAsdStore((s) => s.toasts);
  const dismissToast = useAsdStore((s) => s.dismissToast);
  const selectedTaskId = useAsdStore((s) => s.selectedTaskId);
  const selectedSessionId = useAsdStore((s) => s.selectedSessionId);
  const snapshot = useAsdStore((s) => s.snapshot);
  const subagentLogs = useAsdStore((s) => s.subagentLogs);
  const lang = useAsdStore((s) => s.lang);

  useEffect(() => {
    void initApp();
  }, [initApp]);

  const tasks =
    (selectedSessionId && snapshot?.tasksBySession?.[selectedSessionId]) || [];
  const selectedTask = tasks.find((tk) => tk.task_id === selectedTaskId);

  return (
    <div className="asd-app" data-testid="asd-gui-app">
      <TopBar />
      {error && (
        <div className="asd-error-banner" role="alert">
          <span>{error}</span>
          <button className="asd-btn" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      <div className="asd-workspace">
        <Sidebar />
        <main className="asd-center">
          <PlanBoard />
        </main>
        <aside className="asd-inspector" data-testid="asd-inspector">
          <div className="asd-sidebar-header">{t(lang, "inspectorTitle")}</div>
          {!selectedTask ? (
            <div className="asd-empty">{t(lang, "selectTaskPrompt")}</div>
          ) : (
            <div className="asd-inspector-body">
              <div style={{ fontWeight: 700, fontSize: "14px" }}>
                {selectedTask.task_id}: {selectedTask.title}
              </div>
              <div className="asd-task-meta">
                <span className={`asd-badge status-${selectedTask.status}`}>
                  {selectedTask.status}
                </span>
                <span className="asd-badge">
                  {selectedTask.scope}:{selectedTask.complexity}
                </span>
                {selectedTask.assigned_harness && (
                  <span className="asd-badge">
                    {selectedTask.assigned_harness}
                  </span>
                )}
              </div>
              {selectedTask.description && (
                <div style={{ fontSize: "12px", color: "#cbd5e1" }}>
                  {selectedTask.description}
                </div>
              )}
              <div className="asd-sidebar-header" style={{ padding: "6px 0" }}>
                {t(lang, "liveLog")}
              </div>
              <pre className="asd-log-box">
                {subagentLogs[`${selectedSessionId}:${selectedTask.task_id}`] ||
                  "(No log output yet)"}
              </pre>
            </div>
          )}
        </aside>
      </div>

      {toasts.length > 0 && (
        <div className="asd-toast-container">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="asd-toast"
              onClick={() => dismissToast(toast.id)}
            >
              {toast.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
