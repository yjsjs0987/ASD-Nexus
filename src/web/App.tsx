import React, { useEffect } from "react";
import "./styles.css";
import { useAsdStore } from "./store/useAsdStore.ts";
import { TopBar } from "./components/TopBar/TopBar.tsx";
import { Sidebar } from "./components/Sidebar/Sidebar.tsx";
import { PlanBoard } from "./components/PlanBoard/PlanBoard.tsx";
import { SubagentInspector } from "./components/SubagentInspector/SubagentInspector.tsx";
import { RoutingConfigPanel } from "./components/RoutingConfigPanel/RoutingConfigPanel.tsx";
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
          <div className="center-tabs">
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
          </div>
          <div className="center-content">
            {activeCenterTab === "routing" ? (
              <RoutingConfigPanel />
            ) : (
              <PlanBoard />
            )}
          </div>
        </main>
        <SubagentInspector />
      </div>

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
