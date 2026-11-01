import React, { useEffect, useState } from "react";
import type { HarnessId } from "agent-swarm-director";
import { apiFetch } from "../../api/client.ts";
import type {
  GetResumeCommandResponse,
  GetTranscriptResponse,
  SubagentActionResponse,
  SubagentControlActionType,
} from "../../../shared/protocol.ts";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

export function SubagentInspector(): React.ReactElement {
  const {
    locale,
    currentProjectRoot,
    snapshot,
    selectedSessionId,
    selectedSubSessionId,
    logs,
    sendWs,
    openPtyTab,
    setErrorBanner,
  } = useAsdStore();

  const [tab, setTab] = useState<"log" | "transcript">("log");
  const [transcript, setTranscript] = useState<GetTranscriptResponse | null>(
    null
  );
  const [resumePrompt, setResumePrompt] = useState("");
  const [customHarness, setCustomHarness] = useState<HarnessId>("claude-code");
  const [customModel, setCustomModel] = useState("");
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const subLog = snapshot?.subagentLogs.find(
    (l) => l.subSessionId === selectedSubSessionId
  );
  const taskRow = (snapshot?.allTasks ?? []).find(
    (tk) =>
      tk.session_id === (subLog?.sessionId ?? selectedSessionId) &&
      tk.task_id === subLog?.taskId
  );

  useEffect(() => {
    if (!currentProjectRoot || !subLog) return;
    sendWs({
      type: "subscribe_log",
      projectRoot: currentProjectRoot,
      sessionId: subLog.sessionId,
      subSessionId: subLog.subSessionId,
      fromOffset: 0,
    });
    return () => {
      sendWs({
        type: "unsubscribe_log",
        projectRoot: currentProjectRoot,
        sessionId: subLog.sessionId,
        subSessionId: subLog.subSessionId,
      });
    };
  }, [currentProjectRoot, subLog?.sessionId, subLog?.subSessionId, sendWs]);

  useEffect(() => {
    if (
      tab !== "transcript" ||
      !currentProjectRoot ||
      !subLog?.harness ||
      !subLog?.harnessSessionId
    ) {
      return;
    }
    const qs = new URLSearchParams({
      projectRoot: currentProjectRoot,
      harness: subLog.harness,
      harnessSessionId: subLog.harnessSessionId,
      limit: "200",
    });
    apiFetch<GetTranscriptResponse>(`/api/transcripts?${qs.toString()}`)
      .then((res) => setTranscript(res))
      .catch((err: unknown) =>
        setErrorBanner(err instanceof Error ? err.message : String(err))
      );
  }, [
    tab,
    currentProjectRoot,
    subLog?.harness,
    subLog?.harnessSessionId,
    setErrorBanner,
  ]);

  if (!subLog) {
    return (
      <aside className="inspector-pane" data-testid="asd-inspector">
        <div className="panel-header">
          <strong>{t(locale, "subagentInspector")}</strong>
        </div>
        <div className="empty-state">
          태스크 카드나 서브에이전트를 선택하세요.
        </div>
      </aside>
    );
  }

  const logKey = `sub::${subLog.sessionId}::${subLog.subSessionId}`;
  const logEntry = logs[logKey];
  const isRunning = subLog.status === "running" || taskRow?.status === "running";

  const triggerAction = async (
    action: SubagentControlActionType,
    extra?: { prompt?: string; harness?: HarnessId; model?: string }
  ) => {
    if (!currentProjectRoot) return;
    try {
      await apiFetch<SubagentActionResponse>("/api/sessions/subagent-action", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: subLog.sessionId,
          subSessionId: subLog.subSessionId,
          action,
          ...extra,
        }),
      });
      if (action === "resume") {
        setResumePrompt("");
      }
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCopyResumeCmd = async () => {
    if (!subLog.harness || !subLog.harnessSessionId) return;
    try {
      const qs = new URLSearchParams({
        harness: subLog.harness,
        harnessSessionId: subLog.harnessSessionId,
        ...(subLog.model ? { model: subLog.model } : {}),
      });
      const res = await apiFetch<GetResumeCommandResponse>(
        `/api/transcripts/resume-command?${qs.toString()}`
      );
      await navigator.clipboard?.writeText(res.cliString);
      setCopiedCmd(res.cliString);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const resumeButtonLabel =
    taskRow?.status === "done"
      ? t(locale, "resumeAsFollowUp")
      : t(locale, "resumeSubagent");

  return (
    <aside className="inspector-pane" data-testid="asd-inspector">
      <div className="panel-header">
        <strong>{t(locale, "subagentInspector")}</strong>
        <span className={`status-pill status-${subLog.status}`}>
          {subLog.status}
        </span>
      </div>

      <div className="inspector-meta">
        <div>
          <strong>ID:</strong> {subLog.subSessionId}
        </div>
        <div>
          <strong>Task:</strong> {subLog.taskId || "-"} |{" "}
          <strong>Harness:</strong> {subLog.harness}/{subLog.model || "default"}
        </div>
        {subLog.harnessSessionId && (
          <div className="mono-small">
            SID: {subLog.harnessSessionId}
          </div>
        )}
      </div>

      <div className="inspector-actions">
        <button
          className="btn btn-danger btn-sm"
          disabled={!isRunning}
          onClick={() => void triggerAction("kill")}
        >
          {t(locale, "kill")}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => void triggerAction("retry")}
        >
          {t(locale, "retry")}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => void triggerAction("fallback")}
        >
          {t(locale, "fallback")}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => {
            if (!currentProjectRoot) return;
            openPtyTab({
              title: `Sub ${subLog.taskId || subLog.subSessionId}`,
              projectRoot: currentProjectRoot,
              cwd: taskRow?.worktree_path || currentProjectRoot,
              harness: subLog.harness,
              harnessSessionId: subLog.harnessSessionId ?? undefined,
              model: subLog.model ?? undefined,
            });
          }}
        >
          {t(locale, "openTerminal")}
        </button>
        {subLog.harnessSessionId && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void handleCopyResumeCmd()}
          >
            {t(locale, "copyResumeCmd")}
          </button>
        )}
      </div>

      {copiedCmd && (
        <div className="copied-cmd-box">
          <code>{copiedCmd}</code>
        </div>
      )}

      <div className="custom-exec-box">
        <select
          value={customHarness}
          onChange={(e) => setCustomHarness(e.target.value as HarnessId)}
        >
          <option value="claude-code">claude-code</option>
          <option value="codex">codex</option>
          <option value="opencode">opencode</option>
          <option value="antigravity">antigravity</option>
          <option value="cursor">cursor</option>
        </select>
        <input
          type="text"
          placeholder="Model (optional)"
          value={customModel}
          onChange={(e) => setCustomModel(e.target.value)}
        />
        <button
          className="btn btn-secondary btn-sm"
          onClick={() =>
            void triggerAction("custom", {
              harness: customHarness,
              model: customModel || undefined,
            })
          }
        >
          {t(locale, "customRun")}
        </button>
      </div>

      <div className="resume-box">
        <input
          type="text"
          placeholder="후속 지시 (Resume 프롬프트)..."
          value={resumePrompt}
          onChange={(e) => setResumePrompt(e.target.value)}
        />
        <button
          className="btn btn-primary btn-sm"
          disabled={isRunning || !subLog.harnessSessionId || !resumePrompt.trim()}
          onClick={() =>
            void triggerAction("resume", { prompt: resumePrompt.trim() })
          }
        >
          {resumeButtonLabel}
        </button>
      </div>

      <div className="inspector-tabs">
        <button
          className={`tab-btn ${tab === "log" ? "active" : ""}`}
          onClick={() => setTab("log")}
        >
          {t(locale, "liveLog")}
        </button>
        <button
          className={`tab-btn ${tab === "transcript" ? "active" : ""}`}
          onClick={() => setTab("transcript")}
        >
          {t(locale, "transcript")}
        </button>
      </div>

      {tab === "log" ? (
        <div className="inspector-log-view">
          {logEntry?.closed || (!isRunning && !logEntry?.text) ? (
            <div className="log-deleted-notice">
              {t(locale, "logDeletedNotice")}
            </div>
          ) : null}
          <pre className="log-pre">
            {logEntry?.text || subLog.tail || "(로그 대기 중...)"}
          </pre>
        </div>
      ) : (
        <div className="inspector-transcript-view">
          {!subLog.harnessSessionId ? (
            <div className="empty-state">기록된 하네스 세션 ID가 없습니다.</div>
          ) : !transcript ? (
            <div className="empty-state">불러오는 중...</div>
          ) : !transcript.found ? (
            <div className="empty-state">
              트랜스크립트를 찾을 수 없습니다 ({transcript.error ?? "not found"}).
            </div>
          ) : (
            transcript.messages.map((m, i) => (
              <div key={i} className={`msg-bubble role-${m.role}`}>
                <div className="msg-role">
                  {m.role} {m.toolName ? `[${m.toolName}]` : ""}
                </div>
                <div className="msg-text">{m.text}</div>
              </div>
            ))
          )}
        </div>
      )}
    </aside>
  );
}
