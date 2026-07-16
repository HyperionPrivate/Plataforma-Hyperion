/** Browser auth helpers for live pilot-core calls (Bearer from sessionStorage). */

const TOKEN_KEY = "pulso_access_token";

export function isLiveApiMode(): boolean {
  return (process.env.NEXT_PUBLIC_API_MODE ?? "mock").toLowerCase() === "live";
}

/** Contabo/prod UI sets NEXT_PUBLIC_REQUIRE_AUTH=true; local mock/live can omit. */
export function requireAuthEnabled(): boolean {
  return (process.env.NEXT_PUBLIC_REQUIRE_AUTH ?? "").toLowerCase() === "true";
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(TOKEN_KEY);
  return raw?.trim() ? raw.trim() : null;
}

export function setAccessToken(token: string): void {
  window.sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearAccessToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
}

export function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  const token = getAccessToken();
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

/** Resolve pilot-core base URL (same-origin relative path preferred). */
export function pilotCoreBaseUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_PILOT_CORE_URL ?? "/pilot-core").replace(/\/$/, "");
  return raw || "/pilot-core";
}
