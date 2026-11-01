// T3.1 정식 스토어 — Elysium store.tsx(useApp)의 패턴(Provider + useApp 훅)을 유지하고
// 상태 모델을 asd-gui로 교체한다. 중심 모델은 DashboardSnapshot(agent-swarm-director 타입).
//
// 데이터 흐름 규칙(GUI_ARCHITECTURE.md 7장): 서버가 원본 — 낙관적 갱신 금지.
// 모든 쓰기 액션은 REST 호출만 하고, 확정은 ws.ts의 state_updated(전체 스냅샷)가 한다.
// WS 연결은 T2.1의 events.ts 훅(useWsStateUpdated)과 ws.ts 클라이언트로 담당한다.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as api from "./api.ts";
import type { DashboardSnapshot } from "../shared/protocol.ts";
import { getWsClient, initWsClient } from "./ws.ts";
import { useWsStateUpdated } from "./events.ts";

/** api.ts re-export에서 파생한 타입(별도 import 경로 추가 없이) */
export type ProjectSummary = api.GetProjectsResponse["projects"][number];
export type HarnessId = api.CreateSessionRequest["harness"];
/** 서버가 보강한 스냅샷(openProject/state_updated 공용): DashboardSnapshot + git/전경 정보 */
export type EnrichedSnapshot = api.OpenProjectResponse;
export type SessionRow = DashboardSnapshot["sessions"][number];

/** 세션 카드 한 장에 필요한 최소 정보 — SessionRail(T1.1 이식본)이 쓰는 계약 그대로 */
export interface SessionInfo {
  /** SessionRow.session_id */
  id: string;
  /** 표시 제목 — memo가 있으면 memo, 없으면 세션 ID */
  title: string;
  /** SessionRow.project_root (작업 폴더) */
  workspaceDir: string | null;
  /** SessionRow.updated_at (Unix ms → ISO) */
  updatedAt: string;
}

interface AppCtx {
  // ── 프로젝트 ──
  /** 현재 열린 프로젝트 루트. null이면 프로젝트 선택 화면 */
  projectRoot: string | null;
  /** ~/.asd/state 스캔으로 얻은 최근 프로젝트 목록 */
  projects: ProjectSummary[];
  /** 중심 모델: 서버가 확정한 대시보드 스냅샷(state_updated로 갈아끼워진다) */
  snapshot: EnrichedSnapshot | null;

  // ── 세션 (SessionRail 계약) ──
  sessions: SessionInfo[];
  /** 전경 세션 = PLAN.md 헤더의 세션(서버가 계산해 스냅샷에 실어 보낸다) */
  foregroundSessionId: string | null;
  /** 실행 중 태스크가 있는 세션 id 목록 */
  busySessions: string[];

  // ── UI 상태 ──
  /** 프로젝트 열기 등 서버 왕복 중 */
  loading: boolean;
  error: string | null;
  /** 도크의 새 세션(+) → 첫 화면(환영/생성 폼)을 보여준다. 서버 상태와 무관한 화면 상태 */
  newSessionMode: boolean;

  // ── 액션 ──
  refreshProjects: () => Promise<void>;
  /** 프로젝트 열기(api.openProject) → 스냅샷 로드 → WS 구독은 projectRoot 변경 효과가 한다 */
  openProject: (projectRoot: string) => Promise<void>;
  /** 프로젝트 선택 화면으로 돌아가기(WS 구독 해제 포함) */
  showProjectPicker: () => void;
  /**
   * id = 세션 → 서버에 전경 전환을 요청하고 state_updated가 확정한다(낙관적 갱신 없음).
   * id = null → 새 세션 화면(서버 호출 없음).
   */
  openSession: (id: string | null) => void;
  /** ASD v1에는 세션 삭제 엔드포인트가 없다 — SessionRail 계약 유지용 안내만 한다 */
  deleteSession: (id: string) => Promise<void>;
  /** 세션 생성(api.createSession, makeForeground 기본 true) */
  createSession: (req: { harness: HarnessId; memo?: string }) => Promise<string | null>;
  /** 메모 저장(api.saveSessionMemo) */
  saveMemo: (sessionId: string, memo: string) => Promise<void>;
  /** 세션 페이즈 전환(api.updateSessionPhase) */
  setPhase: (sessionId: string, phase: "paused" | "running" | "done") => Promise<void>;
  clearError: () => void;
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppProvider missing");
  return c;
}

/** WS 클라이언트는 앱 전체에서 한 번만 붙는다(StrictMode 재마운트 대비) */
let wsBooted = false;

