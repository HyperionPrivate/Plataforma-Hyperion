import { createHmac } from "node:crypto";
import { pulsoProductId } from "@hyperion/pulso-contracts";

export const OPERATOR_ASSERTION_HEADER = "x-hyperion-operator-assertion" as const;
const CLAIM_PART_PATTERN = /^[^|\r\n]{1,255}$/;

export interface PulsoOperatorAssertionClaims {
  operatorId: string;
  role: string;
  tenantId: string;
  expiresAtUnix: number;
}

/** Wire-compatible with service-runtime, but owned by the PULSO edge closure. */
export function createPulsoOperatorAssertion(claims: PulsoOperatorAssertionClaims, secret: string): string {
  if (secret.length < 24) throw new Error("PULSO_OPERATOR_ASSERTION_KEY must be at least 24 characters");
  if (
    !CLAIM_PART_PATTERN.test(claims.operatorId) ||
    !CLAIM_PART_PATTERN.test(claims.role) ||
    !CLAIM_PART_PATTERN.test(claims.tenantId) ||
    !Number.isSafeInteger(claims.expiresAtUnix) ||
    claims.expiresAtUnix <= 0
  ) {
    throw new Error("PULSO operator assertion claims are invalid");
  }

  const payload = `${claims.operatorId}|${claims.role}|${claims.tenantId}|${pulsoProductId}|${claims.expiresAtUnix}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}|${signature}`;
}
