import { hc } from "hono/client";

const BASE_URL = "/api";

export class ApiFetchError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code: string | undefined;

  constructor(status: number, statusText: string, detail?: string, code?: string) {
    super(detail || `API error ${status}: ${statusText}`);
    this.name = "ApiFetchError";
    this.status = status;
    this.statusText = statusText;
    this.code = code;
  }
}

// Keep the Hono RPC client permissive while Luna routes are exposed through
// typed fetch hooks during the runtime migration.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const api = hc<any>("/").api as any;

/**
 * Typed fetch wrapper for the Luna backend API.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : undefined;
    throw new ApiFetchError(res.status, res.statusText, detail, typeof body?.code === "string" ? body.code : undefined);
  }
  return res.json() as Promise<T>;
}

export async function logoutDashboard(): Promise<void> {
  const res = await fetch(`${BASE_URL}/auth/logout`, {
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`Logout failed ${res.status}: ${res.statusText}`);
  }
}

export function agentConfigPath(agentId: string, path: string): string {
  return `/agent-config/${path}?agentId=${encodeURIComponent(agentId)}`;
}

/** Connection tests return diagnostic details on both 200 and 422. */
export async function testAgentProfileConnection(agentId: string, revisionId: string): Promise<void> {
  const response = await fetch(BASE_URL + agentConfigPath(agentId, `revisions/${encodeURIComponent(revisionId)}/test`), { method: "POST" });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.result?.success !== true) {
    const message = body?.result?.message ?? body?.message;
    throw new Error(typeof message === "string" && message.trim()
      ? message : `Connection test failed (HTTP ${response.status}). Please try again.`);
  }
}
