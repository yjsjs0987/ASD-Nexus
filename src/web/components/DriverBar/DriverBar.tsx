import React, { useState } from "react";
import type { HarnessId } from "agent-swarm-director";
import { apiFetch } from "../../api/client.ts";
import type {
  AttachDriverResponse,
  DriverRow,
  GetResumeCommandResponse,
} from "../../../shared/protocol.ts";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

const HARNESSES: HarnessId[] = [
  "claude-code",
  "codex",
  "opencode",
  "antigravity",
  "cursor",
];

export function DriverBar(): React.ReactElement | null {
  const {
    locale,
    currentProjectRoot,
    snapshot,
    driversBySession,
    selectedSessionId,
    openPtyTab,
    setErrorBanner,
  } = useAsdStore();

  const [switching, setSwitching] = useState(false);
  const [nextHarness, setNextHarness] = useState<HarnessId>("claude-code");
  const [nextModel, setNextModel] = useState("");
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  if (!selectedSessionId || !currentProjectRoot) {
    return null;
  }

  const drivers: DriverRow[] = driversBySession[selectedSessionId] ?? [];
  const activeDriver = drivers.find((d) => d.detached_at === null) ?? null;
  const pastDrivers = drivers.filter((d) => d.detached_at !== null);

  const handleSwitchDriver = async () => {
    try {
      await apiFetch<AttachDriverResponse>("/api/drivers/attach", {
        method: "POST",
        body: JSON.stringify({
          projectRoot: currentProjectRoot,
          sessionId: selectedSessionId,
          harness: nextHarness,
          model: nextModel.trim() || undefined,
          source: "gui-headless",
        }),
      });
      setSwitching(false);
      setNextModel("");
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOpenInteractive = () => {
    if (!activeDriver) return;
    openPtyTab({
      title: `Driver ${activeDriver.harness}`,
      projectRoot: currentProjectRoot,
      cwd: currentProjectRoot,
      harness: activeDriver.harness,
      harnessSessionId: activeDriver.harness_session_id ?? undefined,
      model: activeDriver.model ?? undefined,
      asDriverOf: {
        sessionId: selectedSessionId,
        driverId: activeDriver.driver_id,
      },
    });
  };

  const handleCopyResume = async () => {
    if (!activeDriver?.harness_session_id) return;
    try {
      const qs = new URLSearchParams({
        harness: activeDriver.harness,
        harnessSessionId: activeDriver.harness_session_id,
        ...(activeDriver.model ? { model: activeDriver.model } : {}),
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

  return (
    <div className="driver-bar" data-testid="driver-bar">
      <div className="driver-bar-main">
        <div>
          <strong>{t(locale, "activeDriver")}:</strong>{" "}
          {activeDriver ? (
            <span>
              <span className="harness-badge">{activeDriver.harness}</span>{" "}
              {activeDriver.model || "default"}{" "}
              <span className="mono-small">({activeDriver.source})</span>
            </span>
          ) : (
            <span className="muted">(드라이버 없음)</span>
          )}
          {pastDrivers.length > 0 && (
            <span className="past-drivers">
              {" "}
              | 이전:{" "}
              {pastDrivers
                .map((d) => `${d.harness}${d.model ? `/${d.model}` : ""}`)
                .join(", ")}
            </span>
          )}
        </div>

        <div className="driver-bar-actions">
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setSwitching((v) => !v)}
          >
            {t(locale, "switchDriver")} ▼
          </button>
          {activeDriver && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleOpenInteractive}
            >
              {t(locale, "openInteractive")}
            </button>
          )}
          {activeDriver?.harness_session_id && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void handleCopyResume()}
            >
              {t(locale, "copyResumeCmd")}
            </button>
          )}
        </div>
      </div>

      {copiedCmd && (
        <div className="copied-cmd-box">
          <code>{copiedCmd}</code>
        </div>
      )}

      {switching && (
        <div className="driver-switch-panel">
          <div className="briefing-notice">
            ℹ {t(locale, "switchDriverBriefingNotice")}
          </div>
          <div className="driver-switch-controls">
            <select
              value={nextHarness}
              onChange={(e) => setNextHarness(e.target.value as HarnessId)}
            >
              {HARNESSES.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            <input
              type="text"
              list="driver-models-list"
              placeholder="Model (optional)"
              value={nextModel}
              onChange={(e) => setNextModel(e.target.value)}
            />
            <datalist id="driver-models-list">
              {(snapshot?.availableModels?.[nextHarness] ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void handleSwitchDriver()}
            >
              교체 확정
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setSwitching(false)}
            >
              {t(locale, "cancel")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
