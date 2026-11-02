// T3.1 정식 스토어 — Elysium store.tsx(useApp)의 패턴(Provider + useApp 훅)을 유지하고
// 상태 모델을 asd-gui로 교체한다. 중심 모델은 DashboardSnapshot(agent-swarm-director 타입).

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
import type {
  CliRecentSessionEntry,
  DashboardSnapshot,
  JobKind,
} from "../shared/protocol.ts";
import { getWsClient, initWsClient } from "./ws.ts";
import {
  useWsStateUpdated,
  useWsJobStarted,
  useWsJobProgress,
  useWsJobFinished,
} from "./events.ts";

export type ProjectSummary = api.GetProjectsResponse["projects"][number];
export type HarnessId = api.CreateSessionRequest["harness"];
export type EnrichedSnapshot = api.OpenProjectResponse;
export type SessionRow = DashboardSnapshot["sessions"][number];

export interface LiveJob {
  jobId: string;
  kind: JobKind;
  sessionId: string;
  runId?: string;
  startedAt: number;
  progress: { at: number; message: string }[];
  finished: { ok: boolean; error?: string; at: number } | null;
}

export interface SessionInfo {
  id: string;
  title: string;
  workspaceDir: string | null;
  updatedAt: string;
  phase?: string;
  harness?: string;
}

export interface OpenTerminalParams {
  title: string;
  cwd?: string;
  harness?: HarnessId;
  harnessSessionId?: string;
  model?: string;
  asDriverOf?: { sessionId: string; driverId: string };
}

interface AppCtx {
  // ── 프로젝트 ──
  projectRoot: string | null;
  projects: ProjectSummary[];
  snapshot: EnrichedSnapshot | null;

  // ── 세션 (SessionRail 계약) ──
  sessions: SessionInfo[];
  foregroundSessionId: string | null;
  busySessions: string[];

  // ── 일반 CLI 세션 및 드라이버 트랜스크립트 선택 ──
  activeCliSession: CliRecentSessionEntry | null;
  selectCliSession: (entry: CliRecentSessionEntry | null) => void;
  selectedDriverId: string | null;
  setSelectedDriverId: (driverId: string | null) => void;
  promoteCliSessionToAsd: (entry: CliRecentSessionEntry) => Promise<string | null>;
  attachCliSessionToCurrentAsd: (entry: CliRecentSessionEntry) => Promise<void>;

  // ── 하네스/모델 모달 & 모델 새로고침 ──
  showHarnessModal: boolean;
  setShowHarnessModal: (open: boolean) => void;
  refreshModels: () => Promise<void>;
  refreshSnapshot: () => Promise<void>;

  // ── UI 상태 ──
  loading: boolean;
  error: string | null;
  newSessionMode: boolean;

  // ── 작업 실행(T4.1) ──
  liveJob: LiveJob | null;
  lastPrompt: { sessionId: string; text: string; jobId?: string } | null;

  // ── T4.2 / T5.1: 선택된 작업 ID 및 Diff 모달 / 터미널 연동 ──
  selectedTaskId: string | null;
  setSelectedTaskId: (id: string | null) => void;
  showWorktreeDiff: boolean;
  openDiff: (taskId?: string) => void;
  closeDiff: () => void;
  openTerminalTab: (params: OpenTerminalParams) => void;
  registerTerminalOpener: (fn: ((params: OpenTerminalParams) => void) | null) => void;

  // ── 액션 ──
  refreshProjects: () => Promise<void>;
  openProject: (projectRoot: string) => Promise<void>;
  showProjectPicker: () => void;
  openSession: (id: string | null) => void;
  deleteSession: (id: string) => Promise<void>;
  createSession: (req: {
    harness: HarnessId;
    model?: string;
    memo?: string;
  }) => Promise<string | null>;
  saveMemo: (sessionId: string, memo: string) => Promise<void>;
  setPhase: (sessionId: string, phase: "paused" | "running" | "done") => Promise<void>;
  recordPrompt: (
    sessionId: string,
    text: string,
    jobId?: string,
    runId?: string,
  ) => void;
  reportError: (message: string) => void;
  clearError: () => void;
}

function isSameProjectPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppProvider missing");
  return c;
}

let wsBooted = false;

