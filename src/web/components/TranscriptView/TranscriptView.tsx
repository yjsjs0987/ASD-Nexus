import React, { useEffect, useState } from "react";
import { apiFetch } from "../../api/client.ts";
import type {
  DriverPromptResponse,
  DriverRow,
  GetTranscriptResponse,
  StartDebateResponse,
} from "../../../shared/protocol.ts";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

export function TranscriptView(): React.ReactElement {
  const {
    locale,
    currentProjectRoot,
    snapshot,
    driversBySession,
    selectedSessionId,
    selectedRecentHarnessSessionId,
    jobs,
    logs,
    setErrorBanner,
  } = useAsdStore();

  const [viewedDriverId, setViewedDriverId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<GetTranscriptResponse | null>(
    null
  );
  const [promptText, setPromptText] = useState("");
  const [showDebateForm, setShowDebateForm] = useState(false);
  const [debateTopic, setDebateTopic] = useState("");
  const [debateProposal, setDebateProposal] = useState("");

  const drivers: DriverRow[] =
    (selectedSessionId && driversBySession[selectedSessionId]) || [];
  const activeDriver = drivers.find((d) => d.detached_at === null) ?? null;
  const targetDriver =
    drivers.find((d) => d.driver_id === viewedDriverId) ?? activeDriver;

  const recentEntry = snapshot?.cliRecentSessions.find(
    (r) => r.harnessSessionId === selectedRecentHarnessSessionId
  );

  const runningDriverJob = Object.values(jobs).find(
    (j) =>
      j.kind === "driver_turn" &&
      j.sessionId === selectedSessionId &&
      j.status === "running"
  );

  useEffect(() => {
    setViewedDriverId(null);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!currentProjectRoot) return;

    const harness = recentEntry?.harness ?? targetDriver?.harness;
    const harnessSessionId =
      recentEntry?.harnessSessionId ?? targetDriver?.harness_session_id;
    const transcriptPath = recentEntry?.transcriptPath ?? undefined;

    if (!harness || !harnessSessionId) {
      setTranscript(null);
      return;
    }

    const qs = new URLSearchParams({
      projectRoot: currentProjectRoot,
      harness,
      harnessSessionId,
      limit: "200",
      ...(transcriptPath ? { transcriptPath } : {}),
    });

    apiFetch<GetTranscriptResponse>(`/api/transcripts?${qs.toString()}`)
      .then((res) => setTranscript(res))
      .catch((err: unknown) =>
        setErrorBanner(err instanceof Error ? err.message : String(err))
      );
  }, [
    currentProjectRoot,
    recentEntry?.harness,
    recentEntry?.harnessSessionId,
    recentEntry?.transcriptPath,
    targetDriver?.harness,
    targetDriver?.harness_session_id,
    runningDriverJob?.status,
    setErrorBanner,
  ]);

  const sendDriverPrompt = async (mode: "chat" | "plan") => {
    if (!currentProjectRoot || !selectedSessionId || !promptText.trim()) return;
    try {
      await apiFetch<DriverPromptResponse>("/api/drivers/prompt", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          prompt: promptText.trim(),
          mode,
        }),
      });
      setPromptText("");
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCancelTurn = async () => {
    if (!currentProjectRoot || !selectedSessionId || !runningDriverJob?.runId) {
      return;
    }
    try {
      await apiFetch("/api/drivers/cancel", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          runId: runningDriverJob.runId,
        }),
      });
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleStartDebate = async () => {
    if (
      !currentProjectRoot ||
      !selectedSessionId ||
      !debateTopic.trim() ||
      !debateProposal.trim()
    ) {
      return;
    }
    try {
      await apiFetch<StartDebateResponse>("/api/sessions/debate", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          topic: debateTopic.trim(),
          proposal: debateProposal.trim(),
        }),
      });
      setShowDebateForm(false);
      setDebateTopic("");
      setDebateProposal("");
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const liveRunLog =
    runningDriverJob?.runId && selectedSessionId
      ? logs[`drv::${selectedSessionId}::${runningDriverJob.runId}`]?.text
      : undefined;

  return (
    <div className="transcript-view" data-testid="transcript-view">
      {!recentEntry && drivers.length > 1 && (
        <div className="driver-history-selector">
          <span>대화 기록 드라이버 선택: </span>
          <select
            value={targetDriver?.driver_id ?? ""}
            onChange={(e) => setViewedDriverId(e.target.value || null)}
          >
            {drivers.map((d) => (
              <option key={d.driver_id} value={d.driver_id}>
                {d.harness} / {d.model || "default"}{" "}
                {d.detached_at === null ? "(활성)" : "(과거)"}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="transcript-messages">
        {!transcript ? (
          <div className="empty-state">
            {recentEntry || targetDriver?.harness_session_id
              ? "대화 기록을 불러오는 중..."
              : "아직 시작된 하네스 대화가 없습니다. 아래 입력창에서 첫 프롬프트를 보내세요."}
          </div>
        ) : !transcript.found ? (
          <div className="empty-state">
            원본 하네스 트랜스크립트 파일이 없습니다 ({transcript.error ?? "not found"}).
          </div>
        ) : (
          transcript.messages.map((m, idx) => (
            <div key={idx} className={`msg-bubble role-${m.role}`}>
              <div className="msg-role">
                <strong>{m.role}</strong>{" "}
                {m.toolName ? <code>[{m.toolName}]</code> : null}
              </div>
              <div className="msg-text">{m.text}</div>
            </div>
          ))
        )}

        {runningDriverJob && (
          <div className="live-driver-stream">
            <div className="stream-header">
              <span>⚡ 드라이버 실행 중...</span>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => void handleCancelTurn()}
              >
                {t(locale, "kill")}
              </button>
            </div>
            <pre className="log-pre">
              {liveRunLog || "(출력 대기 중...)"}
            </pre>
          </div>
        )}
      </div>

      {!recentEntry && selectedSessionId && (
        <div className="prompt-bar">
          {showDebateForm && (
            <div className="debate-inline-form">
              <input
                type="text"
                placeholder="디베이트 주제 (Topic)"
                value={debateTopic}
                onChange={(e) => setDebateTopic(e.target.value)}
              />
              <textarea
                rows={3}
                placeholder="검토할 제안 (Proposal)"
                value={debateProposal}
                onChange={(e) => setDebateProposal(e.target.value)}
              />
              <div className="editor-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleStartDebate()}
                >
                  디베이트 시작
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setShowDebateForm(false)}
                >
                  {t(locale, "cancel")}
                </button>
              </div>
            </div>
          )}

          <div className="prompt-input-row">
            <input
              type="text"
              placeholder={t(locale, "promptPlaceholder")}
              value={promptText}
              disabled={Boolean(runningDriverJob)}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendDriverPrompt("chat");
                }
              }}
            />
            <button
              className="btn btn-primary"
              disabled={Boolean(runningDriverJob) || !promptText.trim()}
              onClick={() => void sendDriverPrompt("chat")}
            >
              {t(locale, "sendPrompt")}
            </button>
            <button
              className="btn btn-secondary"
              disabled={Boolean(runningDriverJob) || !promptText.trim()}
              onClick={() => void sendDriverPrompt("plan")}
            >
              {t(locale, "generatePlan")}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setShowDebateForm((v) => !v)}
            >
              {t(locale, "startDebate")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
