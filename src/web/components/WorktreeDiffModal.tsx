// T5.1 — 작업 카드(Diff) 모달: /api/tasks/diff(mode: working/committed) 표시
// approve/reject는 merge_conflict 전용(409 안내 포함) 및 서버 closeTabsInPath 플로우 유발
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import * as api from "../api.ts";
import type { GetTaskDiffResponse } from "../../shared/protocol.ts";
import { TerminalIcon, CheckIcon, XIcon, CopyIcon, RefreshIcon, SparkIcon } from "./Icons";

const DIFF_LINES_LIMIT = 800;

interface ParsedFileDiff {
  header: string;
  lines: string[];
}

function parseUnifiedDiff(rawDiff: string): ParsedFileDiff[] {
  if (!rawDiff || !rawDiff.trim()) return [];
  const chunks = rawDiff.split(/^diff --git /m).filter(Boolean);
  if (chunks.length === 0) {
    return [{ header: "변경 사항", lines: rawDiff.split(/\r?\n/) }];
  }
  return chunks.map((chunk) => {
    const rawLines = (`diff --git ${chunk}`).split(/\r?\n/);
    const firstLine = rawLines[0] ?? "";
    const match = firstLine.match(/b\/(.+)$/);
    const header = match ? match[1] : firstLine;
    return { header, lines: rawLines };
  });
}