export function AppProvider({ children }: { children: ReactNode }) {
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [snapshot, setSnapshot] = useState<EnrichedSnapshot | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeCliSession, setActiveCliSession] = useState<CliRecentSessionEntry | null>(null);
  const [selectedDriverId, setSelectedDriverIdState] = useState<string | null>(null);
  const [showHarnessModal, setShowHarnessModal] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSessionMode, setNewSessionMode] = useState(false);
  const [liveJob, setLiveJob] = useState<LiveJob | null>(null);
  const [lastPrompt, setLastPrompt] = useState<{
    sessionId: string;
    text: string;
    jobId?: string;
  } | null>(null);
  const [selectedTaskId, setSelectedTaskIdState] = useState<string | null>(null);
  const [showWorktreeDiff, setShowWorktreeDiff] = useState(false);
  const terminalOpenerRef = useRef<((params: OpenTerminalParams) => void) | null>(null);

  const projectRef = useRef(projectRoot);
  projectRef.current = projectRoot;

  const selectedSessionRef = useRef(selectedSessionId);
  selectedSessionRef.current = selectedSessionId;
  const sessionSelectSeqRef = useRef(0);

  const applySnapshot = useCallback((snap: EnrichedSnapshot) => {
    if (
      projectRef.current &&
      !isSameProjectPath(snap.projectRoot, projectRef.current)
    ) {
      return;
    }
    setSnapshot(snap);
    setSelectedSessionId((prev) => {
      if (prev && snap.sessions.some((s) => s.session_id === prev)) {
        return prev;
      }
      return snap.foregroundSessionId ?? snap.session?.session_id ?? null;
    });
  }, []);

  useWsStateUpdated(applySnapshot);

  useWsJobStarted((p) => {
    if (
      projectRef.current &&
      !isSameProjectPath(p.projectRoot, projectRef.current)
    ) {
      return;
    }
    setLiveJob({
      jobId: p.jobId,
      kind: p.kind,
      sessionId: p.sessionId,
      runId: p.runId,
      startedAt: Date.now(),
      progress: [],
      finished: null,
    });
  });

  useWsJobProgress((jobId, message) => {
    setLiveJob((j) =>
      j && j.jobId === jobId
        ? { ...j, progress: [...j.progress.slice(-30), { at: Date.now(), message }] }
        : j,
    );
  });

  useWsJobFinished((p) => {
    setLiveJob((j) =>
      j && j.jobId === p.jobId
        ? { ...j, finished: { ok: p.ok, error: p.error, at: Date.now() } }
        : j,
    );
    const root = projectRef.current;
    if (root) {
      void api.getSessionState(root).then(applySnapshot).catch(() => {});
    }
  });

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
          .catch(() => {});
      },
    }).connect();
  }, [applySnapshot]);

  useEffect(() => {
    const client = getWsClient();
    if (projectRoot) client.subscribeProject(projectRoot);
    return () => {
      if (projectRoot) client.unsubscribeProject(projectRoot);
    };
  }, [projectRoot]);

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

  const refreshSnapshot = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const snap = await api.getSessionState(p);
      applySnapshot(snap);
    } catch (e) {
      setError(api.errorText(e));
    }
  }, [applySnapshot]);

  const refreshModels = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const res = await api.getProjectModels(p, true);
      setSnapshot((prev) =>
        prev ? { ...prev, availableModels: res.models } : prev,
      );
      const snap = await api.getSessionState(p);
      applySnapshot(snap);
    } catch (e) {
      setError(api.errorText(e));
    }
  }, [applySnapshot]);

  const openProject = useCallback(
    async (root: string) => {
      setLoading(true);
      setError(null);
      setLiveJob(null);
      setLastPrompt(null);
      setSelectedTaskIdState(null);
      setSelectedDriverIdState(null);
      setActiveCliSession(null);
      setShowWorktreeDiff(false);
      try {
        const snap = await api.openProject(root);
        setProjectRoot(snap.projectRoot);
        setSnapshot(snap);
        setSelectedSessionId(
          snap.foregroundSessionId ?? snap.session?.session_id ?? null,
        );
        setNewSessionMode(false);
        void refreshProjects();
      } catch (e) {
        setError(api.errorText(e));
      } finally {
        setLoading(false);
      }
    },
    [refreshProjects],
  );

  const showProjectPicker = useCallback(() => {
    setProjectRoot(null);
    setSnapshot(null);
    setSelectedSessionId(null);
    setActiveCliSession(null);
    setSelectedDriverIdState(null);
    setNewSessionMode(false);
    setLiveJob(null);
    setLastPrompt(null);
    setSelectedTaskIdState(null);
    setShowWorktreeDiff(false);
    void refreshProjects();
  }, [refreshProjects]);

  const openSession = useCallback(
    (id: string | null) => {
      const seq = ++sessionSelectSeqRef.current;
      setNewSessionMode(id == null);
      setActiveCliSession(null);
      setSelectedDriverIdState(null);
      setSelectedTaskIdState(null);
      if (id == null) return;
      setSelectedSessionId(id);
      const p = projectRef.current;
      if (!p) return;
      void api
        .setForegroundSession({ projectRoot: p, sessionId: id })
        .then(() => api.getSessionState(p))
        .then((snap) => {
          if (sessionSelectSeqRef.current !== seq) return;
          setSnapshot(snap);
          setSelectedSessionId(id);
        })
        .catch((e) => {
          if (sessionSelectSeqRef.current !== seq) return;
          setError(api.errorText(e));
        });
    },
    [],
  );

  const selectCliSession = useCallback((entry: CliRecentSessionEntry | null) => {
    setActiveCliSession(entry);
    if (entry) {
      setNewSessionMode(false);
      setSelectedDriverIdState(null);
      if (entry.asdSessionId) {
        setSelectedSessionId(entry.asdSessionId);
      }
    }
  }, []);

  const setSelectedDriverId = useCallback((driverId: string | null) => {
    setSelectedDriverIdState(driverId);
  }, []);

  const deleteSession = useCallback(async () => {
    setError("세션 삭제는 아직 지원하지 않습니다(서버 API 미구현).");
  }, []);

  const createSession = useCallback(
    async (req: { harness: HarnessId; model?: string; memo?: string }) => {
      const p = projectRef.current;
      if (!p) {
        setError("먼저 프로젝트를 여세요.");
        return null;
      }
      const seq = ++sessionSelectSeqRef.current;
      try {
        const r = await api.createSession({
          projectRoot: p,
          makeForeground: true,
          ...req,
        });
        setSelectedSessionId(r.sessionId);
        setActiveCliSession(null);
        setSelectedDriverIdState(null);
        setSelectedTaskIdState(null);
        setNewSessionMode(false);
        const snap = await api.getSessionState(p);
        if (sessionSelectSeqRef.current === seq) {
          setSnapshot(snap);
          setSelectedSessionId(r.sessionId);
        }
        return r.sessionId;
      } catch (e) {
        setError(api.errorText(e));
        return null;
      }
    },
    [],
  );

  const promoteCliSessionToAsd = useCallback(
    async (entry: CliRecentSessionEntry): Promise<string | null> => {
      const p = projectRef.current;
      if (!p) return null;
      try {
        const effectiveHarness: HarnessId = entry.harnessSessionId.startsWith(
          "ses_",
        )
          ? "opencode"
          : entry.harness;
        const memoText =
          entry.summary?.trim().slice(0, 75) ||
          `${effectiveHarness} (${entry.harnessSessionId.slice(0, 8)})`;
        const created = await api.createSession({
          projectRoot: p,
          harness: effectiveHarness,
          model: entry.model ?? undefined,
          memo: memoText,
          makeForeground: true,
        });
        await api.attachDriver({
          projectRoot: p,
          sessionId: created.sessionId,
          harness: effectiveHarness,
          model: entry.model ?? undefined,
          harnessSessionId: entry.harnessSessionId,
          source: "cli-asd",
        });
        setSelectedSessionId(created.sessionId);
        setActiveCliSession(null);
        setSelectedDriverIdState(null);
        setNewSessionMode(false);
        const snap = await api.getSessionState(p);
        setSnapshot(snap);
        setSelectedSessionId(created.sessionId);
        return created.sessionId;
      } catch (e) {
        setError(api.errorText(e));
        return null;
      }
    },
    [],
  );

  const attachCliSessionToCurrentAsd = useCallback(
    async (entry: CliRecentSessionEntry): Promise<void> => {
      const p = projectRef.current;
      const sid =
        selectedSessionRef.current ??
        snapshot?.foregroundSessionId ??
        snapshot?.session?.session_id ??
        null;
      if (!p) return;
      if (!sid) {
        await promoteCliSessionToAsd(entry);
        return;
      }
      try {
        const effectiveHarness: HarnessId = entry.harnessSessionId.startsWith(
          "ses_",
        )
          ? "opencode"
          : entry.harness;
        await api.attachDriver({
          projectRoot: p,
          sessionId: sid,
          harness: effectiveHarness,
          model: entry.model ?? undefined,
          harnessSessionId: entry.harnessSessionId,
          source: "cli-asd",
        });
        setActiveCliSession(null);
        setSelectedDriverIdState(null);
        const snap = await api.getSessionState(p);
        setSnapshot(snap);
      } catch (e) {
        setError(api.errorText(e));
      }
    },
    [promoteCliSessionToAsd, snapshot],
  );

  const saveMemo = useCallback(async (sessionId: string, memo: string) => {
    const p = projectRef.current;
    if (!p) return;
    try {
      await api.saveSessionMemo({ projectRoot: p, sessionId, memo });
      const snap = await api.getSessionState(p);
      setSnapshot(snap);
    } catch (e) {
      setError(api.errorText(e));
    }
  }, []);

  const setPhase = useCallback(
    async (sessionId: string, phase: "paused" | "running" | "done") => {
      const p = projectRef.current;
      if (!p) return;
      try {
        await api.updateSessionPhase({ projectRoot: p, sessionId, phase });
        const snap = await api.getSessionState(p);
        setSnapshot(snap);
      } catch (e) {
        setError(api.errorText(e));
      }
    },
    [],
  );

  const recordPrompt = useCallback(
    (sessionId: string, text: string, jobId?: string, runId?: string) => {
      setLastPrompt({ sessionId, text, jobId });
      if (jobId) {
        setLiveJob((prev) => {
          if (prev && prev.jobId === jobId) return prev;
          return {
            jobId,
            kind: text.startsWith("[적대적 토론]") ? "debate" : "driver_turn",
            sessionId,
            runId,
            startedAt: Date.now(),
            progress: [],
            finished: null,
          };
        });
      }
    },
    [],
  );

  const setSelectedTaskId = useCallback((id: string | null) => {
    setSelectedTaskIdState(id);
  }, []);

  const openDiff = useCallback((taskId?: string) => {
    if (taskId !== undefined) {
      setSelectedTaskIdState(taskId);
    }
    setShowWorktreeDiff(true);
  }, []);

  const closeDiff = useCallback(() => {
    setShowWorktreeDiff(false);
  }, []);

  const registerTerminalOpener = useCallback(
    (fn: ((params: OpenTerminalParams) => void) | null) => {
      terminalOpenerRef.current = fn;
    },
    [],
  );

  const openTerminalTab = useCallback((params: OpenTerminalParams) => {
    if (terminalOpenerRef.current) {
      terminalOpenerRef.current(params);
    }
  }, []);

  const reportError = useCallback((message: string) => setError(message), []);

  const clearError = useCallback(() => setError(null), []);

  const sessions = useMemo<SessionInfo[]>(() => {
    if (!snapshot) return [];
    return [...snapshot.sessions]
      .sort((a, b) => b.created_at - a.created_at)
      .map((s) => ({
        id: s.session_id,
        title: s.memo?.trim() ? s.memo : s.session_id,
        workspaceDir: s.project_root,
        updatedAt: new Date(s.updated_at || s.created_at).toISOString(),
        phase: s.phase,
        harness: s.main_harness,
      }));
  }, [snapshot]);

  const foregroundSessionId = useMemo(() => {
    if (
      selectedSessionId &&
      snapshot?.sessions.some((s) => s.session_id === selectedSessionId)
    ) {
      return selectedSessionId;
    }
    return (
      snapshot?.foregroundSessionId ?? snapshot?.session?.session_id ?? null
    );
  }, [selectedSessionId, snapshot]);

  const busySessions = useMemo(() => {
    const set = new Set<string>();
    for (const t of snapshot?.allTasks ?? []) {
      if (t.status === "running") set.add(t.session_id);
    }
    if (liveJob && !liveJob.finished && liveJob.sessionId) {
      set.add(liveJob.sessionId);
    }
    return [...set];
  }, [snapshot, liveJob]);

  const value = useMemo<AppCtx>(
    () => ({
      projectRoot,
      projects,
      snapshot,
      sessions,
      foregroundSessionId,
      busySessions,
      activeCliSession,
      selectCliSession,
      selectedDriverId,
      setSelectedDriverId,
      promoteCliSessionToAsd,
      attachCliSessionToCurrentAsd,
      showHarnessModal,
      setShowHarnessModal,
      refreshModels,
      refreshSnapshot,
      loading,
      error,
      newSessionMode,
      liveJob,
      lastPrompt,
      selectedTaskId,
      setSelectedTaskId,
      showWorktreeDiff,
      openDiff,
      closeDiff,
      openTerminalTab,
      registerTerminalOpener,
      refreshProjects,
      openProject,
      showProjectPicker,
      openSession,
      deleteSession,
      createSession,
      saveMemo,
      setPhase,
      recordPrompt,
      reportError,
      clearError,
    }),
    [
      projectRoot,
      projects,
      snapshot,
      sessions,
      foregroundSessionId,
      busySessions,
      activeCliSession,
      selectCliSession,
      selectedDriverId,
      setSelectedDriverId,
      promoteCliSessionToAsd,
      attachCliSessionToCurrentAsd,
      showHarnessModal,
      refreshModels,
      refreshSnapshot,
      loading,
      error,
      newSessionMode,
      liveJob,
      lastPrompt,
      selectedTaskId,
      setSelectedTaskId,
      showWorktreeDiff,
      openDiff,
      closeDiff,
      openTerminalTab,
      registerTerminalOpener,
      refreshProjects,
      openProject,
      showProjectPicker,
      openSession,
      deleteSession,
      createSession,
      saveMemo,
      setPhase,
      recordPrompt,
      reportError,
      clearError,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
