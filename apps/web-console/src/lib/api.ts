import type { ResponseEnvelope } from "@hyperion/contracts";
import { clearSession, loadSession } from "./session.js";

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

export class SessionExpiredError extends Error {}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
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
    const message =
      payload && typeof payload.data === "object" && payload.data && "error" in payload.data
        ? String((payload.data as { error?: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message);
  }

  return payload?.data as T;
}

/** Lecturas y escrituras que devuelven el `data` del envelope ya desempaquetado. */
export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body })
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
