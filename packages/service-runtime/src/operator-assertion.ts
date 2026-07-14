import { createHmac, timingSafeEqual } from "node:crypto";
import { isRestrictedDeploymentEnvironment } from "@hyperion/config";
import { readInternalCredential } from "./internal-auth.js";

export const OPERATOR_ASSERTION_HEADER = "x-hyperion-operator-assertion" as const;

export type OperatorAssertionClaims = {
  readonly operatorId: string;
  readonly role: string;
  readonly tenantId?: string;
  readonly expiresAtUnix: number;
};

export interface OperatorAssertionHeaders {
  readonly [header: string]: string | string[] | undefined;
  readonly [OPERATOR_ASSERTION_HEADER]?: string | string[];
  readonly "x-operator-id"?: string | string[];
  readonly "x-operator-role"?: string | string[];
}

export type OperatorAssertionFailure = {
  readonly statusCode: 403;
  readonly message: "Operator assertion mismatch";
};

const CLAIM_PART_PATTERN = /^[^|\r\n]{1,255}$/;

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
  if (
    !CLAIM_PART_PATTERN.test(claims.operatorId) ||
    !CLAIM_PART_PATTERN.test(claims.role) ||
    (claims.tenantId !== undefined && !CLAIM_PART_PATTERN.test(claims.tenantId)) ||
    !Number.isSafeInteger(claims.expiresAtUnix) ||
    claims.expiresAtUnix <= 0
  ) {
    throw new Error("Operator assertion claims are invalid");
  }
  const payload = claims.tenantId
    ? `${claims.operatorId}|${claims.role}|${claims.tenantId}|${claims.expiresAtUnix}`
    : `${claims.operatorId}|${claims.role}|${claims.expiresAtUnix}`;
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
  if (parts.length !== 4 && parts.length !== 5) return undefined;
  const operatorId = parts[0];
  const role = parts[1];
  const tenantId = parts.length === 5 ? parts[2] : undefined;
  const expiresRaw = parts.at(-2);
  const signature = parts.at(-1);
  if (
    !operatorId ||
    !role ||
    !expiresRaw ||
    !signature ||
    !CLAIM_PART_PATTERN.test(operatorId) ||
    !CLAIM_PART_PATTERN.test(role) ||
    (tenantId !== undefined && !CLAIM_PART_PATTERN.test(tenantId)) ||
    !/^\d+$/u.test(expiresRaw)
  ) {
    return undefined;
  }
  const expiresAtUnix = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAtUnix) || expiresAtUnix <= nowUnix) return undefined;

  const payload = parts.slice(0, -1).join("|");
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
  return tenantId ? { operatorId, role, tenantId, expiresAtUnix } : { operatorId, role, expiresAtUnix };
}

/**
 * Reads the gateway attestation key and makes its absence a startup error in
 * staging/production. Local and CI may omit it to preserve isolated tests.
 */
export function readOperatorAssertionKey(env: NodeJS.ProcessEnv): string | undefined {
  const secret = readInternalCredential(env, "GATEWAY_OPERATOR_ASSERTION_KEY");
  if (secret && secret.length < 24) {
    throw new Error("GATEWAY_OPERATOR_ASSERTION_KEY must be at least 24 characters");
  }
  if (!secret && isRestrictedDeploymentEnvironment(env)) {
    throw new Error("GATEWAY_OPERATOR_ASSERTION_KEY is required in production/staging");
  }
  return secret;
}

/**
 * Verifies that a gateway-signed assertion is current and exactly matches the
 * plain headers consumed by route code plus the tenant selected by the route.
 */
export function validateOperatorAssertionContext(
  headers: OperatorAssertionHeaders,
  secret: string | undefined,
  expectedTenantId: string | null | undefined,
  nowUnix = Math.floor(Date.now() / 1000)
): OperatorAssertionFailure | undefined {
  if (!secret) return undefined;

  const rawAssertion = readSingleHeader(headers[OPERATOR_ASSERTION_HEADER]);
  const operatorId = readSingleHeader(headers["x-operator-id"]);
  const role = readSingleHeader(headers["x-operator-role"]);
  const claims = verifyOperatorAssertion(rawAssertion, secret, nowUnix);
  if (
    !claims ||
    !operatorId ||
    !role ||
    expectedTenantId === undefined ||
    claims.operatorId !== operatorId ||
    claims.role !== role ||
    (expectedTenantId === null ? claims.tenantId !== undefined : claims.tenantId !== expectedTenantId)
  ) {
    return { statusCode: 403, message: "Operator assertion mismatch" };
  }
  return undefined;
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
