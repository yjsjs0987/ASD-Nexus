/**
 * asd-gui WS event hooks — replaces Elysium's useTauriEvent with WS-based hooks.
 * Built on ws.ts (WsClient). Provides typed, React-friendly subscriptions.
 *
 * Usage:
 *   const { subscribe, unsubscribe } = useWsEvent("state_updated", handler);
 *   useEffect(() => { subscribe(projectRoot); return () => unsubscribe(); }, [projectRoot]);
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  getWsClient,
  type WsClient,
  type ServerWsMessage,
} from "./ws.ts";
import type {
  DashboardSnapshot,
  TaskStatus,
  JobKind,
  DriverRunResult,
  AsdDispatchOutput,
  AsdDebateOutput,
} from "../shared/protocol.ts";

// ============================================================================
// Type guards (inline for proper narrowing in callbacks)
// ============================================================================

function isStateUpdated(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "state_updated" }> {
  return msg.type === "state_updated";
}

function isTaskStatusChanged(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "task_status_changed" }> {
  return msg.type === "task_status_changed";
}

function isJobStarted(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "job_started" }> {
  return msg.type === "job_started";
}

function isJobProgress(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "job_progress" }> {
  return msg.type === "job_progress";
}

function isJobFinished(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "job_finished" }> {
  return msg.type === "job_finished";
}

function isSubagentLogChunk(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "subagent_log_chunk" }> {
  return msg.type === "subagent_log_chunk";
}

function isDriverOutputChunk(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "driver_output_chunk" }> {
  return msg.type === "driver_output_chunk";
}

function isLogClosed(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "log_closed" }> {
  return msg.type === "log_closed";
}

function isPtyOutput(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "pty_output" }> {
  return msg.type === "pty_output";
}

function isPtyExit(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "pty_exit" }> {
  return msg.type === "pty_exit";
}

function isPtyError(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "pty_error" }> {
  return msg.type === "pty_error";
}

function isWsError(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "error" }> {
  return msg.type === "error";
}

// ============================================================================
// Core subscription hook (low-level)
// ============================================================================

interface SubscriptionHandle {
  subscribe: (projectRoot: string) => void;
  unsubscribe: () => void;
}

function useWsSubscription(
  onMessage: (msg: ServerWsMessage) => void,
  deps: unknown[] = []
): SubscriptionHandle {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  const subscribe = useCallback(
    (projectRoot: string) => {
      getWsClient().subscribeProject(projectRoot);
    },
    []
  );

  const unsubscribe = useCallback(() => {
    // Note: we don't auto-unsubscribe project on unmount to avoid
    // flapping if multiple components share the same projectRoot.
    // Caller should manage project lifecycle explicitly if needed.
  }, []);

  // Register message handler
  useEffect(() => {
    const client = getWsClient();
    const unsubscribeHandler = client.onMessage((msg) => {
      handlerRef.current(msg);
    });

    return unsubscribeHandler;
  }, [...deps]);

  return { subscribe, unsubscribe };
}

// ============================================================================
// Typed event hooks (high-level)
// ============================================================================

/** Full project state snapshot (DashboardSnapshot + git info). */
export function useWsStateUpdated(
  onSnapshot: (snapshot: DashboardSnapshot & {
    isGitRepo?: boolean;
    gitBranch?: string | null;
    gitHeadSha?: string | null;
    foregroundSessionId?: string | null;
  }) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isStateUpdated(msg)) onSnapshot(msg.snapshot);
  });
}

/** Task status transition (from → to). */
export function useWsTaskStatusChanged(
  onChange: (params: {
    projectRoot: string;
    sessionId: string;
    taskId: string;
    from: TaskStatus | null;
    to: TaskStatus;
    reason?: string;
  }) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isTaskStatusChanged(msg)) {
      onChange({
        projectRoot: msg.projectRoot,
        sessionId: msg.sessionId,
        taskId: msg.taskId,
        from: msg.from,
        to: msg.to,
        reason: msg.reason,
      });
    }
  });
}