export default function WorktreeDiffModal() {
  const app = useApp();
  const show = app.showWorktreeDiff;
  const fgId = app.foregroundSessionId;
  const projectRoot = app.projectRoot;

  const sessionTasks = useMemo(
    () => (app.snapshot?.allTasks ?? []).filter((t) => t.session_id === fgId),
    [app.snapshot, fgId],
  );

  const activeTaskId = app.selectedTaskId ?? sessionTasks[0]?.task_id ?? null;
  const task = useMemo(
    () => sessionTasks.find((t) => t.task_id === activeTaskId) ?? null,
    [sessionTasks, activeTaskId],
  );

  const [diff, setDiff] = useState<GetTaskDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [viewMode, setViewMode] = useState<"working" | "committed">("working");
  const [smokeCmd, setSmokeCmd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadDiff = async (targetTaskId: string | null) => {
    if (!projectRoot || !fgId || !targetTaskId) return;
    setLoading(true);
    setError(null);
    try {
      const d = await api.getTaskDiff({ projectRoot, sessionId: fgId, taskId: targetTaskId });
      setDiff(d);
      setViewMode(d.mode ?? (task?.status === "merge_conflict" ? "committed" : "working"));
    } catch (e) {
      setError(api.errorText(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!show || !activeTaskId || !projectRoot || !fgId) return;
    void loadDiff(activeTaskId);
  }, [show, activeTaskId, projectRoot, fgId]);

  useEffect(() => {
    if (!show) {
      setDiff(null);
      setError(null);
      setCopied(false);
      setSmokeCmd("");
    }
  }, [show]);

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        app.closeDiff();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [show, app.closeDiff]);

  if (!show) return null;

  const isMergeConflict = task?.status === "merge_conflict";
  const parsedFiles = parseUnifiedDiff(diff?.diff ?? "");

  async function handleApprove() {
    if (!projectRoot || !fgId || !activeTaskId) return;
    setActing(true);
    setError(null);
    try {
      const res = await api.approveTask({
        projectRoot,
        sessionId: fgId,
        taskId: activeTaskId,
        ...(smokeCmd.trim() ? { smokeCmd: smokeCmd.trim() } : {}),
      });
      if (!res.ok) {
        setError(res.error ?? "병합 승인에 실패했습니다.");
        return;
      }
      app.closeDiff();
    } catch (e) {
      const msg = api.errorText(e);
      setError(msg);
      app.reportError(msg);
    } finally {
      setActing(false);
    }
  }

  async function handleReject() {
    if (!projectRoot || !fgId || !activeTaskId) return;
    setActing(true);
    setError(null);
    try {
      await api.rejectTask({ projectRoot, sessionId: fgId, taskId: activeTaskId });
      app.closeDiff();
    } catch (e) {
      const msg = api.errorText(e);
      setError(msg);
      app.reportError(msg);
    } finally {
      setActing(false);
    }
  }

  async function handleResolveAi() {
    if (!projectRoot || !fgId || !activeTaskId) return;
    setActing(true);
    setError(null);
    try {
      await api.resolveConflict({
        projectRoot,
        sessionId: fgId,
        taskId: activeTaskId,
        strategy: "ai",
      });
      app.closeDiff();
    } catch (e) {
      const msg = api.errorText(e);
      setError(msg);
      app.reportError(msg);
    } finally {
      setActing(false);
    }
  }

  function handleOpenTerminal() {
    if (!projectRoot || !activeTaskId) return;
    const targetDir = diff?.targetDir || task?.worktree_path || projectRoot;
    app.openTerminalTab({
      title: `WT ${activeTaskId}`,
      cwd: targetDir,
    });
    app.closeDiff();
  }

  async function copyDiff() {
    if (!diff?.diff) return;
    await navigator.clipboard.writeText(diff.diff);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && app.closeDiff()}>
      <div className="modal wide asd-diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title">
        <div className="modal-head">
          <h2 id="diff-title" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="tag work">Worktree Diff</span>
            {sessionTasks.length > 1 ? (
              <select
                className="asd-select"
                value={activeTaskId ?? ""}
                onChange={(e) => app.setSelectedTaskId(e.target.value)}
                aria-label="태스크 선택"
              >
                {sessionTasks.map((t) => (
                  <option key={t.task_id} value={t.task_id}>
                    {t.task_id} ({t.status}) — {t.title}
                  </option>
                ))}
              </select>
            ) : (
              task && <code>{task.task_id}</code>
            )}
            {task && <span className={`tag ${isMergeConflict ? "asd-tag-err" : ""}`}>{task.status}</span>}
          </h2>
          <button className="icon" onClick={app.closeDiff} aria-label="닫기">
            <XIcon />
          </button>
        </div>

        {error && (
          <div className="approval asd-diff-error" role="alert">
            <div className="approval-head" style={{ color: "var(--err)" }}>오류 (409 / API 응답)</div>
            <p>{error}</p>
          </div>
        )}

        <div className="asd-diff-toolbar">
          <div className="seg" role="radiogroup" aria-label="Diff 모드">
            <button
              type="button"
              className={viewMode === "working" ? "on" : ""}
              onClick={() => setViewMode("working")}
              role="radio"
              aria-checked={viewMode === "working"}
            >
              작업 트리 (working)
            </button>
            <button
              type="button"
              className={viewMode === "committed" ? "on" : ""}
              onClick={() => setViewMode("committed")}
              role="radio"
              aria-checked={viewMode === "committed"}
            >
              커밋 베이스 (committed)
            </button>
          </div>
          {diff && (
            <span className="tag" title={diff.targetDir}>
              서버 모드: <b>{diff.mode}</b>
              {diff.baseRef ? ` · base ${diff.baseRef.slice(0, 7)}` : ""}
            </span>
          )}
          <div className="spacer" />
          <button
            type="button"
            className="btn sm"
            onClick={() => void loadDiff(activeTaskId)}
            disabled={loading || !activeTaskId}
          >
            <RefreshIcon /> 새로고침
          </button>
          <button type="button" className="btn sm" onClick={() => void copyDiff()} disabled={!diff?.diff}>
            <CopyIcon /> {copied ? "복사됨" : "Diff 복사"}
          </button>
          <button type="button" className="btn sm" onClick={handleOpenTerminal} title="워크트리 터미널 열기">
            <TerminalIcon /> 워크트리 터미널
          </button>
        </div>

        {diff && diff.changedFiles.length > 0 && (
          <div className="asd-diff-files-bar">
            <span className="asd-dim">변경 파일 ({diff.changedFiles.length}):</span>
            {diff.changedFiles.map((f) => (
              <code key={f} className="tag">
                {f}
              </code>
            ))}
          </div>
        )}

        <div className="asd-diff-content">
          {loading ? (
            <div className="asd-dim" style={{ textAlign: "center", padding: 40 }}>
              Diff를 불러오는 중…
            </div>
          ) : !diff || (parsedFiles.length === 0 && !diff.statusShort) ? (
            <div className="asd-dim" style={{ textAlign: "center", padding: 40 }}>
              변경 사항이 없습니다 ({diff?.exists === false ? "워크트리 없음" : "깨끗한 상태"}).
            </div>
          ) : (
            parsedFiles.map((file, idx) => (
              <div key={idx} className="asd-diff-file">
                <div className="asd-diff-file-header">
                  <code>{file.header}</code>
                  <span className="tag">{viewMode}</span>
                </div>
                <pre className="asd-diff-hunk-body">
                  {file.lines.slice(0, DIFF_LINES_LIMIT).map((line, lineIdx) => {
                    const isAdd = line.startsWith("+") && !line.startsWith("+++");
                    const isDel = line.startsWith("-") && !line.startsWith("---");
                    const isHunk = line.startsWith("@@");
                    return (
                      <div
                        key={lineIdx}
                        className={`asd-diff-line${isAdd ? " add" : isDel ? " del" : isHunk ? " hunk" : ""}`}
                      >
                        {line || " "}
                      </div>
                    );
                  })}
                  {file.lines.length > DIFF_LINES_LIMIT && (
                    <div className="asd-dim" style={{ textAlign: "center", padding: 8 }}>
                      … {file.lines.length - DIFF_LINES_LIMIT}줄 생략
                    </div>
                  )}
                </pre>
              </div>
            ))
          )}
        </div>

        <div className="modal-foot asd-diff-foot">
          {!isMergeConflict ? (
            <p className="asd-dim" style={{ margin: 0, flex: 1 }}>
              안내: 재검증·병합(승인) 및 반려는 <code>merge_conflict</code> 상태의 태스크 전용입니다 (현재 상태:{" "}
              <code>{task?.status ?? "없음"}</code> — 호출 시 409 CONFLICT 반환).
            </p>
          ) : (
            <input
              type="text"
              className="asd-input"
              style={{ flex: 1 }}
              value={smokeCmd}
              onChange={(e) => setSmokeCmd(e.target.value)}
              placeholder="선택적 스모크 검증 명령어 (예: npm test)"
              aria-label="스모크 검증 명령어"
            />
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              type="button"
              className="btn sm"
              onClick={() => void handleResolveAi()}
              disabled={acting || loading || !isMergeConflict}
              title="AI 서브에이전트로 병합 충돌 자동 해결"
            >
              <SparkIcon size={14} /> AI 충돌 해결
            </button>
            <button
              type="button"
              className="btn danger solid"
              onClick={() => void handleReject()}
              disabled={acting || loading || !isMergeConflict}
              title="워크트리 탭을 닫고(closeTabsInPath) 변경사항을 반려합니다"
            >
              <XIcon /> 반려 (Reject)
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void handleApprove()}
              disabled={acting || loading || !isMergeConflict}
              title="워크트리 탭을 닫고(closeTabsInPath) 재검증 후 병합합니다"
            >
              <CheckIcon /> 승인·병합 (Approve)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
