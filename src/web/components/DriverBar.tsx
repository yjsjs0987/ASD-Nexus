// T5.1 — 드라이버 바(DriverBar): /api/drivers 목록 조회 + 드라이버/모델 교체(attach) + 실행 취소(cancel)
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import * as api from "../api.ts";
import type { DriverRow, HarnessId } from "../../shared/protocol.ts";
import { LinkIcon, TerminalIcon, StopIcon, RefreshIcon } from "./Icons";
import { ModelPicker } from "./ModelPicker.tsx";

export const HARNESS_ALL: HarnessId[] = [
  "claude-code",
  "opencode",
  "codex",
  "antigravity",
  "cursor",
];

export const HARNESS_LABEL: Record<HarnessId, string> = {
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
  migrated: "마이그레이션",
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
      const active =
        res.drivers.find((d) => d.driver_id === res.activeDriverId) ??
        res.drivers.find((d) => d.detached_at == null) ??
        res.drivers[0];
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
    () =>
      drivers.find((d) => d.driver_id === activeDriverId) ??
      drivers.find((d) => d.detached_at == null) ??
      null,
    [drivers, activeDriverId],
  );

  const isDriverRunning = Boolean(
    app.liveJob &&
      app.liveJob.sessionId === fgId &&
      app.liveJob.kind === "driver_turn" &&
      !app.liveJob.finished,
  );

  async function handleAttach(
    harness: HarnessId,
    model?: string,
    harnessSessionId?: string,
  ) {
    if (!projectRoot || !fgId) return;
    setBusy(true);
    try {
      const res = await api.attachDriver({
        projectRoot,
        sessionId: fgId,
        harness,
        ...(model !== undefined ? { model: model.trim() || undefined } : {}),
        ...(harnessSessionId?.trim()
          ? { harnessSessionId: harnessSessionId.trim() }
          : {}),
        source: "gui-headless",
      });
      setActiveDriverId(res.driver.driver_id);
      app.setSelectedDriverId(res.driver.driver_id);
      await loadDrivers();
      await app.refreshSnapshot();
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
    const h =
      (activeDriver?.harness as HarnessId | undefined) ?? selectedHarness;
    app.openTerminalTab({
      title: `Driver (${HARNESS_LABEL[h] ?? h})`,
      cwd: projectRoot,
      harness: h,
      harnessSessionId: activeDriver?.harness_session_id ?? undefined,
      model: activeDriver?.model ?? (selectedModel.trim() || undefined),
      ...(activeDriver
        ? { asDriverOf: { sessionId: fgId, driverId: activeDriver.driver_id } }
        : {}),
    });
  }

  if (!projectRoot || !fgId) return null;

  const isSameHarness = activeDriver?.harness === selectedHarness;

  return (
    <div className="asd-driver-bar" role="region" aria-label="드라이버 제어 바">
      <div className="asd-driver-bar-main">
        <span className={`tag ${activeDriver ? "ok" : "warn"}`}>
          {activeDriver
            ? `드라이버: ${HARNESS_LABEL[activeDriver.harness as HarnessId] ?? activeDriver.harness}`
            : "드라이버 미연결 (메시지 전송 시 자동 재연결)"}
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
        {isDriverRunning && <span className="tag warn">턴 실행 중</span>}

        <div className="spacer" />

        <select
          className="asd-select"
          value={selectedHarness}
          onChange={(e) => {
            const nextH = e.target.value as HarnessId;
            setSelectedHarness(nextH);
            const nextModels =
              (app.snapshot?.availableModels as Record<string, string[]> | undefined)?.[
                nextH
              ] ?? [];
            const matchingDrv = drivers.find((d) => d.harness === nextH);
            setSelectedModel(matchingDrv?.model ?? nextModels[0] ?? "");
          }}
          aria-label="교체할 드라이버 하네스"
        >
          {HARNESS_ALL.map((h) => {
            const installed = app.snapshot?.harnesses?.[h]?.installed !== false;
            return (
              <option key={h} value={h}>
                {HARNESS_LABEL[h]}
                {!installed ? " (미설치)" : ""}
              </option>
            );
          })}
        </select>

        <ModelPicker
          harness={selectedHarness}
          value={selectedModel}
          onChange={(nextModel) => {
            setSelectedModel(nextModel);
            if (activeDriver && activeDriver.harness === selectedHarness) {
              void handleAttach(
                selectedHarness,
                nextModel,
                activeDriver.harness_session_id ?? undefined,
              );
            }
          }}
          disabled={busy}
          ariaLabel="교체할 드라이버 모델"
        />

        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => {
            const existingHarnessSid = isSameHarness
              ? (activeDriver?.harness_session_id ?? undefined)
              : (drivers.find(
                  (d) => d.harness === selectedHarness && d.harness_session_id,
                )?.harness_session_id ??
                  app.snapshot?.cliRecentSessions?.find(
                    (c) =>
                      c.harness === selectedHarness &&
                      c.promotedAsdSessionId === fgId &&
                      c.harnessSessionId,
                  )?.harnessSessionId ??
                  undefined);
            void handleAttach(
              selectedHarness,
              selectedModel,
              existingHarnessSid,
            );
          }}
          title="선택한 하네스/모델로 활성 드라이버 적용"
        >
          <LinkIcon /> {activeDriver ? "드라이버 교체" : "드라이버 연결"}
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
          onClick={() => {
            void loadDrivers();
            void app.refreshModels();
          }}
          disabled={busy}
          aria-label="드라이버 및 모델 목록 새로고침"
          title="드라이버 및 모델 목록 새로고침"
        >
          <RefreshIcon />
        </button>
      </div>

      {expanded && drivers.length > 0 && (
        <div className="asd-driver-history">
          {drivers.map((d) => {
            const isAct = d.driver_id === activeDriverId || d.detached_at == null;
            const isSelected =
              (app.selectedDriverId ?? activeDriver?.driver_id) === d.driver_id;
            return (
              <div
                key={d.driver_id}
                className={`asd-driver-history-item${isAct ? " active" : ""}${isSelected ? " viewing" : ""}`}
              >
                <code>{d.driver_id}</code>
                <span className={`tag ${isAct ? "ok" : ""}`}>
                  {HARNESS_LABEL[d.harness as HarnessId] ?? d.harness}
                </span>
                {d.model && <span className="tag">{d.model}</span>}
                {d.harness_session_id && (
                  <code className="asd-dim" title={d.harness_session_id}>
                    sid:{d.harness_session_id.slice(0, 10)}
                  </code>
                )}
                <span className="asd-dim">
                  {SOURCE_LABEL[d.source] ?? d.source}
                </span>
                {d.detach_reason && (
                  <span className="asd-dim">해제: {d.detach_reason}</span>
                )}
                <div className="spacer" />
                {d.harness_session_id && (
                  <button
                    type="button"
                    className={`btn sm ${isSelected ? "primary" : "ghost"}`}
                    onClick={() => app.setSelectedDriverId(d.driver_id)}
                  >
                    대화 보기
                  </button>
                )}
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
