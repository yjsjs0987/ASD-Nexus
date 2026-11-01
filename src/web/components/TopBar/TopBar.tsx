import React, { useState } from "react";
import { apiFetch } from "../../api/client.ts";
import type { BrowseDirsResponse } from "../../../shared/protocol.ts";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

export function TopBar(): React.ReactElement {
  const {
    locale,
    setLocale,
    projects,
    currentProjectRoot,
    snapshot,
    switchProject,
    wsConnected,
  } = useAsdStore();

  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseData, setBrowseData] = useState<BrowseDirsResponse | null>(null);

  const handleOpenFolderClick = async () => {
    if (window.asdDesktop?.pickDirectory) {
      const picked = await window.asdDesktop.pickDirectory();
      if (picked) {
        await switchProject(picked);
      }
      return;
    }
    const res = await apiFetch<BrowseDirsResponse>(
      `/api/projects/browse-dirs${
        currentProjectRoot
          ? `?dir=${encodeURIComponent(currentProjectRoot)}`
          : ""
      }`
    );
    setBrowseData(res);
    setBrowseOpen(true);
  };

  const navigateDir = async (dir: string) => {
    const res = await apiFetch<BrowseDirsResponse>(
      `/api/projects/browse-dirs?dir=${encodeURIComponent(dir)}`
    );
    setBrowseData(res);
  };

  const harnesses = snapshot?.harnesses ?? {};

  return (
    <header className="topbar">
      <div className="topbar-left">
        <strong className="brand-title">{t(locale, "appTitle")}</strong>
        <select
          className="project-select"
          value={currentProjectRoot ?? ""}
          onChange={(e) => {
            if (e.target.value) {
              void switchProject(e.target.value);
            }
          }}
        >
          <option value="" disabled>
            {t(locale, "selectProject")}
          </option>
          {projects.map((p) => (
            <option
              key={p.projectHash}
              value={p.projectRoot}
              disabled={!p.existsOnDisk}
              style={{ color: p.existsOnDisk ? undefined : "#64748b" }}
            >
              {p.projectRoot} ({p.sessionCount})
            </option>
          ))}
        </select>
        <button className="btn btn-secondary" onClick={handleOpenFolderClick}>
          {t(locale, "openFolder")}
        </button>
        {snapshot?.gitBranch && (
          <span className="git-badge">
            {snapshot.gitBranch}@{snapshot.gitHeadSha ?? "HEAD"}
          </span>
        )}
      </div>

      <div className="topbar-right">
        <div className="harness-dots" title={t(locale, "harnesses")}>
          {Object.entries(harnesses).map(([hId, info]) => (
            <span
              key={hId}
              className={`harness-pill ${
                info.installed ? "installed" : "missing"
              }`}
            >
              <span className="dot">{info.installed ? "●" : "○"}</span> {hId}
            </span>
          ))}
        </div>
        <span
          className={`ws-indicator ${wsConnected ? "online" : "offline"}`}
          title={wsConnected ? "WebSocket Online" : "WebSocket Offline"}
        >
          {wsConnected ? "WS ●" : "WS ○"}
        </span>
        <button
          className="btn btn-ghost"
          onClick={() => setLocale(locale === "ko" ? "en" : "ko")}
        >
          {locale.toUpperCase()}
        </button>
      </div>

      {browseOpen && browseData && (
        <div className="modal-backdrop" onClick={() => setBrowseOpen(false)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>{t(locale, "openFolder")}</h3>
            <div className="browse-current">
              <code>{browseData.currentDir}</code>
              {browseData.isGitRepo && (
                <span className="git-badge">Git Repo</span>
              )}
            </div>
            <div className="browse-list">
              {browseData.parentDir && (
                <div
                  className="browse-item"
                  onClick={() => void navigateDir(browseData.parentDir!)}
                >
                  📁 ..
                </div>
              )}
              {browseData.directories.map((dirName) => {
                const sep = browseData.currentDir.includes("\\") ? "\\" : "/";
                const full = browseData.currentDir.endsWith(sep)
                  ? `${browseData.currentDir}${dirName}`
                  : `${browseData.currentDir}${sep}${dirName}`;
                return (
                  <div
                    key={dirName}
                    className="browse-item"
                    onClick={() => void navigateDir(full)}
                  >
                    📁 {dirName}
                  </div>
                );
              })}
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  void switchProject(browseData.currentDir);
                  setBrowseOpen(false);
                }}
              >
                이 폴더 열기
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setBrowseOpen(false)}
              >
                {t(locale, "cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
