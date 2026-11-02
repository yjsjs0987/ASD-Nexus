// T5.1 — 라우팅 설정 패널: GET /api/projects/routing → PUT /api/projects/routing
// 반드시 config.agents 및 config.categories에만 바인딩한다 (구버전 화이트스크린 결함 2 재발 방지).
import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store";
import * as api from "../api.ts";
import type { GetProjectRoutingResponse, HarnessId } from "../../shared/protocol.ts";
import { RefreshIcon, SaveIcon, PlusIcon, TrashIcon } from "./Icons";
import { ModelPicker } from "./ModelPicker.tsx";

type RoutingConfig = GetProjectRoutingResponse["config"];
type AgentMap = RoutingConfig["agents"];
type AgentRoleKey = keyof AgentMap;
type RouteEntry = AgentMap[AgentRoleKey];

const AGENT_KEYS: AgentRoleKey[] = ["planner", "architect", "worker", "scout", "critic"];
const AGENT_LABEL: Record<AgentRoleKey, string> = {
  planner: "Planner (기획)",
  architect: "Architect (설계)",
  worker: "Worker (구현)",
  scout: "Scout (탐색)",
  critic: "Critic (검증)",
};

const HARNESS_LIST: HarnessId[] = ["claude-code", "opencode", "codex", "antigravity", "cursor"];
const HARNESS_LABEL: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  opencode: "OpenCode",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
};

function inferFamily(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("claude")) return "claude";
  if (m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("codex")) return "gpt";
  if (m.includes("gemini")) return "gemini";
  if (m.includes("glm")) return "glm";
  if (m.includes("deepseek")) return "deepseek";
  return "claude";
}

function defaultRouteEntry(): RouteEntry {
  return {
    harness: "claude-code",
    model: "claude-sonnet-4-5",
    modelFamily: "claude",
    fallbacks: [],
  };
}

function RouteEntryRow({
  label,
  badge,
  entry,
  catalog,
  onChange,
  onRemove,
}: {
  label: string;
  badge: string;
  entry: RouteEntry | undefined;
  catalog: Record<string, string[]>;
  onChange: (next: RouteEntry) => void;
  onRemove?: () => void;
}) {
  const current = entry ?? defaultRouteEntry();
  const harnessModels = catalog[current.harness] ?? [];

  const handleHarnessChange = (nextHarness: HarnessId) => {
    const candidateModels = catalog[nextHarness] ?? [];
    const nextModel = candidateModels[0] ?? current.model;
    onChange({
      ...current,
      harness: nextHarness,
      model: nextModel,
      modelFamily: inferFamily(nextModel),
    });
  };

  const handleModelChange = (nextModel: string) => {
    onChange({
      ...current,
      model: nextModel,
      modelFamily: inferFamily(nextModel),
    });
  };

  const handleEffortChange = (effort: string) => {
    const next: RouteEntry = {
      ...current,
      ...(effort ? { thinkingEffort: effort } : {}),
    };
    if (!effort) delete next.thinkingEffort;
    onChange(next);
  };

  return (
    <div className="asd-routing-entry">
      <div className="asd-routing-entry-head">
        <div className="asd-routing-title">
          <span className="tag">{badge}</span>
          <b>{label}</b>
        </div>
        <select
          className="asd-select"
          value={current.harness}
          onChange={(e) => handleHarnessChange(e.target.value as HarnessId)}
          aria-label={`${label} 하네스`}
        >
          {HARNESS_LIST.map((h) => (
            <option key={h} value={h}>
              {HARNESS_LABEL[h]}
            </option>
          ))}
        </select>
        <div className="asd-routing-model-wrap">
          <ModelPicker
            harness={current.harness}
            value={current.model}
            models={harnessModels}
            onChange={handleModelChange}
            ariaLabel={`${label} 모델`}
          />
        </div>
        <select
          className="asd-select"
          value={current.thinkingEffort ?? ""}
          onChange={(e) => handleEffortChange(e.target.value)}
          aria-label={`${label} 추론 강도`}
        >
          <option value="">추론 강도 (기본)</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
        <span className="tag" title="모델 패밀리">
          {current.modelFamily || inferFamily(current.model)}
        </span>
        {current.fallbacks?.length > 0 && (
          <span className="tag warn" title={current.fallbacks.map((f) => `${f.harness}:${f.model}`).join(", ")}>
            폴백 {current.fallbacks.length}
          </span>
        )}
        {onRemove && (
          <button type="button" className="icon" onClick={onRemove} aria-label={`${label} 카테고리 삭제`} title="삭제">
            <TrashIcon />
          </button>
        )}
      </div>
    </div>
  );
}

