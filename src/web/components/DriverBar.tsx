// T5.1 — 드라이버 바(DriverBar): /api/drivers 목록 조회 + 드라이버 교체(attach) + 실행 취소(cancel)
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import * as api from "../api.ts";
import type { DriverRow, HarnessId } from "../../shared/protocol.ts";
import { LinkIcon, TerminalIcon, StopIcon, RefreshIcon } from "./Icons";

const HARNESS_ALL: HarnessId[] = ["claude-code", "opencode", "codex", "antigravity", "cursor"];
const HARNESS_LABEL: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
};

const SOURCE_LABEL: Record<string, string> = {
  "gui-headless": "GUI 헤드리스",
  "gui-link": "GUI 링크",
  "gui-pty": "GUI PTY",
  "cli-init": "CLI 초기",
  "cli-asd": "CLI ASD",
};

export default function DriverBar() {
  const app = useApp();
  const projectRoot = app.projectRoot;
  const fgId = app.foregroundSessionId;

  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [activeDriverId, setActiveDriverId] = useState<string | null>(null);
  const [selectedHarness, setSelectedHarness] = useState<HarnessId>("claude-code");
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const loadDrivers = useCallback(async () => {
    if (!projectRoot || !fgId) return;
    try {
      const res = await api.getDrivers(projectRoot, fgId);
      setDrivers(res.drivers);
      setActiveDriverId(res.activeDriverId);
      const active = res.drivers.find((d) => d.driver_id === res.activeDriverId) ?? res.drivers[0];
      if (active?.harness) {
        setSelectedHarness(active.harness as HarnessId);
        setSelectedModel(active.model ?? "");
      }
    } catch (e) {
      app.reportError(api.errorText(e));
    }
  }, [projectRoot, fgId, app.reportError]);

  useEffect(() => {
    if (!projectRoot || !fgId) {
      setDrivers([]);
      setActiveDriverId(null);
      return;
    }
    void loadDrivers();
  }, [projectRoot, fgId, app.snapshot?.timestamp, loadDrivers]);

  const activeDriver = useMemo(
    () => drivers.find((d) => d.driver_id === activeDriverId) ?? drivers.find((d) => d.detached_at == null) ?? null,
    [drivers, activeDriverId],
  );

  const isDriverRunning = Boolean(
    app.liveJob &&
      app.liveJob.sessionId === fgId &&
      app.liveJob.kind === "driver_turn" &&
      !app.liveJob.finished,
  );

  const harnessModels = useMemo(() => {
    const map = app.snapshot?.availableModels as Record<string, string[]> | undefined;
    return map?.[selectedHarness] ?? [];
  }, [app.snapshot?.availableModels, selectedHarness]);

  async function handleAttach(harness: HarnessId, model?: string, harnessSessionId?: string) {
    if (!projectRoot || !fgId) return;
    setBusy(true);
    try {
      const res = await api.attachDriver({
        projectRoot,
        sessionId: fgId,
        harness,
        ...(model?.trim() ? { model: model.trim() } : {}),
        ...(harnessSessionId?.trim() ? { harnessSessionId: harnessSessionId.trim() } : {}),
        source: "gui-headless",
      });
      setActiveDriverId(res.driver.driver_id);
      await loadDrivers();
    } catch (e) {
      app.reportError(api.errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    if (!projectRoot || !fgId) return;
    setBusy(true);
    try {
      await api.cancelDriver({
        projectRoot,
        sessionId: fgId,
        runId: app.liveJob?.runId ?? "active",
      });
    } catch (e) {
      app.reportError(api.errorText(e));
    } finally {
      setBusy(false);
    }
  }

  function handleOpenDriverPty() {
    if (!projectRoot || !fgId) return;
    const h = (activeDriver?.harness as HarnessId | undefined) ?? selectedHarness;
    app.openTerminalTab({
      title: `Driver (${HARNESS_LABEL[h] ?? h})`,
      cwd: projectRoot,
      harness: h,
      harnessSessionId: activeDriver?.harness_session_id ?? undefined,
      model: activeDriver?.model ?? (selectedModel.trim() || undefined),
      ...(activeDriver ? { asDriverOf: { sessionId: fgId, driverId: activeDriver.driver_id } } : {}),
    });
  }

  if (!projectRoot || !fgId) return null;

  return (
    <div className="asd-driver-bar" role="region" aria-label="드라이버 제어 바">
      <div className="asd-driver-bar-main">
        <span className={`tag ${activeDriver ? "ok" : "warn"}`}>
          {activeDriver
            ? `드라이버: ${HARNESS_LABEL[activeDriver.harness as HarnessId] ?? activeDriver.harness}`
            : "드라이버 미연결"}
        </span>
        {activeDriver?.model && (
          <code className="asd-driver-model" title="현재 연결된 드라이버 모델">
            {activeDriver.model}
          </code>
        )}
        {activeDriver && (
          <span className="tag" style={{ fontSize: 11 }}>
            {SOURCE_LABEL[activeDriver.source] ?? activeDriver.source}
          </span>
        )}
        {isDriverRunning && (
          <span className="tag warn">턴 실행 중</span>
        )}

        <div className="spacer" />

        <select
          className="asd-select"
          value={selectedHarness}
          onChange={(e) => {
            const nextH = e.target.value as HarnessId;
            setSelectedHarness(nextH);
            const nextModels = (app.snapshot?.availableModels as Record<string, string[]> | undefined)?.[nextH] ?? [];
            setSelectedModel(nextModels[0] ?? "");
          }}
          aria-label="교체할 드라이버 하네스"
        >
          {HARNESS_ALL.map((h) => (
            <option key={h} value={h}>
              {HARNESS_LABEL[h]}
            </option>
          ))}
        </select>

        <input
          type="text"
          className="asd-input asd-driver-model-input"
          list="driver-bar-models"
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          placeholder="모델 ID (선택)"
          aria-label="교체할 드라이버 모델"
        />
        <datalist id="driver-bar-models">
          {harnessModels.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>

        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => void handleAttach(selectedHarness, selectedModel)}
          title="선택한 하네스/모델로 활성 드라이버 교체"
        >
          <LinkIcon /> 드라이버 교체
        </button>

        <button
          type="button"
          className="btn sm"
          onClick={handleOpenDriverPty}
          title="활성 드라이버 대화형 PTY 터미널 열기"
        >
          <TerminalIcon /> PTY 연결
        </button>

        {isDriverRunning && (
          <button
            type="button"
            className="btn sm danger"
            disabled={busy}
            onClick={() => void handleCancel()}
            title="실행 중인 드라이버 턴 취소"
          >
            <StopIcon /> 실행 취소
          </button>
        )}

        <button
          type="button"
          className="btn sm ghost"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          이력 ({drivers.length})
        </button>

        <button
          type="button"
          className="btn sm ghost"
          onClick={() => void loadDrivers()}
          disabled={busy}
          aria-label="드라이버 목록 새로고침"
          title="드라이버 목록 새로고침"
        >
          <RefreshIcon />
        </button>
      </div>

      {expanded && drivers.length > 0 && (
        <div className="asd-driver-history">
          {drivers.map((d) => {
            const isAct = d.driver_id === activeDriverId || d.detached_at == null;
            return (
              <div key={d.driver_id} className={`asd-driver-history-item${isAct ? " active" : ""}`}>
                <code>{d.driver_id}</code>
                <span className={`tag ${isAct ? "ok" : ""}`}>
                  {HARNESS_LABEL[d.harness as HarnessId] ?? d.harness}
                </span>
                {d.model && <span className="tag">{d.model}</span>}
                <span className="asd-dim">{SOURCE_LABEL[d.source] ?? d.source}</span>
                {d.detach_reason && <span className="asd-dim">해제 사유: {d.detach_reason}</span>}
                <div className="spacer" />
                {!isAct && (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={busy}
                    onClick={() =>
                      void handleAttach(
                        d.harness as HarnessId,
                        d.model ?? undefined,
                        d.harness_session_id ?? undefined,
                      )
                    }
                  >
                    <LinkIcon /> 다시 연결
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
