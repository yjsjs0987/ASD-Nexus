/**
 * asd-gui WebSocket client — replaces Elysium's Tauri event listen with WS /ws.
 * Same-origin connection, cookie auth (asd_token). Reconnects with exponential backoff 1s→30s.
 * On reconnect: re-sends subscribe_project + full state sync via GET /api/sessions/state.
 *
 * Client→Server (8 types):
 *   subscribe_project, unsubscribe_project, subscribe_log, unsubscribe_log,
 *   pty_spawn, pty_input, pty_resize, pty_kill
 *
 * Server→Client (13 types):
 *   state_updated, task_status_changed, job_started, job_progress, job_finished,
 *   subagent_log_chunk, driver_output_chunk, log_closed,
 *   pty_output, pty_exit, pty_error, error
 */

import type {
  ClientWsMessage,
  ServerWsMessage,
  DashboardSnapshot,
  JobKind,
  TaskStatus,
  HarnessId,
} from "../shared/protocol.ts";

export type { ClientWsMessage, ServerWsMessage };
export type WsReadyState = WebSocket["readyState"];

export interface WsClientOptions {
  /** Project root to auto-subscribe on connect/reconnect */
  projectRoot?: string;
  /** Called when WS opens */
  onOpen?: () => void;
  /** Called when WS closes (clean or not) */
  onClose?: (clean: boolean, code: number, reason: string) => void;
  /** Called on any server message (after parsing) */
  onMessage?: (msg: ServerWsMessage) => void;
  /** Called on parsed error message from server */
  onError?: (code: string, message: string, sessionId?: string) => void;
  /** Called on reconnection attempt */
  onReconnecting?: (attempt: number, delayMs: number) => void;
  /** Called when full state sync completes after reconnect */
  onStateSynced?: (snapshot: DashboardSnapshot) => void;
}

type MessageHandler = (msg: ServerWsMessage) => void;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_JITTER = 0.2;

export class WsClient {
  private ws: WebSocket | null = null;
  private opts: Required<WsClientOptions>;
  private handlers = new Set<MessageHandler>();
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private pendingSubscriptions: ClientWsMessage[] = [];

  constructor(options: WsClientOptions = {}) {
    this.opts = {
      projectRoot: options.projectRoot ?? "",
      onOpen: options.onOpen ?? (() => {}),
      onClose: options.onClose ?? (() => {}),
      onMessage: options.onMessage ?? (() => {}),
      onError: options.onError ?? (() => {}),
      onReconnecting: options.onReconnecting ?? (() => {}),
      onStateSynced: options.onStateSynced ?? (() => {}),
    };
  }

  /** Update callbacks/options on an existing singleton instance without dropping handlers. */
  updateOptions(options: WsClientOptions): void {
    if (options.projectRoot !== undefined) this.opts.projectRoot = options.projectRoot;
    if (options.onOpen) this.opts.onOpen = options.onOpen;
    if (options.onClose) this.opts.onClose = options.onClose;
    if (options.onMessage) this.opts.onMessage = options.onMessage;
    if (options.onError) this.opts.onError = options.onError;
    if (options.onReconnecting) this.opts.onReconnecting = options.onReconnecting;
    if (options.onStateSynced) this.opts.onStateSynced = options.onStateSynced;
  }

