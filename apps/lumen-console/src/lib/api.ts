import type { ResponseEnvelope } from "@hyperion/platform-contracts";
import type { LumenSession } from "./session.js";

const configuredBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();

export function resolveLumenApiBaseUrl(value = configuredBaseUrl): string {
  if (!value) return "/api";
  if (value.startsWith("/") && !value.startsWith("//")) return value.replace(/\/$/, "") || "/";
  throw new Error("VITE_API_BASE_URL must be a same-origin path for the LUMEN session cookie");
}

export const apiBaseUrl = resolveLumenApiBaseUrl();
let csrfToken: string | undefined;

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
  method?: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.method && options.method !== "GET") {
    headers["x-requested-with"] = "lumen-console";
    if (csrfToken) headers["x-csrf-token"] = csrfToken;
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
    credentials: "include"
  });

  if (response.status === 401) {
    csrfToken = undefined;
    window.dispatchEvent(new Event("lumen:session-expired"));
    throw new SessionExpiredError("Sesión expirada");
  }

  const payload = (await response.json().catch(() => undefined)) as
    ResponseEnvelope<{ error?: string } & Record<string, unknown>> | undefined;

  if (!response.ok) {
    const data = payload && typeof payload.data === "object" ? payload.data : undefined;
    const message = data && "error" in data ? String(data.error) : `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message, data);
  }

  return payload?.data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body: unknown, signal?: AbortSignal) => request<T>(path, { method: "POST", body, signal }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body })
};

export function loadLumenSession(signal?: AbortSignal): Promise<LumenSession> {
  return api.get<LumenSession>("/v1/auth/session", signal).then((session) => {
    csrfToken = session.csrfToken;
    return session;
  });
}

export async function login(email: string, password: string): Promise<LumenSession> {
  await api.post<unknown>("/v1/auth/login", { email, password });
  return loadLumenSession();
}

export async function logout(): Promise<void> {
  await api.post<unknown>("/v1/auth/logout", {}).catch(() => undefined);
  csrfToken = undefined;
}
