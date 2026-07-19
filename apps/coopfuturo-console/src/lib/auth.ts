/** Browser session helpers. Credentials remain in customer-namespaced same-origin cookies. */

const CSRF_COOKIE = "__Host-hyperion-coopfuturo-csrf";

export function isLiveApiMode(): boolean {
  return (process.env.NEXT_PUBLIC_API_MODE ?? "mock").toLowerCase() === "live";
}

/** Production enables this; local mock development may leave it disabled. */
export function requireAuthEnabled(): boolean {
  return (
    isLiveApiMode() ||
    (process.env.NEXT_PUBLIC_REQUIRE_AUTH ?? "").toLowerCase() === "true"
  );
}

/** The browser only talks to the same-origin customer adapter. */
export function pilotCoreBaseUrl(): "/pilot-core" {
  return "/pilot-core";
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function sessionHeaders(
  extra?: HeadersInit,
  options: { csrf?: boolean } = {},
): Headers {
  const headers = new Headers(extra);
  if (options.csrf) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }
  return headers;
}

export async function hasUsableSession(): Promise<boolean> {
  if (!requireAuthEnabled()) return true;
  try {
    const response = await fetch(`${pilotCoreBaseUrl()}/auth/session`, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function logoutSession(): Promise<void> {
  const response = await fetch(`${pilotCoreBaseUrl()}/auth/logout`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: sessionHeaders({ Accept: "application/json" }, { csrf: true }),
  });
  if (!response.ok && response.status !== 401) {
    throw new Error("No fue posible cerrar la sesión NOVA");
  }
}

export function redirectToLogin(reason?: string): void {
  if (typeof window === "undefined") return;
  const next = `${window.location.pathname}${window.location.search}` || "/dashboard";
  const params = new URLSearchParams({ next });
  if (reason) params.set("reason", reason);
  window.location.assign(`/login?${params.toString()}`);
}
