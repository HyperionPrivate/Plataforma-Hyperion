import { createHmac } from "node:crypto";

export const OPERATOR_ASSERTION_HEADER = "x-hyperion-operator-assertion" as const;
const CLAIM_PART_PATTERN = /^[^|\r\n]{1,255}$/;

export interface NovaOperatorAssertionClaims {
  operatorId: string;
  role: string;
  tenantId: string;
  expiresAtUnix: number;
}

/** Wire-compatible with service-runtime, but owned by the NOVA edge closure. */
export function createNovaOperatorAssertion(claims: NovaOperatorAssertionClaims, secret: string): string {
  if (secret.length < 24) throw new Error("NOVA_OPERATOR_ASSERTION_KEY must be at least 24 characters");
  if (
    !CLAIM_PART_PATTERN.test(claims.operatorId) ||
    !CLAIM_PART_PATTERN.test(claims.role) ||
    !CLAIM_PART_PATTERN.test(claims.tenantId) ||
    !Number.isSafeInteger(claims.expiresAtUnix) ||
    claims.expiresAtUnix <= 0
  ) {
    throw new Error("NOVA operator assertion claims are invalid");
  }

  const payload = `${claims.operatorId}|${claims.role}|${claims.tenantId}|NOVA|${claims.expiresAtUnix}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}|${signature}`;
}
