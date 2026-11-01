// T1.1 임시 스텁 — Elysium lib/api.ts의 Tauri invoke 래퍼를 대체하는 최소 계약.
// T2.1이 protocol.ts(src/shared)의 24개 REST 엔드포인트로 정식 구현한다.
// 이식 컴포넌트(Markdown.tsx의 api.openUrl, SessionRail.tsx의 baseName)가 참조하는 것만 제공.

export interface ApiErrorEnvelopeLike {
  code?: string;
  message?: string;
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

/** 경로의 마지막 폴더 이름(세션 카드의 작업 폴더 표시) */
export function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export const api = {
  /** 웹 셸 단계에서는 새 탭으로 연다. T2.1/Tauri(T1.2) 이후 셸 열기로 대체 가능. */
  openUrl: (url: string): Promise<void> => {
    window.open(url, "_blank", "noopener");
    return Promise.resolve();
  },
};
