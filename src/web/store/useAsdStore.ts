/**
 * Zustand store for ASD GUI (src/web/store/useAsdStore.ts) — GUI_ARCHITECTURE.md 7.4.
 */

import { create } from "zustand";
import type {
  KnownProjectSummary,
  TaskStatus,
} from "agent-swarm-director";
import type {
  DriverRow,
  JobKind,
  OpenProjectResponse,
  ServerWsMessage,
} from "../../shared/protocol.ts";
import {
  apiFetch,
  connectGuiWebSocket,
  fetchProjects,
  openProject as apiOpenProject,
} from "../api/client.ts";
import { type Locale, resolveLocale } from "../i18n/index.ts";

export interface JobState {
  jobId: string;
  kind: JobKind;
  projectRoot: string;
  sessionId: string;
  taskIds?: string[];
  runId?: string;
  status: "running" | "done" | "failed";
  progressMessages: string[];
  error?: string;
}

export interface ToastNotice {
  id: string;
  taskId?: string;
  status?: TaskStatus;
  message: string;
  createdAt: number;
}

export interface PtyTabState {
  tabId: string;
  title: string;
  projectRoot: string;
  cwd?: string;
  harness?: string;
  harnessSessionId?: string;
  model?: string;
  asDriverOf?: { sessionId: string; driverId: string };
  exited?: boolean;
  exitCode?: number;
  error?: string;
}

export type CenterTab = "chat" | "plan" | "routing" | `pty:${string}`;

export interface AsdGuiStoreState {
  locale: Locale;
  wsConnected: boolean;
  projects: KnownProjectSummary[];
  currentProjectRoot: string | null;
  snapshot: OpenProjectResponse | null;
  driversBySession: Record<string, DriverRow[]>;
  selectedSessionId: string | null;
  selectedSubSessionId: string | null;
  selectedRecentHarnessSessionId: string | null;
  activeCenterTab: CenterTab;
  jobs: Record<string, JobState>;
  logs: Record<string, { offset: number; text: string; closed?: boolean }>;
  ptyTabs: PtyTabState[];
  ptyBuffers: Record<string, string>;
  toasts: ToastNotice[];
  diffModalTaskId: string | null;
  errorBanner: string | null;

  setLocale: (locale: Locale) => void;
  setActiveCenterTab: (tab: CenterTab) => void;
  selectSession: (sessionId: string | null) => void;
  selectSubagent: (subSessionId: string | null) => void;
  selectRecentChat: (harnessSessionId: string | null) => void;
  openDiffModal: (taskId: string | null) => void;
  dismissToast: (id: string) => void;
  setErrorBanner: (msg: string | null) => void;

  initWsAndLoadProjects: () => Promise<void>;
  switchProject: (projectRoot: string) => Promise<void>;
  refreshState: () => Promise<void>;
  handleWsMessage: (msg: ServerWsMessage) => void;
  sendWs: (msg: Parameters<ReturnType<typeof connectGuiWebSocket>["send"]>[0]) => void;
  openPtyTab: (tab: Omit<PtyTabState, "tabId"> & { tabId?: string }) => string;
  closePtyTab: (tabId: string) => void;
}

let wsHandle: ReturnType<typeof connectGuiWebSocket> | null = null;
const MAX_LOG_CHARS = 1024 * 1024; // 1MB cap per GUI_ARCHITECTURE.md 7.4

