import React, { useState } from "react";
import type { HarnessId } from "agent-swarm-director";
import { apiFetch } from "../../api/client.ts";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

const HARNESS_LIST: HarnessId[] = [
  "claude-code",
  "opencode",
  "codex",
  "antigravity",
  "cursor",
];

export function Sidebar(): React.ReactElement {
  const {
    locale,
    currentProjectRoot,
    snapshot,
    driversBySession,
    selectedSessionId,
    selectSession,
    selectSubagent,
    selectRecentChat,
    openPtyTab,
  } = useAsdStore();

  const [newModalOpen, setNewModalOpen] = useState(false);
  const [newHarness, setNewHarness] = useState<HarnessId>("claude-code");
  const [newModel, setNewModel] = useState("");
  const [newMemo, setNewMemo] = useState("");

  const sessions = snapshot?.sessions ?? [];
  const allTasks = snapshot?.allTasks ?? [];
  const cliRecent = snapshot?.cliRecentSessions ?? [];
  const foregroundId = snapshot?.foregroundSessionId ?? null;

  const handleCreateSession = async () => {
    if (!currentProjectRoot) return;
    const res = await apiFetch<{ ok: boolean; sessionId: string }>(
      "/api/sessions/create",
      {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          harness: newHarness,
          model: newModel || undefined,
          memo: newMemo || undefined,
          makeForeground: true,
        }),
      }
    );
    setNewModalOpen(false);
    setNewMemo("");
    selectSession(res.sessionId);
  };

  const handleSetForeground = async (sessionId: string) => {
    if (!currentProjectRoot) return;
    await apiFetch("/api/sessions/foreground", {
      method: "POST",
      body: JSON.stringify({
        projectRoot: currentProjectRoot,
        sessionId,
      }),
    });
  };

  const handleLinkRecentAsDriver = async (
    harness: HarnessId,
    harnessSessionId: string,
    model?: string | null
  ) => {
    if (!currentProjectRoot || !selectedSessionId) return;
    await apiFetch("/api/drivers/attach", {
      method: "POST",
      body: JSON.stringify({
        projectRoot: currentProjectRoot,
        sessionId: selectedSessionId,
        harness,
        model: model ?? undefined,
        harnessSessionId,
        source: "gui-link",
      }),
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button
          className="btn btn-primary btn-block"
          disabled={!currentProjectRoot}
          onClick={() => setNewModalOpen(true)}
        >
          {t(locale, "newSession")}
        </button>
      </div>

      <div className="sidebar-section">
        <div className="section-label">{t(locale, "asdSessions")}</div>
        {sessions.map((s) => {
          const isSelected = s.session_id === selectedSessionId;
          const isFg = s.session_id === foregroundId;
          const sTasks = allTasks.filter((tk) => tk.session_id === s.session_id);
          const sDrivers = driversBySession[s.session_id] ?? [];

          return (
            <div
              key={s.session_id}
              className={`session-node ${isSelected ? "selected" : ""}`}
            >
              <div
                className="session-node-header"
                onClick={() => selectSession(s.session_id)}
              >
                <span className="session-id">{s.memo || s.session_id}</span>
                {isFg && (
                  <span className="fg-badge">
                    {t(locale, "foregroundBadge")}
                  </span>
                )}
              </div>
              <div className="session-meta-row">
                <span className="badge">{s.main_harness}</span>
                <span className="badge">{s.phase}</span>
                {!isFg && (
                  <button
                    className="btn-xs"
                    onClick={() => void handleSetForeground(s.session_id)}
                  >
                    ★
                  </button>
                )}
              </div>
              {isSelected && sDrivers.length > 0 && (
                <div className="driver-tree-list">
                  {sDrivers.map((drv) => (
                    <div key={drv.driver_id} className="driver-tree-item">
                      • {drv.harness}
                      {drv.model ? `/${drv.model}` : ""}{" "}
                      {drv.detached_at === null ? "(활성)" : ""}
                    </div>
                  ))}
                </div>
              )}
              {isSelected && sTasks.length > 0 && (
                <div className="task-tree-list">
                  {sTasks.map((tk) => (
                    <div
                      key={tk.task_id}
                      className="task-tree-item"
                      onClick={() => {
                        if (tk.sub_session_id) {
                          selectSubagent(tk.sub_session_id);
                        }
                      }}
                    >
                      [{tk.task_id}] {tk.assigned_harness ?? "-"} · {tk.status}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-section">
        <div className="section-label">{t(locale, "recentConversations")}</div>
        {cliRecent.map((item) => (
          <div key={item.harnessSessionId} className="recent-chat-card">
            <div
              className="recent-chat-summary"
              onClick={() => selectRecentChat(item.harnessSessionId)}
            >
              <span className="badge">{item.harness}</span>{" "}
              <span>{item.summary || item.harnessSessionId}</span>
            </div>
            {item.asdSessionId && (
              <div className="linked-badge">
                드라이버 · {item.asdSessionId}
              </div>
            )}
            <div className="recent-chat-actions">
              {selectedSessionId && (
                <button
                  className="btn-xs"
                  onClick={() =>
                    void handleLinkRecentAsDriver(
                      item.harness,
                      item.harnessSessionId,
                      item.model
                    )
                  }
                >
                  {t(locale, "linkAsDriver")}
                </button>
              )}
              {currentProjectRoot && (
                <button
                  className="btn-xs"
                  onClick={() =>
                    openPtyTab({
                      title: `${item.harness} (${item.harnessSessionId.slice(0, 8)})`,
                      projectRoot: currentProjectRoot,
                      harness: item.harness,
                      harnessSessionId: item.harnessSessionId,
                      model: item.model ?? undefined,
                    })
                  }
                >
                  {t(locale, "openTerminal")}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {newModalOpen && (
        <div className="modal-backdrop" onClick={() => setNewModalOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>{t(locale, "newSession")}</h3>
            <label className="form-field">
              <span>Harness</span>
              <select
                value={newHarness}
                onChange={(e) => setNewHarness(e.target.value as HarnessId)}
              >
                {HARNESS_LIST.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>Model</span>
              <input
                type="text"
                value={newModel}
                placeholder="(기본 모델)"
                onChange={(e) => setNewModel(e.target.value)}
              />
            </label>
            <label className="form-field">
              <span>Memo</span>
              <input
                type="text"
                value={newMemo}
                placeholder="작업 요약 메모"
                onChange={(e) => setNewMemo(e.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button
                className="btn btn-primary"
                onClick={() => void handleCreateSession()}
              >
                생성
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setNewModalOpen(false)}
              >
                {t(locale, "cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
