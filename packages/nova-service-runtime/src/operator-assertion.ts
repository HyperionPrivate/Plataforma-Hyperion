import { createHmac, timingSafeEqual } from "node:crypto";
import { isRestrictedDeploymentEnvironment } from "@hyperion/nova-config";
import { readInternalCredential } from "./internal-auth.js";

export const OPERATOR_ASSERTION_HEADER = "x-hyperion-operator-assertion" as const;

export type OperatorAssertionClaims = {
  readonly operatorId: string;
  readonly role: string;
  readonly tenantId?: string;
  readonly productId?: string;
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

export type ProductSystemAssertionOptions = {
  readonly serviceId: string;
  readonly tenantId: string;
  readonly productId: string;
  readonly secret: string;
  readonly expiresAtUnix?: number;
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
    (claims.productId !== undefined && !CLAIM_PART_PATTERN.test(claims.productId)) ||
    (claims.productId !== undefined && claims.tenantId === undefined) ||
    !Number.isSafeInteger(claims.expiresAtUnix) ||
    claims.expiresAtUnix <= 0
  ) {
    throw new Error("Operator assertion claims are invalid");
  }
  const payload = claims.productId
    ? `${claims.operatorId}|${claims.role}|${claims.tenantId}|${claims.productId}|${claims.expiresAtUnix}`
    : claims.tenantId
      ? `${claims.operatorId}|${claims.role}|${claims.tenantId}|${claims.expiresAtUnix}`
      : `${claims.operatorId}|${claims.role}|${claims.expiresAtUnix}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}|${signature}`;
}

/**
 * Creates the signed operator/tenant/product context used by asynchronous
 * workload deliveries. The producer identity is deliberately carried as the
 * operator and is bound to the reserved `system` role.
 */
export function createProductSystemAssertionHeaders(options: ProductSystemAssertionOptions): Record<string, string> {
  const expiresAtUnix = options.expiresAtUnix ?? Math.floor(Date.now() / 1000) + 60;
  return {
    "x-operator-id": options.serviceId,
    "x-operator-role": "system",
    [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
      {
        operatorId: options.serviceId,
        role: "system",
        tenantId: options.tenantId,
        productId: options.productId,
        expiresAtUnix
      },
      options.secret
    )
  };
}

export function verifyOperatorAssertion(
  raw: string | undefined,
  secret: string | undefined,
  nowUnix = Math.floor(Date.now() / 1000)
): OperatorAssertionClaims | undefined {
  if (!raw || !secret || secret.length < 24) return undefined;
  const parts = raw.split("|");
  if (parts.length !== 4 && parts.length !== 5 && parts.length !== 6) return undefined;
  const operatorId = parts[0];
  const role = parts[1];
  const tenantId = parts.length >= 5 ? parts[2] : undefined;
  const productId = parts.length === 6 ? parts[3] : undefined;
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
    (productId !== undefined && !CLAIM_PART_PATTERN.test(productId)) ||
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
  return productId
    ? { operatorId, role, tenantId: tenantId!, productId, expiresAtUnix }
    : tenantId
      ? { operatorId, role, tenantId, expiresAtUnix }
      : { operatorId, role, expiresAtUnix };
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
  return validateAssertionContext(headers, secret, expectedTenantId, undefined, nowUnix);
}

/**
 * Product-scoped variant used by customer-facing product services. The signed
 * product claim prevents a valid assertion for one product from being replayed
 * against another service that shares the gateway attestation key.
 */
export function validateProductOperatorAssertionContext(
  headers: OperatorAssertionHeaders,
  secret: string | undefined,
  expectedTenantId: string,
  expectedProductId: string,
  nowUnix = Math.floor(Date.now() / 1000)
): OperatorAssertionFailure | undefined {
  if (!secret) {
    return { statusCode: 403, message: "Operator assertion mismatch" };
  }
  return validateAssertionContext(headers, secret, expectedTenantId, expectedProductId, nowUnix);
}

/**
 * Strict workload variant: besides tenant/product it binds the assertion to
 * the exact producer authenticated by the independent workload credential.
 */
export function validateProductSystemAssertionContext(
  headers: OperatorAssertionHeaders,
  secret: string | undefined,
  expectedTenantId: string,
  expectedProductId: string,
  expectedServiceId: string,
  nowUnix = Math.floor(Date.now() / 1000)
): OperatorAssertionFailure | undefined {
  const failure = validateAssertionContext(headers, secret, expectedTenantId, expectedProductId, nowUnix);
  if (failure) return failure;
  if (
    readSingleHeader(headers["x-operator-id"]) !== expectedServiceId ||
    readSingleHeader(headers["x-operator-role"]) !== "system"
  ) {
    return { statusCode: 403, message: "Operator assertion mismatch" };
  }
  return undefined;
}

function validateAssertionContext(
  headers: OperatorAssertionHeaders,
  secret: string | undefined,
  expectedTenantId: string | null | undefined,
  expectedProductId: string | undefined,
  nowUnix: number
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
    (expectedTenantId === null ? claims.tenantId !== undefined : claims.tenantId !== expectedTenantId) ||
    (expectedProductId !== undefined && claims.productId !== expectedProductId)
  ) {
    return { statusCode: 403, message: "Operator assertion mismatch" };
  }
  return undefined;
}

function readSingleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