export const useAsdStore = create<AsdGuiStoreState>((set, get) => ({
  locale: "ko",
  wsConnected: false,
  projects: [],
  currentProjectRoot: null,
  snapshot: null,
  driversBySession: {},
  selectedSessionId: null,
  selectedSubSessionId: null,
  selectedRecentHarnessSessionId: null,
  activeCenterTab: "plan",
  jobs: {},
  logs: {},
  ptyTabs: [],
  ptyBuffers: {},
  toasts: [],
  diffModalTaskId: null,
  errorBanner: null,

  setLocale: (locale) => set({ locale }),
  setActiveCenterTab: (activeCenterTab) => set({ activeCenterTab }),
  selectSession: (selectedSessionId) =>
    set({ selectedSessionId, selectedRecentHarnessSessionId: null }),
  selectSubagent: (selectedSubSessionId) => set({ selectedSubSessionId }),
  selectRecentChat: (selectedRecentHarnessSessionId) =>
    set({
      selectedRecentHarnessSessionId,
      activeCenterTab: "chat",
    }),
  openDiffModal: (diffModalTaskId) => set({ diffModalTaskId }),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setErrorBanner: (errorBanner) => set({ errorBanner }),

  initWsAndLoadProjects: async () => {
    if (!wsHandle && typeof window !== "undefined") {
      wsHandle = connectGuiWebSocket(
        (msg) => get().handleWsMessage(msg),
        (connected) => {
          set({ wsConnected: connected });
          const curRoot = get().currentProjectRoot;
          if (connected && curRoot) {
            wsHandle?.send({ type: "subscribe_project", projectRoot: curRoot });
            void get().refreshState();
          }
        }
      );
    }

    try {
      const res = await fetchProjects();
      set({ projects: res.projects });
      const firstExisting = res.projects.find((p) => p.existsOnDisk);
      if (firstExisting && !get().currentProjectRoot) {
        await get().switchProject(firstExisting.projectRoot);
      }
    } catch (err: unknown) {
      set({
        errorBanner: err instanceof Error ? err.message : String(err),
      });
    }
  },

  switchProject: async (projectRoot: string) => {
    const prevRoot = get().currentProjectRoot;
    if (prevRoot && prevRoot !== projectRoot) {
      wsHandle?.send({ type: "unsubscribe_project", projectRoot: prevRoot });
    }
    try {
      const snap = await apiOpenProject(projectRoot);
      const selectedSessionId =
        snap.foregroundSessionId ??
        snap.session?.session_id ??
        snap.sessions[0]?.session_id ??
        null;
      set({
        currentProjectRoot: snap.projectRoot,
        snapshot: snap,
        driversBySession: snap.drivers ?? {},
        selectedSessionId,
        selectedSubSessionId: null,
        selectedRecentHarnessSessionId: null,
        locale: resolveLocale(snap.systemLocale),
        errorBanner: null,
      });
      wsHandle?.send({
        type: "subscribe_project",
        projectRoot: snap.projectRoot,
      });
    } catch (err: unknown) {
      set({
        errorBanner: err instanceof Error ? err.message : String(err),
      });
    }
  },

  refreshState: async () => {
    const curRoot = get().currentProjectRoot;
    if (!curRoot) return;
    try {
      const snap = await apiFetch<OpenProjectResponse>(
        `/api/sessions/state?projectRoot=${encodeURIComponent(curRoot)}`
      );
      set((state) => ({
        snapshot: snap,
        driversBySession: snap.drivers ?? state.driversBySession,
        selectedSessionId:
          state.selectedSessionId ??
          snap.foregroundSessionId ??
          snap.session?.session_id ??
          null,
      }));
    } catch (err: unknown) {
      set({
        errorBanner: err instanceof Error ? err.message : String(err),
      });
    }
  },

  handleWsMessage: (msg: ServerWsMessage) => {
    switch (msg.type) {
      case "state_updated": {
        set((state) => {
          const selectedSessionId =
            state.selectedSessionId &&
            msg.snapshot.sessions.some(
              (s) => s.session_id === state.selectedSessionId
            )
              ? state.selectedSessionId
              : msg.snapshot.foregroundSessionId ??
                msg.snapshot.session?.session_id ??
                msg.snapshot.sessions[0]?.session_id ??
                null;
          return {
            snapshot: msg.snapshot,
            driversBySession: msg.snapshot.drivers ?? state.driversBySession,
            selectedSessionId,
          };
        });
        break;
      }
      case "task_status_changed": {
        const notice: ToastNotice = {
          id: `${Date.now()}-${msg.taskId}-${msg.to}`,
          taskId: msg.taskId,
          status: msg.to,
          message: `[${msg.taskId}] ${msg.from ?? "new"} → ${msg.to}${
            msg.reason ? ` (${msg.reason})` : ""
          }`,
          createdAt: Date.now(),
        };
        set((state) => ({
          toasts: [notice, ...state.toasts].slice(0, 8),
        }));
        break;
      }
      case "job_started": {
        set((state) => ({
          jobs: {
            ...state.jobs,
            [msg.jobId]: {
              jobId: msg.jobId,
              kind: msg.kind,
              projectRoot: msg.projectRoot,
              sessionId: msg.sessionId,
              taskIds: msg.taskIds,
              runId: msg.runId,
              status: "running",
              progressMessages: [],
            },
          },
        }));
        break;
      }
      case "job_progress": {
        set((state) => {
          const existing = state.jobs[msg.jobId];
          if (!existing) return state;
          return {
            jobs: {
              ...state.jobs,
              [msg.jobId]: {
                ...existing,
                progressMessages: [
                  ...existing.progressMessages,
                  msg.message,
                ].slice(-50),
              },
            },
          };
        });
        break;
      }
      case "job_finished": {
        set((state) => {
          const existing = state.jobs[msg.jobId];
          if (!existing) return state;
          return {
            jobs: {
              ...state.jobs,
              [msg.jobId]: {
                ...existing,
                status: msg.ok ? "done" : "failed",
                error: msg.error,
              },
            },
          };
        });
        break;
      }
      case "subagent_log_chunk": {
        const key = `sub::${msg.sessionId}::${msg.subSessionId}`;
        set((state) => {
          const prev = state.logs[key] ?? { offset: 0, text: "" };
          const combined = (prev.text + msg.chunk).slice(-MAX_LOG_CHARS);
          return {
            logs: {
              ...state.logs,
              [key]: {
                offset: msg.offset + msg.chunk.length,
                text: combined,
              },
            },
          };
        });
        break;
      }
      case "driver_output_chunk": {
        const key = `drv::${msg.sessionId}::${msg.runId}`;
        set((state) => {
          const prev = state.logs[key] ?? { offset: 0, text: "" };
          const combined = (prev.text + msg.chunk).slice(-MAX_LOG_CHARS);
          return {
            logs: {
              ...state.logs,
              [key]: {
                offset: msg.offset + msg.chunk.length,
                text: combined,
              },
            },
          };
        });
        break;
      }
      case "log_closed": {
        const key = msg.subSessionId
          ? `sub::${msg.sessionId}::${msg.subSessionId}`
          : `drv::${msg.sessionId}::${msg.runId ?? ""}`;
        set((state) => ({
          logs: {
            ...state.logs,
            [key]: {
              ...(state.logs[key] ?? { offset: 0, text: "" }),
              closed: true,
            },
          },
        }));
        break;
      }
      case "pty_output": {
        set((state) => ({
          ptyBuffers: {
            ...state.ptyBuffers,
            [msg.tabId]: ((state.ptyBuffers[msg.tabId] ?? "") + msg.data).slice(
              -MAX_LOG_CHARS
            ),
          },
        }));
        break;
      }
      case "pty_exit": {
        set((state) => ({
          ptyTabs: state.ptyTabs.map((t) =>
            t.tabId === msg.tabId
              ? { ...t, exited: true, exitCode: msg.exitCode }
              : t
          ),
        }));
        break;
      }
      case "pty_error": {
        set((state) => ({
          ptyTabs: state.ptyTabs.map((t) =>
            t.tabId === msg.tabId ? { ...t, error: msg.message } : t
          ),
        }));
        break;
      }
      case "error": {
        set({ errorBanner: `[${msg.code}] ${msg.message}` });
        break;
      }
    }
  },

  sendWs: (msg) => {
    wsHandle?.send(msg);
  },

  openPtyTab: (tabInput) => {
    const tabId =
      tabInput.tabId ?? `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const tab: PtyTabState = {
      ...tabInput,
      tabId,
    };
    set((state) => ({
      ptyTabs: [...state.ptyTabs, tab],
      activeCenterTab: `pty:${tabId}`,
    }));
    wsHandle?.send({
      type: "pty_spawn",
      tabId,
      projectRoot: tab.projectRoot,
      cwd: tab.cwd,
      harness: tab.harness as Parameters<
        ReturnType<typeof connectGuiWebSocket>["send"]
      >[0] extends { type: "pty_spawn"; harness?: infer H }
        ? H
        : never,
      harnessSessionId: tab.harnessSessionId,
      model: tab.model,
      asDriverOf: tab.asDriverOf,
      cols: 100,
      rows: 30,
    });
    return tabId;
  },

  closePtyTab: (tabId) => {
    wsHandle?.send({ type: "pty_kill", tabId });
    set((state) => {
      const remaining = state.ptyTabs.filter((t) => t.tabId !== tabId);
      const nextCenter =
        state.activeCenterTab === `pty:${tabId}`
          ? "plan"
          : state.activeCenterTab;
      return {
        ptyTabs: remaining,
        activeCenterTab: nextCenter,
      };
    });
  },
}));
