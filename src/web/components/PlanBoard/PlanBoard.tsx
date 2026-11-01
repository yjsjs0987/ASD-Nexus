import React, { useState } from "react";
import type { TaskRow } from "agent-swarm-director";
import { apiFetch } from "../../api/client.ts";
import type { GetPlanMdResponse } from "../../../shared/protocol.ts";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

export function PlanBoard(): React.ReactElement {
  const {
    locale,
    currentProjectRoot,
    snapshot,
    selectedSessionId,
    selectSubagent,
    openDiffModal,
    setErrorBanner,
  } = useAsdStore();

  const [editingMd, setEditingMd] = useState(false);
  const [mdContent, setMdContent] = useState("");
  const [baseVersion, setBaseVersion] = useState(1);

  const sessionTasks: TaskRow[] = (snapshot?.allTasks ?? []).filter(
    (tk) => tk.session_id === selectedSessionId
  );

  const turns = Array.from(new Set(sessionTasks.map((tk) => tk.turn))).sort(
    (a, b) => a - b
  );

  const handleDispatchTurn = async (turn: number) => {
    if (!currentProjectRoot || !selectedSessionId) return;
    try {
      await apiFetch("/api/tasks/dispatch", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          turn,
        }),
      });
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOpenPlanEditor = async () => {
    if (!currentProjectRoot) return;
    try {
      const res = await apiFetch<GetPlanMdResponse>(
        `/api/tasks/plan-md?projectRoot=${encodeURIComponent(currentProjectRoot)}`
      );
      const sess = snapshot?.sessions.find(
        (s) => s.session_id === selectedSessionId
      );
      setMdContent(res.content);
      setBaseVersion(res.stateVersion ?? sess?.state_version ?? 1);
      setEditingMd(true);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSavePlanMd = async () => {
    if (!currentProjectRoot || !selectedSessionId) return;
    try {
      await apiFetch("/api/tasks/plan-md", {
        method: "PUT",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          content: mdContent,
          baseVersion,
        }),
      });
      setEditingMd(false);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="plan-board">
      <div className="plan-board-toolbar">
        <h3>PLAN Board {selectedSessionId ? `(${selectedSessionId})` : ""}</h3>
        <button
          className="btn btn-secondary"
          disabled={!currentProjectRoot || !selectedSessionId}
          onClick={() => void handleOpenPlanEditor()}
        >
          {t(locale, "editPlanMd")}
        </button>
      </div>

      {editingMd && (
        <div className="plan-md-editor">
          <textarea
            rows={14}
            value={mdContent}
            onChange={(e) => setMdContent(e.target.value)}
          />
          <div className="editor-actions">
            <button
              className="btn btn-primary"
              onClick={() => void handleSavePlanMd()}
            >
              {t(locale, "save")}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setEditingMd(false)}
            >
              {t(locale, "cancel")}
            </button>
          </div>
        </div>
      )}

      {turns.length === 0 ? (
        <div className="empty-state">등록된 태스크가 없습니다.</div>
      ) : (
        <div className="turns-container">
          {turns.map((turn) => {
            const turnTasks = sessionTasks.filter((tk) => tk.turn === turn);
            const prevTurnTasks = sessionTasks.filter((tk) => tk.turn < turn);
            const prevIncomplete = prevTurnTasks.some(
              (tk) => tk.status !== "done"
            );

            return (
              <div key={turn} className="turn-column">
                <div className="turn-header">
                  <strong>Turn {turn}</strong>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={
                      prevIncomplete || snapshot?.isGitRepo === false
                    }
                    onClick={() => void handleDispatchTurn(turn)}
                  >
                    {t(locale, "runTurn")}
                  </button>
                </div>
                <div className="turn-cards">
                  {turnTasks.map((tk) => (
                    <div
                      key={tk.task_id}
                      className={`task-card status-${tk.status}`}
                      onClick={() => {
                        if (tk.sub_session_id) {
                          selectSubagent(tk.sub_session_id);
                        }
                      }}
                    >
                      <div className="task-card-top">
                        <span className="task-id">{tk.task_id}</span>
                        <span className={`status-pill status-${tk.status}`}>
                          {t(locale, tk.status)}
                        </span>
                      </div>
                      <div className="task-title">{tk.title}</div>
                      <div className="task-meta">
                        <span>{tk.track}</span> · <span>{tk.role}</span> ·{" "}
                        <span>
                          {tk.assigned_harness ?? "-"}
                          {tk.assigned_model ? `/${tk.assigned_model}` : ""}
                        </span>
                      </div>
                      {tk.follow_up_of && (
                        <div className="followup-badge">
                          ↳ Follow-up of {tk.follow_up_of}
                        </div>
                      )}
                      {tk.status === "merge_conflict" && (
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDiffModal(tk.task_id);
                          }}
                        >
                          {t(locale, "resolveConflict")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
