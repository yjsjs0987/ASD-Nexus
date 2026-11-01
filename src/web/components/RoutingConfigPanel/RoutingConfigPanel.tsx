import React, { useEffect, useState } from "react";
import type { AgentRole, HarnessId, RoutingConfig } from "agent-swarm-director";
import { apiFetch } from "../../api/client.ts";
import type {
  GetProjectRoutingResponse,
  PutProjectRoutingResponse,
} from "../../../shared/protocol.ts";
import { t } from "../../i18n/index.ts";
import { useAsdStore } from "../../store/useAsdStore.ts";

const ROLES: AgentRole[] = ["planner", "architect", "worker", "scout", "critic"];
const HARNESSES: HarnessId[] = [
  "claude-code",
  "codex",
  "opencode",
  "antigravity",
  "cursor",
];

export function RoutingConfigPanel(): React.ReactElement {
  const { locale, currentProjectRoot, snapshot, setErrorBanner } =
    useAsdStore();

  const [config, setConfig] = useState<RoutingConfig | null>(null);
  const [hasLocal, setHasLocal] = useState(false);

  useEffect(() => {
    if (!currentProjectRoot) return;
    apiFetch<GetProjectRoutingResponse>(
      `/api/projects/routing?projectRoot=${encodeURIComponent(currentProjectRoot)}`
    )
      .then((res) => {
        setConfig(res.config);
        setHasLocal(res.hasLocalRouting);
      })
      .catch((err: unknown) =>
        setErrorBanner(err instanceof Error ? err.message : String(err))
      );
  }, [currentProjectRoot, setErrorBanner]);

  if (!config) {
    return <div className="empty-state">라우팅 설정 불러오는 중...</div>;
  }

  const updateRoleRoute = (
    role: AgentRole,
    field: "harness" | "model",
    value: string
  ) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const curRole = prev.roles[role];
      return {
        ...prev,
        roles: {
          ...prev.roles,
          [role]: {
            ...curRole,
            [field]: value,
          },
        },
      };
    });
  };

  const handleSave = async (action: "save" | "reset") => {
    if (!currentProjectRoot) return;
    try {
      const res = await apiFetch<PutProjectRoutingResponse>(
        "/api/projects/routing",
        {
          method: "PUT",
          body: JSON.stringify({
            projectRoot: currentProjectRoot,
            action,
            routingConfig: action === "save" ? config : undefined,
          }),
        }
      );
      setConfig(res.routingConfig);
      setHasLocal(res.hasLocalRouting);
    } catch (err: unknown) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="routing-config-panel">
      <div className="plan-board-toolbar">
        <h3>
          {t(locale, "routingTab")}{" "}
          {hasLocal ? "(프로젝트 로컬 설정 활성)" : "(글로벌 기본값)"}
        </h3>
        <div className="toolbar-actions">
          <button
            className="btn btn-primary"
            onClick={() => void handleSave("save")}
          >
            {t(locale, "save")}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void handleSave("reset")}
          >
            기본값 초기화
          </button>
        </div>
      </div>

      <table className="routing-table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Primary Harness</th>
            <th>Model</th>
          </tr>
        </thead>
        <tbody>
          {ROLES.map((role) => {
            const route = config.roles[role];
            const modelsForHarness =
              snapshot?.availableModels?.[route.harness] ?? [];
            return (
              <tr key={role}>
                <td>
                  <strong>{role}</strong>
                </td>
                <td>
                  <select
                    value={route.harness}
                    onChange={(e) =>
                      updateRoleRoute(role, "harness", e.target.value)
                    }
                  >
                    {HARNESSES.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="text"
                    list={`models-${role}`}
                    value={route.model}
                    onChange={(e) =>
                      updateRoleRoute(role, "model", e.target.value)
                    }
                  />
                  <datalist id={`models-${role}`}>
                    {modelsForHarness.map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