export function AppProvider({ children }: { children: ReactNode }) {
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [snapshot, setSnapshot] = useState<EnrichedSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSessionMode, setNewSessionMode] = useState(false);

  const projectRef = useRef(projectRoot);
  projectRef.current = projectRoot;

  /** 다른 프로젝트의 state_updated는 무시하고 현재 프로젝트 것만 받는다 */
  const applySnapshot = useCallback((snap: EnrichedSnapshot) => {
    if (projectRef.current && snap.projectRoot !== projectRef.current) return;
    setSnapshot(snap);
  }, []);

  // T2.1 events.ts 훅: state_updated → 스냅샷 확정
  useWsStateUpdated(applySnapshot);

  // WS 연결(1회). 재연결되면 열려 있는 프로젝트의 전체 상태를 다시 동기화한다.
  useEffect(() => {
    if (wsBooted) return;
    wsBooted = true;
    initWsClient({
      onOpen: () => {
        const p = projectRef.current;
        if (!p) return;
        api
          .getSessionState(p)
          .then(applySnapshot)
          .catch(() => {
            /* 재동기화 실패는 다음 state_updated가 메운다 */
          });
      },
    }).connect();
  }, [applySnapshot]);

  // 프로젝트가 열리면 WS 구독. 서버는 구독 즉시 state_updated(전체 스냅샷)를 보낸다.
  useEffect(() => {
    const client = getWsClient();
    if (projectRoot) client.subscribeProject(projectRoot);
    return () => {
      if (projectRoot) client.unsubscribeProject(projectRoot);
    };
  }, [projectRoot]);

  // 첫 화면: 프로젝트 목록 조회
  useEffect(() => {
    api
      .getProjects()
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(api.errorText(e)));
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      const r = await api.getProjects();
      setProjects(r.projects);
    } catch (e) {
      setError(api.errorText(e));
    }
  }, []);

  const openProject = useCallback(
    async (root: string) => {
      setLoading(true);
      setError(null);
      try {
        const snap = await api.openProject(root);
        setProjectRoot(snap.projectRoot);
        setSnapshot(snap);
        setNewSessionMode(false);
      } catch (e) {
        setError(api.errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const showProjectPicker = useCallback(() => {
    setProjectRoot(null);
    setSnapshot(null);
    setNewSessionMode(false);
    void refreshProjects();
  }, [refreshProjects]);

  const openSession = useCallback((id: string | null) => {
    setNewSessionMode(id == null);
    if (id == null) return;
    const p = projectRef.current;
    if (!p) return;
    // 서버가 원본: 여기서 foreground를 고치지 않는다. state_updated가 확정한다.
    api.setForegroundSession({ projectRoot: p, sessionId: id }).catch((e) => setError(api.errorText(e)));
  }, []);

  const deleteSession = useCallback(async () => {
    // ASD v1의 24개 엔드포인트에는 세션 삭제가 없다. 계약 유지용 안내.
    setError("세션 삭제는 아직 지원하지 않습니다(서버 API 미구현).");
  }, []);

  const createSession = useCallback(async (req: { harness: HarnessId; memo?: string }) => {
    const p = projectRef.current;
    if (!p) {
      setError("먼저 프로젝트를 여세요.");
      return null;
    }
    try {
      const r = await api.createSession({ projectRoot: p, makeForeground: true, ...req });
      setNewSessionMode(false);
      return r.sessionId;
    } catch (e) {
      setError(api.errorText(e));
      return null;
    }
  }, []);

  const saveMemo = useCallback(async (sessionId: string, memo: string) => {
    const p = projectRef.current;
    if (!p) return;
    try {
      await api.saveSessionMemo({ projectRoot: p, sessionId, memo });
    } catch (e) {
      setError(api.errorText(e));
    }
  }, []);

  const setPhase = useCallback(async (sessionId: string, phase: "paused" | "running" | "done") => {
    const p = projectRef.current;
    if (!p) return;
    try {
      await api.updateSessionPhase({ projectRoot: p, sessionId, phase });
    } catch (e) {
      setError(api.errorText(e));
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // ── 파생 상태(전부 스냅샷에서 계산, 로컬 복사본 없음) ──
  const sessions = useMemo<SessionInfo[]>(() => {
    if (!snapshot) return [];
    return [...snapshot.sessions]
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((s) => ({
        id: s.session_id,
        title: s.memo?.trim() ? s.memo : s.session_id,
        workspaceDir: s.project_root,
        updatedAt: new Date(s.updated_at).toISOString(),
      }));
  }, [snapshot]);

  const foregroundSessionId = snapshot?.foregroundSessionId ?? null;

  const busySessions = useMemo(() => {
    const set = new Set<string>();
    for (const t of snapshot?.allTasks ?? []) {
      if (t.status === "running") set.add(t.session_id);
    }
    return [...set];
  }, [snapshot]);

  const value = useMemo<AppCtx>(
    () => ({
      projectRoot,
      projects,
      snapshot,
      sessions,
      foregroundSessionId,
      busySessions,
      loading,
      error,
      newSessionMode,
      refreshProjects,
      openProject,
      showProjectPicker,
      openSession,
      deleteSession,
      createSession,
      saveMemo,
      setPhase,
      clearError,
    }),
    [
      projectRoot,
      projects,
      snapshot,
      sessions,
      foregroundSessionId,
      busySessions,
      loading,
      error,
      newSessionMode,
      refreshProjects,
      openProject,
      showProjectPicker,
      openSession,
      deleteSession,
      createSession,
      saveMemo,
      setPhase,
      clearError,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
