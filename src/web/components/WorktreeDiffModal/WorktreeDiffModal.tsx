import React, { useEffect, useState } from "react";
import { apiFetch } from "../../api/client.ts";
import type {
  ApproveTaskResponse,
  GetTaskDiffResponse,
  RejectTaskResponse,
  ResolveConflictResponse,
} from "../../../shared/protocol.ts";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

export function WorktreeDiffModal(): React.ReactElement | null {
  const {
    locale,
    currentProjectRoot,
    selectedSessionId,
    diffModalTaskId,
    openDiffModal,
    openPtyTab,
    setErrorBanner,
  } = useAsdStore();

  const [diffData, setDiffData] = useState<GetTaskDiffResponse | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!diffModalTaskId || !currentProjectRoot || !selectedSessionId) {
      setDiffData(null);
      return;
    }
    const qs = new URLSearchParams({
      projectRoot: currentProjectRoot,
      sessionId: selectedSessionId,
      taskId: diffModalTaskId,
    });
    apiFetch<GetTaskDiffResponse>(`/api/tasks/diff?${qs.toString()}`)
      .then((res) => setDiffData(res))
      .catch((err: unknown) =>
        setErrorBanner(err instanceof Error ? err.message : String(err))
      );
  }, [diffModalTaskId, currentProjectRoot, selectedSessionId, setErrorBanner]);

  if (!diffModalTaskId || !currentProjectRoot || !selectedSessionId) {
    return null;
  }

  const handleAiResolve = async () => {
    setBusy(true);
    try {
      await apiFetch<ResolveConflictResponse>("/api/tasks/resolve-conflict", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          taskId: diffModalTaskId,
          strategy: "ai",
        }),
      });
      openDiffModal(null);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenWtTerminal = () => {
    openPtyTab({
      title: `WT ${diffModalTaskId}`,
      projectRoot: currentProjectRoot,
      cwd: diffData?.targetDir || currentProjectRoot,
    });
    openDiffModal(null);
  };

  const handleApprove = async () => {
    setBusy(true);
    try {
      const res = await apiFetch<ApproveTaskResponse>("/api/tasks/approve", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          taskId: diffModalTaskId,
        }),
      });
      if (!res.ok) {
        setErrorBanner(res.error || "재검증 및 병합 실패");
      } else {
        openDiffModal(null);
      }
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    setBusy(true);
    try {
      await apiFetch<RejectTaskResponse>("/api/tasks/reject", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          taskId: diffModalTaskId,
        }),
      });
      openDiffModal(null);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" data-testid="worktree-diff-modal">
      <div className="modal-dialog modal-lg">
        <div className="modal-header">
          <h3>
            Worktree Diff — {diffModalTaskId}{" "}
            {diffData?.mode === "committed" && (
              <span className="status-pill status-merge_conflict">
                {t(locale, "committedDiffNotice")}
              </span>
            )}
          </h3>
          <button
            className="btn btn-sm"
            onClick={() => openDiffModal(null)}
          >
            ✕
          </button>
        </div>

        <div className="modal-body">
          {!diffData ? (
            <div className="empty-state">Diff 불러오는 중...</div>
          ) : (
            <>
              <div className="diff-meta">
                <div>
                  <strong>Path:</strong> <code>{diffData.targetDir}</code>
                </div>
                <div>
                  <strong>Changed Files ({diffData.changedFiles.length}):</strong>{" "}
                  {diffData.changedFiles.join(", ") || "(none)"}
                </div>
              </div>
              <pre className="diff-pre">
                {(diffData.diff || "(No diff output)")
                  .split("\n")
                  .map((line, idx) => {
                    let cls = "diff-line";
                    if (line.startsWith("+") && !line.startsWith("+++")) {
                      cls += " diff-add";
                    } else if (line.startsWith("-") && !line.startsWith("---")) {
                      cls += " diff-del";
                    } else if (line.startsWith("@@")) {
                      cls += " diff-hunk";
                    }
                    return (
                      <div key={idx} className={cls}>
                        {line}
                      </div>
                    );
                  })}
              </pre>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void handleAiResolve()}
          >
            {t(locale, "aiResolveConflict")}
          </button>
          <button
            className="btn btn-secondary"
            disabled={busy}
            onClick={handleOpenWtTerminal}
          >
            {t(locale, "openWorktreeTerminal")}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={() => void handleApprove()}
          >
            {t(locale, "reverifyAndMerge")}
          </button>
          <button
            className="btn btn-danger"
            disabled={busy}
            onClick={() => void handleReject()}
          >
            {t(locale, "rejectTask")}
          </button>
        </div>
      </div>
    </div>
  );
}
