import type { ResponseEnvelope } from "@hyperion/platform-contracts";

const configuredBaseUrl = String(import.meta.env.VITE_PULSO_BFF_BASE_URL ?? "/api").trim();

export function resolvePulsoApiBaseUrl(value = configuredBaseUrl): string {
  if (!value) return "/api";
  if (value.startsWith("/") && !value.startsWith("//")) return value.replace(/\/$/, "") || "/";
  throw new Error("VITE_PULSO_BFF_BASE_URL must be a same-origin path");
}

export const apiBaseUrl = resolvePulsoApiBaseUrl();

let csrfToken: string | undefined;
export function setCsrfToken(token: string | undefined): void {
  csrfToken = token;
}

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
  csrf?: boolean;
}

async function rawRequest(path: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? "GET";
  const headers = new Headers({ accept: "application/json" });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET") {
    headers.set("x-requested-with", "pulso-console");
    if (options.csrf !== false && csrfToken) headers.set("x-csrf-token", csrfToken);
  }
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    credentials: "include",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal
  });
  if (response.status === 401) throw new SessionExpiredError("Sesión expirada");
  return response;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await rawRequest(path, options);
  const payload = (await response.json().catch(() => undefined)) as
    ResponseEnvelope<{ error?: string } & Record<string, unknown>> | undefined;
  if (!response.ok) {
    const data = payload?.data as Record<string, unknown> | undefined;
    throw new ApiError(
      response.status,
      data?.error ? String(data.error) : `${response.status} ${response.statusText}`,
      data
    );
  }
  return payload?.data as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, options?: { csrf?: boolean }) =>
    request<T>(path, { method: "POST", body, csrf: options?.csrf }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body }),
  text: async (path: string): Promise<{ content: string; filename?: string }> => {
    const response = await rawRequest(path);
    const raw = await response.text();
    if (!response.ok) throw new ApiError(response.status, `${response.status} ${response.statusText}`);
    try {
      const payload = JSON.parse(raw) as { data?: { csv?: string; content?: string; filename?: string } };
      return { content: payload.data?.csv ?? payload.data?.content ?? raw, filename: payload.data?.filename };
    } catch {
      const disposition = response.headers.get("content-disposition") ?? "";
      return { content: raw, filename: /filename="?([^";]+)"?/i.exec(disposition)?.[1] };
    }
  }
};