  /** Connect to /ws (same origin). Call once at app startup. */
  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }
    this.intentionalClose = false;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.opts.onOpen();
      this.flushPendingSubscriptions();
    };

    this.ws.onclose = (e) => {
      this.ws = null;
      this.opts.onClose(e.wasClean, e.code, e.reason);
      if (!this.intentionalClose) this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this; no separate handling needed
    };

    this.ws.onmessage = (e) => this.handleMessage(e.data);
  }

  /** Disconnect and stop reconnection attempts. */
  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "intentional disconnect");
      this.ws = null;
    }
  }

  /** Send a client→server message. Queues if not yet open. */
  send(msg: ClientWsMessage): void {
    const data = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      this.pendingSubscriptions.push(msg);
    }
  }

  /** Subscribe to project-level events (state_updated, task_status_changed, jobs). */
  subscribeProject(projectRoot: string): void {
    this.send({ type: "subscribe_project", projectRoot });
  }

  /** Unsubscribe from project-level events. */
  unsubscribeProject(projectRoot: string): void {
    this.send({ type: "unsubscribe_project", projectRoot });
  }

  /** Subscribe to a log stream (subagent or driver). */
  subscribeLog(params: {
    projectRoot: string;
    sessionId: string;
    subSessionId?: string;
    runId?: string;
    fromOffset?: number;
  }): void {
    this.send({ type: "subscribe_log", ...params });
  }

  /** Unsubscribe from a log stream. */
  unsubscribeLog(params: {
    projectRoot: string;
    sessionId: string;
    subSessionId?: string;
    runId?: string;
  }): void {
    this.send({ type: "unsubscribe_log", ...params });
  }

  /** Spawn a PTY terminal tab. */
  spawnPty(params: {
    tabId: string;
    projectRoot: string;
    cwd?: string;
    harness?: HarnessId;
    harnessSessionId?: string;
    model?: string;
    asDriverOf?: { sessionId: string; driverId: string };
    cols: number;
    rows: number;
  }): void {
    this.send({ type: "pty_spawn", ...params });
  }

  /** Send input to a PTY tab. */
  ptyInput(tabId: string, data: string): void {
    this.send({ type: "pty_input", tabId, data });
  }

  /** Resize a PTY tab. */
  ptyResize(tabId: string, cols: number, rows: number): void {
    this.send({ type: "pty_resize", tabId, cols, rows });
  }

  /** Kill a PTY tab. */
  ptyKill(tabId: string): void {
    this.send({ type: "pty_kill", tabId });
  }

  /** Register a handler for all server messages. Returns unsubscribe fn. */
  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Current readyState (CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3). */
  get readyState(): WsReadyState {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  /** Whether the socket is open and ready. */
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private flushPendingSubscriptions(): void {
    for (const msg of this.pendingSubscriptions) {
      this.ws?.send(JSON.stringify(msg));
    }
    this.pendingSubscriptions = [];
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    const jitter = delay * RECONNECT_JITTER * Math.random();
    const finalDelay = Math.floor(delay + jitter);

    this.reconnectAttempt++;
    this.opts.onReconnecting(this.reconnectAttempt, finalDelay);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, finalDelay);
  }

  private async handleMessage(data: string | ArrayBuffer): Promise<void> {
    let msg: ServerWsMessage;
    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      msg = JSON.parse(text);
    } catch {
      console.warn("[ws] Failed to parse message:", data);
      return;
    }

    // Handle error messages from server
    if (msg.type === "error") {
      this.opts.onError(msg.code, msg.message, msg.sessionId);
    }

    // Handle state_updated → full snapshot for reconnect sync
    if (msg.type === "state_updated") {
      this.opts.onStateSynced(msg.snapshot);
    }

    // Fan out to all handlers
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch (e) {
        console.error("[ws] Handler error:", e);
      }
    }
    this.opts.onMessage(msg);
  }
}

/** Singleton instance for app-wide use (initialized in main.tsx). */
let wsClientInstance: WsClient | null = null;

export function getWsClient(): WsClient {
  if (!wsClientInstance) {
    wsClientInstance = new WsClient();
  }
  return wsClientInstance;
}

export function initWsClient(options: WsClientOptions): WsClient {
  if (!wsClientInstance) {
    wsClientInstance = new WsClient(options);
  } else {
    wsClientInstance.updateOptions(options);
  }
  return wsClientInstance;
}

export function destroyWsClient(): void {
  if (wsClientInstance) {
    wsClientInstance.disconnect();
    wsClientInstance = null;
  }
}

// ============================================================================
// Type guards for ServerWsMessage (narrowing in handlers)
// ============================================================================

export function isStateUpdated(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "state_updated" }> {
  return msg.type === "state_updated";
}

export function isTaskStatusChanged(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "task_status_changed" }> {
  return msg.type === "task_status_changed";
}

export function isJobStarted(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "job_started" }> {
  return msg.type === "job_started";
}

export function isJobProgress(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "job_progress" }> {
  return msg.type === "job_progress";
}

export function isJobFinished(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "job_finished" }> {
  return msg.type === "job_finished";
}

export function isSubagentLogChunk(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "subagent_log_chunk" }> {
  return msg.type === "subagent_log_chunk";
}

export function isDriverOutputChunk(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "driver_output_chunk" }> {
  return msg.type === "driver_output_chunk";
}

export function isLogClosed(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "log_closed" }> {
  return msg.type === "log_closed";
}

export function isPtyOutput(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "pty_output" }> {
  return msg.type === "pty_output";
}

export function isPtyExit(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "pty_exit" }> {
  return msg.type === "pty_exit";
}

export function isPtyError(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "pty_error" }> {
  return msg.type === "pty_error";
}

export function isWsError(msg: ServerWsMessage): msg is Extract<ServerWsMessage, { type: "error" }> {
  return msg.type === "error";
}