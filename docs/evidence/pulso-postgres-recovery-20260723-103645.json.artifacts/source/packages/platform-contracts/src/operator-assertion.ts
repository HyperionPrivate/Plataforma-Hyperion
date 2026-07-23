import { createHmac } from "node:crypto";

export const OPERATOR_ASSERTION_HEADER = "x-hyperion-operator-assertion" as const;

export interface PlatformOperatorAssertionClaims {
  readonly operatorId: string;
  readonly role: string;
  readonly tenantId?: string;
  readonly productId?: string;
  readonly expiresAtUnix: number;
}

const CLAIM_PART_PATTERN = /^[^|\r\n]{1,255}$/;

/**
 * Provider-owned encoder for the existing Hyperion operator-assertion wire
 * format. Verification remains in each receiving service.
 */
export function createOperatorAssertion(claims: PlatformOperatorAssertionClaims, secret: string): string {
  if (!secret || secret.length < 24) {
    throw new Error("Platform operator assertion key must be at least 24 characters");
  }
  if (
    !CLAIM_PART_PATTERN.test(claims.operatorId) ||
    !CLAIM_PART_PATTERN.test(claims.role) ||
    (claims.tenantId !== undefined && !CLAIM_PART_PATTERN.test(claims.tenantId)) ||
    (claims.productId !== undefined && !CLAIM_PART_PATTERN.test(claims.productId)) ||
    (claims.productId !== undefined && claims.tenantId === undefined) ||
    !Number.isSafeInteger(claims.expiresAtUnix) ||
    claims.expiresAtUnix <= 0
  ) {
    throw new Error("Platform operator assertion claims are invalid");
  }
  const payload = claims.productId
    ? `${claims.operatorId}|${claims.role}|${claims.tenantId}|${claims.productId}|${claims.expiresAtUnix}`
    : claims.tenantId
      ? `${claims.operatorId}|${claims.role}|${claims.tenantId}|${claims.expiresAtUnix}`
      : `${claims.operatorId}|${claims.role}|${claims.expiresAtUnix}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}|${signature}`;
}