export default function RoutingConfigPanel() {
  const app = useApp();
  const projectRoot = app.projectRoot;
  const [config, setConfig] = useState<RoutingConfig | null>(() => app.snapshot?.routingConfig ?? null);
  const [hasLocalRouting, setHasLocalRouting] = useState<boolean>(() => app.snapshot?.hasLocalRouting ?? false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>(
    () => (app.snapshot?.availableModels as Record<string, string[]> | undefined) ?? {},
  );
  const [modelLoading, setModelLoading] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!projectRoot) return;
    void loadRouting();
  }, [projectRoot]);

  useEffect(() => {
    if (app.snapshot?.availableModels) {
      setModelCatalog((prev) => ({
        ...prev,
        ...(app.snapshot?.availableModels as Record<string, string[]>),
      }));
    }
  }, [app.snapshot?.availableModels]);

  async function loadRouting() {
    if (!projectRoot) return;
    setLoading(true);
    setError(null);
    try {
      const r = await api.getProjectRouting(projectRoot);
      setConfig(r.config);
      setHasLocalRouting(r.hasLocalRouting);
    } catch (e) {
      setError(api.errorText(e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshModels() {
    if (!projectRoot) return;
    setModelLoading(true);
    setError(null);
    try {
      const r = await api.getProjectModels(projectRoot, { forceRefresh: true });
      const normalized: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(r.models ?? {})) {
        normalized[k] = Array.isArray(v) ? v : [];
      }
      setModelCatalog(normalized);
      setNotice("하네스별 모델 카탈로그를 갱신했습니다.");
      setTimeout(() => setNotice(null), 2000);
    } catch (e) {
      setError(api.errorText(e));
    } finally {
      setModelLoading(false);
    }
  }

  function updateAgent(role: AgentRoleKey, entry: RouteEntry) {
    setConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        agents: {
          ...prev.agents,
          [role]: entry,
        },
      };
    });
  }

  function updateCategory(catKey: string, entry: RouteEntry) {
    setConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        categories: {
          ...prev.categories,
          [catKey]: entry,
        },
      };
    });
  }

  function handleAddCategory() {
    const trimmed = newCategoryName.trim();
    if (!trimmed || !config) return;
    setConfig({
      ...config,
      categories: {
        ...(config.categories ?? {}),
        [trimmed]: defaultRouteEntry(),
      },
    });
    setNewCategoryName("");
  }

  function handleRemoveCategory(catKey: string) {
    setConfig((prev) => {
      if (!prev) return prev;
      const nextCats = { ...(prev.categories ?? {}) };
      delete nextCats[catKey];
      return {
        ...prev,
        categories: nextCats,
      };
    });
  }

  async function handleSave() {
    if (!projectRoot || !config) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.putProjectRouting({
        projectRoot,
        action: "save",
        routingConfig: config,
      });
      setConfig(res.routingConfig);
      setHasLocalRouting(res.hasLocalRouting);
      setNotice("로컬 라우팅(.asd/routing.jsonc)에 저장했습니다.");
      setTimeout(() => setNotice(null), 2200);
    } catch (e) {
      setError(api.errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (!projectRoot) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.putProjectRouting({
        projectRoot,
        action: "reset",
      });
      setConfig(res.routingConfig);
      setHasLocalRouting(res.hasLocalRouting);
      setNotice("기본 라우팅 설정으로 복원했습니다.");
      setTimeout(() => setNotice(null), 2200);
    } catch (e) {
      setError(api.errorText(e));
    } finally {
      setSaving(false);
    }
  }

  const categoryEntries = useMemo(
    () => Object.entries(config?.categories ?? {}),
    [config?.categories],
  );

  if (!projectRoot) {
    return (
      <section className="card asd-placeholder">
        <p className="asd-dim">프로젝트를 먼저 여세요.</p>
      </section>
    );
  }

  return (
    <div className="asd-routing-panel">
      <section className="card asd-routing-card">
        <header className="card-ask">
          <div>
            <div className="ask-text">라우팅 설정 (routing.jsonc)</div>
            <p className="asd-dim" style={{ margin: "4px 0 0" }}>
              {hasLocalRouting
                ? "프로젝트 로컬 설정(.asd/routing.jsonc) 활성화됨"
                : "글로벌/기본 라우팅 사용 중 — 저장 시 프로젝트 로컬 설정 생성"}
            </p>
          </div>
          <div className="ask-tags" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" className="btn sm" onClick={() => void refreshModels()} disabled={modelLoading}>
              <RefreshIcon /> {modelLoading ? "모델 탐색 중…" : "모델 새로고침"}
            </button>
            {hasLocalRouting && (
              <button type="button" className="btn sm danger" onClick={() => void handleReset()} disabled={saving || loading}>
                기본값 복원
              </button>
            )}
            <button type="button" className="btn primary" onClick={() => void handleSave()} disabled={saving || loading || !config}>
              <SaveIcon /> {saving ? "저장 중…" : "라우팅 저장"}
            </button>
          </div>
        </header>

        {error && (
          <div className="asd-plan-status err" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="asd-plan-status ok" role="status">
            {notice}
          </div>
        )}

        {loading && !config ? (
          <div className="asd-dim" style={{ textAlign: "center", padding: 32 }}>
            라우팅 설정을 불러오는 중…
          </div>
        ) : (
          config && (
            <div className="card-body asd-routing-sections">
              <div className="asd-routing-section">
                <div className="asd-task-group-head">
                  <span className="tag ok">agents</span>
                  <b>에이전트 역할별 라우팅 ({AGENT_KEYS.length})</b>
                </div>
                <div className="asd-routing-list">
                  {AGENT_KEYS.map((roleKey) => (
                    <RouteEntryRow
                      key={roleKey}
                      badge={roleKey}
                      label={AGENT_LABEL[roleKey]}
                      entry={config.agents?.[roleKey]}
                      catalog={modelCatalog}
                      onChange={(next) => updateAgent(roleKey, next)}
                    />
                  ))}
                </div>
              </div>

              <div className="asd-routing-section">
                <div className="asd-task-group-head" style={{ justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="tag warn">categories</span>
                    <b>도메인 카테고리별 라우팅 ({categoryEntries.length})</b>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <input
                      type="text"
                      className="asd-input"
                      style={{ width: 160 }}
                      value={newCategoryName}
                      onChange={(e) => setNewCategoryName(e.target.value)}
                      placeholder="새 카테고리 ID"
                      aria-label="새 카테고리 ID"
                    />
                    <button
                      type="button"
                      className="btn sm"
                      onClick={handleAddCategory}
                      disabled={!newCategoryName.trim()}
                    >
                      <PlusIcon /> 추가
                    </button>
                  </div>
                </div>
                <div className="asd-routing-list">
                  {categoryEntries.map(([catKey, entry]) => (
                    <RouteEntryRow
                      key={catKey}
                      badge="cat"
                      label={catKey}
                      entry={entry}
                      catalog={modelCatalog}
                      onChange={(next) => updateCategory(catKey, next)}
                      onRemove={() => handleRemoveCategory(catKey)}
                    />
                  ))}
                </div>
              </div>
            </div>
          )
        )}
      </section>
    </div>
  );
}
