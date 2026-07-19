import { timingSafeEqual } from "node:crypto";

/**
 * LIWA credentials are accepted only through the dedicated header. Query
 * strings are routinely persisted by proxies, access logs and browser
 * history, so they must never be treated as an authentication channel.
 */
export function isValidLiwaWebhookSecret(headerValue: unknown, configuredSecret: string | undefined): boolean {
  if (typeof headerValue !== "string") return false;

  const expected = configuredSecret?.trim();
  const candidate = headerValue.trim();
  if (!expected || !candidate) return false;

  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return expectedBytes.length === candidateBytes.length && timingSafeEqual(expectedBytes, candidateBytes);
}
