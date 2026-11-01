/**
 * REST and WebSocket client helper for ASD GUI (src/web/api/client.ts).
 */

import type {
  ApiErrorEnvelope,
  ClientWsMessage,
  GetProjectsResponse,
  OpenProjectResponse,
  ServerWsMessage,
} from "../../shared/protocol.ts";

let inMemoryBearerToken: string | null = null;

export function setAuthBearerToken(token: string | null): void {
  inMemoryBearerToken = token;
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (inMemoryBearerToken && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${inMemoryBearerToken}`);
  }

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });

  const data = (await res.json()) as T | ApiErrorEnvelope;
  if (!res.ok) {
    const errEnvelope = data as ApiErrorEnvelope;
    throw new Error(
      errEnvelope?.error?.message || `HTTP ${res.status}: ${path}`
    );
  }
  return data as T;
}

export async function fetchProjects(): Promise<GetProjectsResponse> {
  return await apiFetch<GetProjectsResponse>("/api/projects");
}

export async function openProject(
  projectRoot: string
): Promise<OpenProjectResponse> {
  return await apiFetch<OpenProjectResponse>("/api/projects/open", {
    method: "POST",
    body: JSON.stringify({ projectRoot }),
  });
}

export function connectGuiWebSocket(
  onMessage: (msg: ServerWsMessage) => void,
  onStatusChange?: (connected: boolean) => void
): {
  send: (msg: ClientWsMessage) => void;
  close: () => void;
} {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${proto}//${window.location.host}/ws`;
  const ws = new WebSocket(wsUrl);

  ws.addEventListener("open", () => {
    onStatusChange?.(true);
  });

  ws.addEventListener("message", (ev) => {
    try {
      const parsed = JSON.parse(String(ev.data)) as ServerWsMessage;
      onMessage(parsed);
    } catch {
      // Ignore malformed messages
    }
  });

  ws.addEventListener("close", () => {
    onStatusChange?.(false);
  });

  return {
    send: (msg: ClientWsMessage) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close: () => {
      ws.close();
    },
  };
}
