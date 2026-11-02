import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useApp, type HarnessId } from "../store.tsx";
import { HARNESS_ALL, HARNESS_LABEL } from "./DriverBar.tsx";

export interface ModelPickerProps {
  harness: HarnessId;
  value: string;
  onChange: (nextModel: string) => void;
  models?: string[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  ariaLabel?: string;
  style?: CSSProperties;
}

/**
 * Searchable model dropdown popover ported from `asd ui` (`src/cli/dashboard.ts`).
 * Unlike native `<datalist>`, clicking always reveals the full model list for the
 * selected harness, supports instant substring filtering, and allows custom model IDs.
 */
export function ModelPicker({
  harness,
  value,
  onChange,
  models: propModels,
  placeholder = "모델 선택 또는 직접 입력…",
  disabled = false,
  className = "",
  size = "sm",
  ariaLabel = "모델 선택",
  style,
}: ModelPickerProps) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const available = useMemo(() => {
    const raw = propModels ?? app.snapshot?.availableModels?.[harness] ?? [];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const item of raw) {
      const m = item?.trim();
      if (m && !seen.has(m)) {
        seen.add(m);
        list.push(m);
      }
    }
    return list;
  }, [propModels, app.snapshot?.availableModels, harness]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return available;
    return available.filter((m) => m.toLowerCase().includes(q));
  }, [available, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    const timer = setTimeout(() => {
      searchRef.current?.focus();
    }, 10);
    const onDocDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const selectModel = (m: string) => {
    onChange(m);
    setOpen(false);
  };

  const trimmedQuery = query.trim();
  const canUseCustom =
    trimmedQuery.length > 0 && !available.some((m) => m === trimmedQuery);

  return (
    <div
      ref={rootRef}
      style={style}
      className={`asd-model-picker ${size === "sm" ? "sm" : ""} ${className}`.trim()}
    >
      <button
        type="button"
        className={`asd-mp-btn ${size === "sm" ? "sm" : ""} ${open ? "open" : ""}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        title={value || placeholder}
      >
        <span className={`asd-mp-val ${!value ? "placeholder" : ""}`}>
          {value || placeholder}
        </span>
        <span className="asd-mp-count" title={`${HARNESS_LABEL[harness]} 모델 ${available.length}개`}>
          {available.length}
        </span>
        <span className="asd-mp-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="asd-mp-pop" role="listbox" aria-label={`${HARNESS_LABEL[harness]} 모델 목록`}>
          <div className="asd-mp-search-wrap">
            <input
              ref={searchRef}
              type="text"
              className="asd-mp-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (filtered.length > 0 && !canUseCustom) {
                    selectModel(filtered[0]);
                  } else if (trimmedQuery) {
                    selectModel(trimmedQuery);
                  }
                }
              }}
              placeholder={`${HARNESS_LABEL[harness]} 모델 검색 또는 직접 입력… (${available.length}개)`}
            />
          </div>

          <div className="asd-mp-list">
            {value && (
              <button
                type="button"
                className={`asd-mp-item ${value === "" ? "selected" : ""}`}
                onClick={() => selectModel("")}
              >
                <span className="asd-dim">(기본 모델 사용)</span>
              </button>
            )}
            {canUseCustom && (
              <button
                type="button"
                className="asd-mp-item custom"
                onClick={() => selectModel(trimmedQuery)}
              >
                <span>직접 지정: <code>{trimmedQuery}</code></span>
                <span className="tag">Enter</span>
              </button>
            )}
            {filtered.map((m) => (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === value}
                className={`asd-mp-item ${m === value ? "selected" : ""}`}
                onClick={() => selectModel(m)}
              >
                <code>{m}</code>
                {m === value && <span className="asd-mp-check">✓</span>}
              </button>
            ))}
            {filtered.length === 0 && !canUseCustom && (
              <div className="asd-mp-empty">
                탐지된 모델이 없습니다 — 위 입력창에 모델 ID를 직접 입력하거나 새로고침하세요.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 2x2 (+1) Harness Status & Available Models Inspector Modal from `asd ui` (`src/cli/dashboard.ts`).
 */
export function HarnessModelsModal({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const [filterByHarness, setFilterByHarness] = useState<Record<string, string>>({});

  const harnesses = app.snapshot?.harnesses ?? {};
  const availableModels = app.snapshot?.availableModels ?? ({} as Record<HarnessId, string[]>);

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await app.refreshModels();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      className="modal-back"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal asd-harness-modal" role="dialog" aria-label="하네스 및 사용 가능 모델 목록">
        <header className="asd-modal-head">
          <div>
            <h3>하네스 상태 및 사용 가능 모델</h3>
            <p className="asd-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>
              로컬 CLI 및 게이트웨이에서 실시간 탐지된 5대 하네스 상태와 모델 카탈로그입니다.
            </p>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn sm"
              disabled={refreshing}
              onClick={() => void handleRefresh()}
            >
              {refreshing ? "탐지 중…" : "🔄 모델 목록 새로고침"}
            </button>
            <button type="button" className="btn sm ghost" onClick={onClose}>
              닫기
            </button>
          </div>
        </header>

        <div className="asd-harness-grid">
          {HARNESS_ALL.map((h) => {
            const info = harnesses[h];
            const installed = Boolean(info?.installed);
            const headless = Boolean(info?.headlessSupported);
            const models = availableModels[h] ?? [];
            const q = (filterByHarness[h] ?? "").trim().toLowerCase();
            const shown = q
              ? models.filter((m) => m.toLowerCase().includes(q))
              : models;

            return (
              <div
                key={h}
                className={`card asd-harness-card ${installed ? "installed" : "missing"}`}
              >
                <div className="asd-harness-card-head">
                  <div className="row" style={{ gap: 6 }}>
                    <span className={`session-dot ${installed ? "ok" : ""}`} />
                    <b>{HARNESS_LABEL[h]}</b>
                    <code className="asd-dim">({h})</code>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    <span className={`tag ${installed ? "ok" : "err"}`}>
                      {installed ? "설치됨" : "미설치"}
                    </span>
                    {installed && (
                      <span className="tag">
                        {headless ? "Headless 지원" : "대화형 전용"}
                      </span>
                    )}
                    <span className="tag accent">{models.length}개 모델</span>
                  </div>
                </div>

                {info?.resolvedPath && (
                  <div className="asd-harness-path" title={info.resolvedPath}>
                    <code>{info.resolvedPath}</code>
                  </div>
                )}

                {models.length > 4 && (
                  <input
                    type="text"
                    className="asd-mp-search"
                    style={{ marginTop: 6, marginBottom: 4 }}
                    placeholder={`${HARNESS_LABEL[h]} 모델 필터…`}
                    value={filterByHarness[h] ?? ""}
                    onChange={(e) =>
                      setFilterByHarness((prev) => ({ ...prev, [h]: e.target.value }))
                    }
                  />
                )}

                <div className="asd-harness-models-box">
                  {shown.length > 0 ? (
                    shown.map((m) => (
                      <span
                        key={m}
                        className="asd-model-pill"
                        title="클릭하여 모델 ID 복사"
                        onClick={() => {
                          void navigator.clipboard?.writeText(m);
                        }}
                      >
                        {m}
                      </span>
                    ))
                  ) : (
                    <span className="asd-dim" style={{ fontSize: 12 }}>
                      {models.length === 0
                        ? "탐지된 모델 없음"
                        : "일치하는 모델 없음"}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default ModelPicker;
