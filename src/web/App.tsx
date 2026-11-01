import React, { useEffect } from "react";
import "./styles.css";
import { useAsdStore } from "./store/useAsdStore.ts";
import { TopBar } from "./components/TopBar/TopBar.tsx";
import { Sidebar } from "./components/Sidebar/Sidebar.tsx";
import { DriverBar } from "./components/DriverBar/DriverBar.tsx";
import { TranscriptView } from "./components/TranscriptView/TranscriptView.tsx";
import { PlanBoard } from "./components/PlanBoard/PlanBoard.tsx";
import { SubagentInspector } from "./components/SubagentInspector/SubagentInspector.tsx";
import { RoutingConfigPanel } from "./components/RoutingConfigPanel/RoutingConfigPanel.tsx";
import { TerminalPane } from "./components/TerminalPane/TerminalPane.tsx";
import { WorktreeDiffModal } from "./components/WorktreeDiffModal/WorktreeDiffModal.tsx";
import { t } from "./i18n/index.ts";

declare global {
  interface Window {
    asdDesktop?: {
      pickDirectory: () => Promise<string | null>;
    };
  }
}

export function App(): React.ReactElement {
  const {
    locale,
    errorBanner,
    setErrorBanner,
    toasts,
    dismissToast,
    ptyTabs,
    closePtyTab,
    activeCenterTab,
    setActiveCenterTab,
    initWsAndLoadProjects,
  } = useAsdStore();

  useEffect(() => {
    void initWsAndLoadProjects();
  }, [initWsAndLoadProjects]);

  return (
    <div className="asd-app" data-testid="asd-gui-app">
      <TopBar />
      {errorBanner && (
        <div className="error-banner" role="alert">
          <span>{errorBanner}</span>
          <button
            className="btn btn-sm"
            onClick={() => setErrorBanner(null)}
          >
            ✕
          </button>
        </div>
      )}
      <div className="main-layout">
        <Sidebar />
        <main className="center-pane">
          <DriverBar />
          <div className="center-tabs">
            <button
              className={`tab-btn ${activeCenterTab === "chat" ? "active" : ""}`}
              onClick={() => setActiveCenterTab("chat")}
            >
              {t(locale, "chatTab")}
            </button>
            <button
              className={`tab-btn ${activeCenterTab === "plan" ? "active" : ""}`}
              onClick={() => setActiveCenterTab("plan")}
            >
              {t(locale, "planBoardTab")}
            </button>
            <button
              className={`tab-btn ${activeCenterTab === "routing" ? "active" : ""}`}
              onClick={() => setActiveCenterTab("routing")}
            >
              {t(locale, "routingTab")}
            </button>
            {ptyTabs.map((pt) => {
              const key = `pty:${pt.tabId}` as const;
              return (
                <button
                  key={key}
                  className={`tab-btn ${activeCenterTab === key ? "active" : ""}`}
                  onClick={() => setActiveCenterTab(key)}
                >
                  &gt;_ {pt.title}{" "}
                  <span
                    style={{ marginLeft: 6 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      closePtyTab(pt.tabId);
                    }}
                  >
                    ×
                  </span>
                </button>
              );
            })}
          </div>
          <div className="center-content">
            {activeCenterTab.startsWith("pty:") ? (
              <TerminalPane tabId={activeCenterTab.slice(4)} />
            ) : activeCenterTab === "chat" ? (
              <TranscriptView />
            ) : activeCenterTab === "routing" ? (
              <RoutingConfigPanel />
            ) : (
              <PlanBoard />
            )}
          </div>
        </main>
        <SubagentInspector />
      </div>

      <WorktreeDiffModal />

      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className="toast-item"
              onClick={() => dismissToast(toast.id)}
            >
              {toast.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
