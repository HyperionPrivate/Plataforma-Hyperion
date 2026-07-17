/** Browser auth helpers for live pilot-core calls (Bearer from sessionStorage). */

const TOKEN_KEY = "pulso_access_token";
const EXPIRES_KEY = "pulso_access_expires_at";

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

export function getAccessExpiresAt(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(EXPIRES_KEY);
}

export function setAccessToken(token: string, expiresAt?: string | null): void {
  window.sessionStorage.setItem(TOKEN_KEY, token.trim());
  if (expiresAt) {
    window.sessionStorage.setItem(EXPIRES_KEY, expiresAt);
  } else {
    window.sessionStorage.removeItem(EXPIRES_KEY);
  }
}

export function clearAccessToken(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.sessionStorage.removeItem(EXPIRES_KEY);
}

/** True when we have a token and (if known) it is not past expiresAt. */
export function hasUsableSession(): boolean {
  const token = getAccessToken();
  if (!token) return false;
  const expiresAt = getAccessExpiresAt();
  if (!expiresAt) return true;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return true;
  // Refresh a minute early so Lab mutations don't race expiry.
  return Date.now() < ms - 60_000;
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

/** Clear local session and send the user back to /login (browser only). */
export function redirectToLogin(reason?: string): void {
  if (typeof window === "undefined") return;
  clearAccessToken();
  const next = `${window.location.pathname}${window.location.search}` || "/dashboard";
  const qs = new URLSearchParams({ next });
  if (reason) qs.set("reason", reason);
  window.location.assign(`/login?${qs.toString()}`);
}
