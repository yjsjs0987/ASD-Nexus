// T1.1 임시 스텁 — Elysium store.tsx(useApp)를 asd-gui 세션 모델로 치환한 최소 스토어.
// 세션 모델은 DashboardSnapshot/protocol.ts의 SessionRow에 맞춘다: sessionId, project_root(=작업 폴더),
// memo(=표시 제목의 원천), foregroundSessionId(=열려 있는 세션).
// T2.1(api/ws/events)과 T3.1(App 셸 + 정식 스토어)이 이 계약을 그대로 정식 구현한다.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** 세션 카드 한 장에 필요한 최소 정보 (SessionRow → 표시용 투영) */
export interface SessionInfo {
  /** SessionRow.session_id */
  id: string;
  /** 표시 제목 — 정식 스토어는 memo ?? session_id */
  title: string;
  /** SessionRow.project_root */
  workspaceDir: string | null;
  /** SessionRow.updated_at (ISO) */
  updatedAt: string;
}

interface AppCtx {
  sessions: SessionInfo[];
  /** 현재 열려 있는 세션. null이면 새 세션 화면 */
  foregroundSessionId: string | null;
  /** null이면 새 세션 화면으로 */
  openSession: (id: string | null) => void;
  deleteSession: (id: string) => Promise<void>;
  /** 작업(드라이버/잡)이 도는 중인 세션 id 목록 */
  busySessions: string[];
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppProvider missing");
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  // 서버가 원본(GUI_ARCHITECTURE 7장) — T3.1이 /api/projects·/ws state_updated로 채운다. 낙관적 갱신 없음.
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [foregroundSessionId, setForegroundSessionId] = useState<string | null>(null);
  const [busySessions] = useState<string[]>([]);

  const openSession = useCallback((id: string | null) => setForegroundSessionId(id), []);
  const deleteSession = useCallback(async (id: string) => {
    // 임시: 로컬 제거만. T3.1이 DELETE /api/sessions 호출로 대체.
    setSessions((xs) => xs.filter((x) => x.id !== id));
    setForegroundSessionId((cur) => (cur === id ? null : cur));
  }, []);

  const value = useMemo<AppCtx>(
    () => ({ sessions, foregroundSessionId, openSession, deleteSession, busySessions }),
    [sessions, foregroundSessionId, openSession, deleteSession, busySessions],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
