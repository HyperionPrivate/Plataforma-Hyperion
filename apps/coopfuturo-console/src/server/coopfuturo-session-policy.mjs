export const COOPFUTURO_SESSION_COOKIE = "__Host-hyperion-coopfuturo-session";
export const COOPFUTURO_CSRF_COOKIE = "__Host-hyperion-coopfuturo-csrf";

const NOVA_SESSION_COOKIE = "__Host-hyperion-nova-session";
const NOVA_CSRF_COOKIE = "__Host-hyperion-nova-csrf";

const BROWSER_TO_NOVA = new Map([
  [COOPFUTURO_SESSION_COOKIE, NOVA_SESSION_COOKIE],
  [COOPFUTURO_CSRF_COOKIE, NOVA_CSRF_COOKIE],
]);
const NOVA_TO_BROWSER = new Map([
  [NOVA_SESSION_COOKIE, COOPFUTURO_SESSION_COOKIE],
  [NOVA_CSRF_COOKIE, COOPFUTURO_CSRF_COOKIE],
]);
const COOKIE_VALUE_PATTERN = /^[A-Za-z0-9._~%+-]+$/;

export function translateCoopfuturoCookieHeader(rawHeader) {
  if (typeof rawHeader !== "string" || !rawHeader) return "";
  const translated = [];
  const seen = new Set();
  for (const part of rawHeader.split(";")) {
    const cookie = part.trim();
    const separator = cookie.indexOf("=");
    if (separator < 1) continue;
    const upstreamName = BROWSER_TO_NOVA.get(cookie.slice(0, separator));
    const value = cookie.slice(separator + 1);
    if (!upstreamName || !value || !COOKIE_VALUE_PATTERN.test(value)) continue;
    if (seen.has(upstreamName)) return "";
    seen.add(upstreamName);
    translated.push(`${upstreamName}=${value}`);
  }
  return translated.join("; ");
}

export function translateNovaSetCookie(rawCookie) {
  if (typeof rawCookie !== "string" || !rawCookie) return undefined;
  const parts = rawCookie.split(";").map((part) => part.trim());
  const separator = parts[0]?.indexOf("=") ?? -1;
  if (separator < 1) return undefined;
  const upstreamName = parts[0].slice(0, separator);
  const browserName = NOVA_TO_BROWSER.get(upstreamName);
  if (!browserName) return undefined;

  const attributes = parts.slice(1);
  const lowerAttributes = attributes.map((attribute) => attribute.toLowerCase());
  const hasPathRoot = lowerAttributes.includes("path=/");
  const hasSecure = lowerAttributes.includes("secure");
  const hasStrictSameSite = lowerAttributes.includes("samesite=strict");
  const hasDomain = lowerAttributes.some((attribute) => attribute.startsWith("domain="));
  const hasHttpOnly = lowerAttributes.includes("httponly");
  if (!hasPathRoot || !hasSecure || !hasStrictSameSite || hasDomain) return undefined;
  if (upstreamName === NOVA_SESSION_COOKIE && !hasHttpOnly) return undefined;

  parts[0] = `${browserName}${parts[0].slice(separator)}`;
  return parts.join("; ");
}
