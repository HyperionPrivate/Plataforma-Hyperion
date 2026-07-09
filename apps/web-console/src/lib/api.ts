import type { ResponseEnvelope } from "@hyperion/contracts";
import { clearSession, loadSession } from "./session.js";

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

export class SessionExpiredError extends Error {}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: Record<string, unknown>
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
}

async function authorizedFetch(path: string, init?: RequestInit): Promise<Response> {
  const session = loadSession();
  const headers = new Headers(init?.headers);
  if (session) headers.set("authorization", `Bearer ${session.token}`);
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });
  if (response.status === 401) {
    clearSession();
    throw new SessionExpiredError("Sesion expirada");
  }
  return response;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = loadSession();
  const headers: Record<string, string> = {};
  if (session) {
    headers.authorization = `Bearer ${session.token}`;
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal
  });

  if (response.status === 401) {
    clearSession();
    throw new SessionExpiredError("Sesion expirada");
  }

  const payload = (await response.json().catch(() => undefined)) as
    ResponseEnvelope<{ error?: string } & Record<string, unknown>> | undefined;

  if (!response.ok) {
    const data =
      payload && typeof payload.data === "object" && payload.data
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const message = data && "error" in data ? String(data.error) : `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message, data);
  }

  return payload?.data as T;
}

/** Lecturas y escrituras que devuelven el `data` del envelope ya desempaquetado. */
export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
  text: async (path: string): Promise<{ content: string; filename?: string }> => {
    const response = await authorizedFetch(path);
    const raw = await response.text();
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = JSON.parse(raw) as { data?: { error?: string } };
        message = payload.data?.error ?? message;
      } catch {
        // La exportacion puede responder texto plano; no lo mostramos como error sensible.
      }
      throw new ApiError(response.status, message);
    }
    let content = raw;
    try {
      const payload = JSON.parse(raw) as { data?: { csv?: string; content?: string; filename?: string } };
      content = payload.data?.csv ?? payload.data?.content ?? raw;
      return { content, filename: payload.data?.filename };
    } catch {
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
      return { content, filename };
    }
  }
};

/** Raw fetch para el login (todavia no hay sesion). */
export async function login(email: string, password: string) {
  const response = await fetch(`${apiBaseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const payload = (await response.json().catch(() => undefined)) as
    ResponseEnvelope<Record<string, unknown> & { error?: string }> | undefined;

  if (!response.ok) {
    const message =
      payload && payload.data && "error" in payload.data ? String(payload.data.error) : "No fue posible iniciar sesion";
    throw new ApiError(response.status, message);
  }

  return payload!.data;
}
