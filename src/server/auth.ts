/**
 * Security middleware & token/Host/Origin validation (ADR-08 & Section 6.4).
 */

import * as crypto from "node:crypto";
import type * as http from "node:http";
import type { ApiErrorEnvelope, ErrorCode } from "../shared/protocol.ts";

export const AUTH_COOKIE_NAME = "asd_token";

export function generateAuthToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      out[key] = decodeURIComponent(val);
    }
  }
  return out;
}

export function extractRequestToken(req: http.IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const bearer = authHeader.slice("Bearer ".length).trim();
    if (bearer) return bearer;
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[AUTH_COOKIE_NAME]) {
    return cookies[AUTH_COOKIE_NAME]!;
  }
  return null;
}

export function safeTokenEquals(expected: string, candidate: string | null): boolean {
  if (!candidate || candidate.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(candidate, "utf8")
    );
  } catch {
    return false;
  }
}

export function isAllowedHost(hostHeader: string | undefined, serverPort: number): boolean {
  if (!hostHeader) return false;
  const normalized = hostHeader.trim().toLowerCase();
  return (
    normalized === `127.0.0.1:${serverPort}` ||
    normalized === `localhost:${serverPort}`
  );
}

export function isAllowedOrigin(
  originHeader: string | undefined,
  serverPort: number,
  isDevMode: boolean
): boolean {
  // Requests without Origin header (e.g. non-CORS GET or direct WS client) are allowed if Host & token pass
  if (!originHeader) return true;
  const normalized = originHeader.trim().toLowerCase().replace(/\/+$/, "");
  if (
    normalized === `http://127.0.0.1:${serverPort}` ||
    normalized === `http://localhost:${serverPort}`
  ) {
    return true;
  }
  if (
    isDevMode &&
    (normalized === "http://127.0.0.1:5173" ||
      normalized === "http://localhost:5173")
  ) {
    return true;
  }
  return false;
}

export interface RequestGuardResult {
  allowed: boolean;
  statusCode?: number;
  error?: ApiErrorEnvelope["error"];
}

/**
 * Validates Host, Origin, and Auth Token for `/api/*` and `/ws` requests.
 * Order:
 * 1. Host header check (DNS rebinding guard) -> 403 FORBIDDEN_ORIGIN
 * 2. Origin header check -> 403 FORBIDDEN_ORIGIN
 * 3. Token check (Cookie `asd_token` or `Authorization: Bearer <token>`) -> 401 AUTH_REQUIRED
 */
export function verifyRequestSecurity(
  req: http.IncomingMessage,
  opts: { token: string; port: number; isDevMode?: boolean }
): RequestGuardResult {
  const isDevMode = Boolean(opts.isDevMode ?? process.env.ASD_GUI_DEV === "1");

  if (!isAllowedHost(req.headers.host, opts.port)) {
    return {
      allowed: false,
      statusCode: 403,
      error: {
        code: "FORBIDDEN_ORIGIN",
        message: `Forbidden Host header: ${req.headers.host ?? "(missing)"}`,
      },
    };
  }

  const originHeader =
    typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!isAllowedOrigin(originHeader, opts.port, isDevMode)) {
    return {
      allowed: false,
      statusCode: 403,
      error: {
        code: "FORBIDDEN_ORIGIN",
        message: `Forbidden Origin header: ${originHeader}`,
      },
    };
  }

  const candidateToken = extractRequestToken(req);
  if (!safeTokenEquals(opts.token, candidateToken)) {
    return {
      allowed: false,
      statusCode: 401,
      error: {
        code: "AUTH_REQUIRED",
        message: "Missing or invalid authentication token",
      },
    };
  }

  return { allowed: true };
}

export function sendErrorJson(
  res: http.ServerResponse,
  statusCode: number,
  code: ErrorCode,
  message: string
): void {
  const payload: ApiErrorEnvelope = {
    ok: false,
    error: { code, message },
  };
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}