/** Job started (dispatch, debate, driver_turn, subagent_action, resolve_conflict). */
export function useWsJobStarted(
  onStart: (params: {
    jobId: string;
    kind: JobKind;
    projectRoot: string;
    sessionId: string;
    taskIds?: string[];
    runId?: string;
  }) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isJobStarted(msg)) {
      onStart({
        jobId: msg.jobId,
        kind: msg.kind,
        projectRoot: msg.projectRoot,
        sessionId: msg.sessionId,
        taskIds: msg.taskIds,
        runId: msg.runId,
      });
    }
  });
}

/** Job progress message (free-form string). */
export function useWsJobProgress(
  onProgress: (jobId: string, message: string) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isJobProgress(msg)) onProgress(msg.jobId, msg.message);
  });
}

/** Job finished (ok + result or error). */
export function useWsJobFinished(
  onFinish: (params: {
    jobId: string;
    kind: JobKind;
    ok: boolean;
    result?:
      | AsdDispatchOutput
      | AsdDebateOutput
      | DriverRunResult
      | { runId: string; exitCode: number; harnessSessionId: string | null }
      | unknown;
    error?: string;
  }) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isJobFinished(msg)) {
      onFinish({
        jobId: msg.jobId,
        kind: msg.kind,
        ok: msg.ok,
        result: msg.result,
        error: msg.error,
      });
    }
  });
}

/** Subagent log chunk (streaming output). */
export function useWsSubagentLogChunk(
  onChunk: (params: {
    projectRoot: string;
    sessionId: string;
    subSessionId: string;
    offset: number;
    chunk: string;
  }) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isSubagentLogChunk(msg)) {
      onChunk({
        projectRoot: msg.projectRoot,
        sessionId: msg.sessionId,
        subSessionId: msg.subSessionId,
        offset: msg.offset,
        chunk: msg.chunk,
      });
    }
  });
}

/** Driver output chunk (streaming output). */
export function useWsDriverOutputChunk(
  onChunk: (params: {
    projectRoot: string;
    sessionId: string;
    runId: string;
    offset: number;
    chunk: string;
  }) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isDriverOutputChunk(msg)) {
      onChunk({
        projectRoot: msg.projectRoot,
        sessionId: msg.sessionId,
        runId: msg.runId,
        offset: msg.offset,
        chunk: msg.chunk,
      });
    }
  });
}

/** Log stream closed (finished or deleted). */
export function useWsLogClosed(
  onClosed: (params: {
    projectRoot: string;
    sessionId: string;
    subSessionId?: string;
    runId?: string;
    reason: "finished" | "deleted";
  }) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isLogClosed(msg)) {
      onClosed({
        projectRoot: msg.projectRoot,
        sessionId: msg.sessionId,
        subSessionId: msg.subSessionId,
        runId: msg.runId,
        reason: msg.reason,
      });
    }
  });
}

/** PTY output data. */
export function useWsPtyOutput(
  onOutput: (tabId: string, data: string) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isPtyOutput(msg)) onOutput(msg.tabId, msg.data);
  });
}

/** PTY exited with code. */
export function useWsPtyExit(
  onExit: (tabId: string, exitCode: number) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isPtyExit(msg)) onExit(msg.tabId, msg.exitCode);
  });
}

/** PTY error. */
export function useWsPtyError(
  onError: (tabId: string, message: string) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isPtyError(msg)) onError(msg.tabId, msg.message);
  });
}

/** Generic server error. */
export function useWsError(
  onError: (code: string, message: string, sessionId?: string) => void
): SubscriptionHandle {
  return useWsSubscription((msg) => {
    if (isWsError(msg)) onError(msg.code, msg.message, msg.sessionId);
  });
}

// ============================================================================
// Convenience: combined hook for common dashboard needs
// ============================================================================

