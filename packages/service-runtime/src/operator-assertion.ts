import { createHmac, timingSafeEqual } from "node:crypto";

export const OPERATOR_ASSERTION_HEADER = "x-hyperion-operator-assertion" as const;

export type OperatorAssertionClaims = {
  readonly operatorId: string;
  readonly role: string;
  readonly expiresAtUnix: number;
};

/**
 * Binds gateway-attested operator claims to a shared HMAC secret so a stolen
 * edge token alone cannot fabricate `x-operator-role`. Residual risk: theft of
 * both GATEWAY_TO_* and GATEWAY_OPERATOR_ASSERTION_KEY still forges claims until
 * workload identity / mTLS lands.
 */
export function createOperatorAssertion(claims: OperatorAssertionClaims, secret: string): string {
  if (!secret || secret.length < 24) {
    throw new Error("GATEWAY_OPERATOR_ASSERTION_KEY must be at least 24 characters");
  }
  const payload = `${claims.operatorId}|${claims.role}|${claims.expiresAtUnix}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}|${signature}`;
}

export function verifyOperatorAssertion(
  raw: string | undefined,
  secret: string | undefined,
  nowUnix = Math.floor(Date.now() / 1000)
): OperatorAssertionClaims | undefined {
  if (!raw || !secret || secret.length < 24) return undefined;
  const parts = raw.split("|");
  if (parts.length !== 4) return undefined;
  const [operatorId, role, expiresRaw, signature] = parts;
  if (!operatorId || !role || !expiresRaw || !signature) return undefined;
  const expiresAtUnix = Number(expiresRaw);
  if (!Number.isFinite(expiresAtUnix) || expiresAtUnix < nowUnix) return undefined;

  const payload = `${operatorId}|${role}|${expiresAtUnix}`;
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  return { operatorId, role, expiresAtUnix };
}
