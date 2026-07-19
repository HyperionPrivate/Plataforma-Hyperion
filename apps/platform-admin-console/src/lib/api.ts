import type { ResponseEnvelope } from "@hyperion/platform-contracts";

const configuredBaseUrl = String(import.meta.env.VITE_PLATFORM_ADMIN_BFF_BASE_URL ?? "/api").trim();

export function resolvePlatformAdminApiBaseUrl(value = configuredBaseUrl): string {
  if (!value) return "/api";
  if (value.startsWith("/") && !value.startsWith("//")) return value.replace(/\/$/, "") || "/";
  throw new Error("VITE_PLATFORM_ADMIN_BFF_BASE_URL must be a same-origin path");
}

export const apiBaseUrl = resolvePlatformAdminApiBaseUrl();
const PLATFORM_ADMIN_CSRF_COOKIE = "__Host-hyperion-platform-admin-csrf";

export function readCookieValue(name: string, cookieSource?: string): string | undefined {
  const source = cookieSource ?? (typeof document === "undefined" ? "" : document.cookie);
  let result: string | undefined;
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    if (result !== undefined) return undefined;
    try {
      result = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return result;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
interface RequestOptions {
  csrf?: boolean;
}

async function request<T>(
  path: string,
  method: Method = "GET",
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  if (method !== "GET") {
    headers.set("x-requested-with", "platform-admin-console");
    const csrf = options.csrf === false ? undefined : readCookieValue(PLATFORM_ADMIN_CSRF_COOKIE);
    if (csrf) headers.set("x-csrf-token", csrf);
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => undefined)) as
    ResponseEnvelope<Record<string, unknown>> | undefined;

  if (!response.ok) {
    const data = payload?.data;
    const message = data && "error" in data ? String(data.error) : `${response.status} ${response.statusText}`;
    throw new ApiError(response.status, message);
  }

  return payload?.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, "POST", body, options),
  patch: <T>(path: string, body: unknown) => request<T>(path, "PATCH", body),
  put: <T>(path: string, body: unknown) => request<T>(path, "PUT", body),
  delete: <T>(path: string) => request<T>(path, "DELETE")
};