export interface UseDashboardEventsOptions {
  projectRoot: string;
  onStateUpdated?: (snapshot: DashboardSnapshot & {
    isGitRepo?: boolean;
    gitBranch?: string | null;
    gitHeadSha?: string | null;
    foregroundSessionId?: string | null;
  }) => void;
  onTaskStatusChanged?: (params: {
    projectRoot: string;
    sessionId: string;
    taskId: string;
    from: TaskStatus | null;
    to: TaskStatus;
    reason?: string;
  }) => void;
  onJobStarted?: (params: {
    jobId: string;
    kind: JobKind;
    projectRoot: string;
    sessionId: string;
    taskIds?: string[];
    runId?: string;
  }) => void;
  onJobProgress?: (jobId: string, message: string) => void;
  onJobFinished?: (params: {
    jobId: string;
    kind: JobKind;
    ok: boolean;
    result?:
      | AsdDispatchOutput
      | AsdDebateOutput
      | DriverRunResult
      | { runId: string; exitCode: number; harnessSessionId: string | null }
      | unknown;
    error?: string;
  }) => void;
  onError?: (code: string, message: string, sessionId?: string) => void;
}

/**
 * One-shot hook for dashboard-level events.
 * Subscribes to project on mount, unsubscribes on unmount.
 */
export function useDashboardEvents({
  projectRoot,
  onStateUpdated,
  onTaskStatusChanged,
  onJobStarted,
  onJobProgress,
  onJobFinished,
  onError,
}: UseDashboardEventsOptions): void {
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    clientRef.current = getWsClient();
    clientRef.current.subscribeProject(projectRoot);
    return () => {
      clientRef.current?.unsubscribeProject(projectRoot);
    };
  }, [projectRoot]);

  useWsStateUpdated((snapshot) => onStateUpdated?.(snapshot));
  useWsTaskStatusChanged((params) => onTaskStatusChanged?.(params));
  useWsJobStarted((params) => onJobStarted?.(params));
  useWsJobProgress((jobId, msg) => onJobProgress?.(jobId, msg));
  useWsJobFinished((params) => onJobFinished?.(params));
  useWsError((code, msg, sid) => onError?.(code, msg, sid));
}

// ============================================================================
// Reactive snapshot hook (for components that need live state)
// ============================================================================

function createSnapshotStore(initial: DashboardSnapshot | null) {
  let snapshot = initial;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    setSnapshot: (next: DashboardSnapshot | null) => {
      snapshot = next;
      for (const l of listeners) l();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getServerSnapshot: () => snapshot,
  };
}

const snapshotStore = createSnapshotStore(null);

/**
 * Reactive hook for the latest project snapshot.
 * Updates via WS state_updated messages.
 * Returns null until first snapshot arrives.
 */
export function useProjectSnapshot(projectRoot: string): DashboardSnapshot | null {
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    clientRef.current = getWsClient();
    clientRef.current.subscribeProject(projectRoot);

    const unsub = clientRef.current.onMessage((msg) => {
      if (isStateUpdated(msg)) {
        snapshotStore.setSnapshot(msg.snapshot);
      }
    });

    return () => {
      unsub();
      clientRef.current?.unsubscribeProject(projectRoot);
    };
  }, [projectRoot]);

  // Subscribe to external store for React 18 concurrent features
  return useSyncExternalStore(
    snapshotStore.subscribe,
    snapshotStore.getSnapshot,
    snapshotStore.getServerSnapshot
  );
}

/**
 * Hook to manually trigger a full state sync (GET /api/sessions/state).
 * Useful after reconnect or when snapshot might be stale.
 */
export async function syncProjectState(projectRoot: string): Promise<DashboardSnapshot> {
  const { getSessionState } = await import("./api.ts");
  const snapshot = await getSessionState(projectRoot);
  snapshotStore.setSnapshot(snapshot);
  return snapshot;
}

// ============================================================================
// Log streaming hooks (for transcript / driver output panels)
// ============================================================================

