import { parseAccessPrincipal, type AccessPrincipal } from "./session.js";

export interface ResponseEnvelope<T> {
  data: T;
  meta?: { requestId?: string; generatedAt?: string; [key: string]: unknown };
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT";
  body?: unknown;
  signal?: AbortSignal;
}

const configuredBaseUrl = import.meta.env.VITE_NOVA_BFF_BASE_URL?.trim();
const NOVA_CSRF_COOKIE = "__Host-hyperion-nova-csrf";

export function readCookieValue(name: string, cookieSource?: string): string | undefined {
  const source = cookieSource ?? (typeof document === "undefined" ? "" : document.cookie);
  let value: string | undefined;
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    if (value !== undefined) return undefined;
    try {
      value = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return value;
}

function addMutationHeaders(headers: Headers): void {
  headers.set("x-requested-with", "nova-console");
  const csrf = readCookieValue(NOVA_CSRF_COOKIE);
  if (csrf) headers.set("x-csrf-token", csrf);
}

export function resolveApiBaseUrl(value = configuredBaseUrl): string {
  if (!value) return "/api";
  if (value.startsWith("/") && !value.startsWith("//")) return value.replace(/\/$/, "");
  throw new Error("VITE_NOVA_BFF_BASE_URL debe ser una ruta same-origin");
}

export const apiBaseUrl = resolveApiBaseUrl();

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

async function readPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined;
  return response.json().catch(() => undefined);
}

function unwrap<T>(payload: unknown): T {
  if (typeof payload === "object" && payload !== null && "data" in payload) {
    return (payload as ResponseEnvelope<T>).data;
  }
  return payload as T;
}

function errorDetails(payload: unknown): { message?: string; data?: Record<string, unknown> } {
  const data = unwrap<unknown>(payload);
  if (typeof data !== "object" || data === null) return {};
  const record = data as Record<string, unknown>;
  return { message: typeof record.error === "string" ? record.error : undefined, data: record };
}

async function requestPayload(path: string, options: RequestOptions = {}): Promise<unknown> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.method && options.method !== "GET") addMutationHeaders(headers);

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: "include",
    signal: options.signal
  });
  const payload = await readPayload(response);

  if (response.status === 401) throw new SessionExpiredError("Sesión expirada");
  if (!response.ok) {
    const details = errorDetails(payload);
    throw new ApiError(response.status, details.message ?? `${response.status} ${response.statusText}`, details.data);
  }
  return payload;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return unwrap<T>(await requestPayload(path, options));
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  getEnvelope: async <T>(path: string, signal?: AbortSignal): Promise<ResponseEnvelope<T>> => {
    const payload = await requestPayload(path, { signal });
    if (typeof payload === "object" && payload !== null && "data" in payload) {
      return payload as ResponseEnvelope<T>;
    }
    return { data: payload as T };
  },
  post: <T>(path: string, body: unknown, signal?: AbortSignal) => request<T>(path, { method: "POST", body, signal }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: "PUT", body }),
  form: async <T>(path: string, form: FormData): Promise<T> => {
    const headers = new Headers();
    addMutationHeaders(headers);
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: "POST",
      headers,
      body: form,
      credentials: "include"
    });
    const payload = await readPayload(response);
    if (response.status === 401) throw new SessionExpiredError("Sesión expirada");
    if (!response.ok) {
      const details = errorDetails(payload);
      throw new ApiError(response.status, details.message ?? `${response.status} ${response.statusText}`, details.data);
    }
    return unwrap<T>(payload);
  }
};

export async function currentSession(): Promise<AccessPrincipal> {
  return parseAccessPrincipal(await api.get<unknown>("/v1/auth/me"));
}

export async function login(email: string, password: string): Promise<AccessPrincipal> {
  await api.post<unknown>("/v1/auth/login", { email, password });
  return currentSession();
}

export async function logout(): Promise<void> {
  await api.post<unknown>("/v1/auth/logout", {}).catch(() => undefined);
}