export interface UseLogStreamOptions {
  projectRoot: string;
  sessionId: string;
  subSessionId?: string;
  runId?: string;
  onChunk?: (offset: number, chunk: string) => void;
  onClosed?: (reason: "finished" | "deleted") => void;
}

/**
 * Subscribe to a log stream (subagent or driver).
 * Call onChunk for each chunk, onClosed when stream ends.
 */
export function useLogStream({
  projectRoot,
  sessionId,
  subSessionId,
  runId,
  onChunk,
  onClosed,
}: UseLogStreamOptions): void {
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    clientRef.current = getWsClient();
    clientRef.current.subscribeLog({
      projectRoot,
      sessionId,
      subSessionId,
      runId,
    });

    const unsub = clientRef.current.onMessage((msg) => {
      if (isSubagentLogChunk(msg) &&
          msg.projectRoot === projectRoot &&
          msg.sessionId === sessionId &&
          msg.subSessionId === subSessionId) {
        onChunk?.(msg.offset, msg.chunk);
      }
      if (isDriverOutputChunk(msg) &&
          msg.projectRoot === projectRoot &&
          msg.sessionId === sessionId &&
          msg.runId === runId) {
        onChunk?.(msg.offset, msg.chunk);
      }
      if (isLogClosed(msg) &&
          msg.projectRoot === projectRoot &&
          msg.sessionId === sessionId &&
          msg.subSessionId === subSessionId &&
          msg.runId === runId) {
        onClosed?.(msg.reason);
      }
    });

    return () => {
      unsub();
      clientRef.current?.unsubscribeLog({
        projectRoot,
        sessionId,
        subSessionId,
        runId,
      });
    };
  }, [projectRoot, sessionId, subSessionId, runId, onChunk, onClosed]);
}

// ============================================================================
// PTY hooks (for terminal tabs)
// ============================================================================

export interface UsePtyOptions {
  tabId: string;
  onOutput?: (data: string) => void;
  onExit?: (exitCode: number) => void;
  onError?: (message: string) => void;
}

/**
 * Subscribe to a PTY tab's output/exit/error events.
 */
export function usePty({
  tabId,
  onOutput,
  onExit,
  onError,
}: UsePtyOptions): void {
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    clientRef.current = getWsClient();

    const unsub = clientRef.current.onMessage((msg) => {
      if (isPtyOutput(msg) && msg.tabId === tabId) {
        onOutput?.(msg.data);
      }
      if (isPtyExit(msg) && msg.tabId === tabId) {
        onExit?.(msg.exitCode);
      }
      if (isPtyError(msg) && msg.tabId === tabId) {
        onError?.(msg.message);
      }
    });

    return () => unsub();
  }, [tabId, onOutput, onExit, onError]);
}

/**
 * Send input to a PTY tab.
 */
export function usePtyInput(): (tabId: string, data: string) => void {
  const clientRef = useRef<WsClient | null>(null);
  useEffect(() => {
    clientRef.current = getWsClient();
  }, []);
  return useCallback((tabId: string, data: string) => {
    clientRef.current?.ptyInput(tabId, data);
  }, []);
}

/**
 * Resize a PTY tab.
 */
export function usePtyResize(): (tabId: string, cols: number, rows: number) => void {
  const clientRef = useRef<WsClient | null>(null);
  useEffect(() => {
    clientRef.current = getWsClient();
  }, []);
  return useCallback((tabId: string, cols: number, rows: number) => {
    clientRef.current?.ptyResize(tabId, cols, rows);
  }, []);
}

/**
 * Kill a PTY tab.
 */
export function usePtyKill(): (tabId: string) => void {
  const clientRef = useRef<WsClient | null>(null);
  useEffect(() => {
    clientRef.current = getWsClient();
  }, []);
  return useCallback((tabId: string) => {
    clientRef.current?.ptyKill(tabId);
  }, []);
}