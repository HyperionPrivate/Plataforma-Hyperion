import { timingSafeEqual } from "node:crypto";
import { isRestrictedDeploymentEnvironment } from "@hyperion/nova-config";

export const INTERNAL_CALLER_HEADER = "x-hyperion-caller" as const;

export interface InternalRequestHeaders {
  readonly authorization?: string;
  readonly [INTERNAL_CALLER_HEADER]?: string | string[];
}

export type InternalCredentialMap = Readonly<Record<string, string | undefined>>;

export type InternalAuthorizationFailure = {
  readonly statusCode: 401 | 403 | 503;
  readonly message: string;
};

const CALLER_PATTERN = /^[a-z][a-z0-9-]{1,79}$/;
const PRODUCTION_CREDENTIAL_PATTERN = /^[A-Za-z][A-Za-z0-9._~-]{23,}$/;

/**
 * Reads a workload credential without ever returning an invalid production
 * secret. Development and test environments may use shorter controlled values.
 */
export function readInternalCredential(env: NodeJS.ProcessEnv, variableName: string): string | undefined {
  const value = env[variableName]?.trim();
  if (!value) return undefined;

  if ([...value].some((character) => /\s/u.test(character) || isAsciiControl(character))) {
    throw new Error(`${variableName} must not contain whitespace or control characters`);
  }
  if (isRestrictedDeploymentEnvironment(env) && !PRODUCTION_CREDENTIAL_PATTERN.test(value)) {
    throw new Error(`${variableName} must be at least 24 safe characters in production/staging`);
  }
  return value;
}

function isAsciiControl(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
}

/** Builds source-attested headers for one internal HTTP edge. */
export function createInternalAuthorizationHeaders(caller: string, token: string | undefined): Record<string, string> {
  if (!CALLER_PATTERN.test(caller)) throw new Error("Internal caller identity is invalid");
  if (!token) throw new Error(`Internal credential is missing for ${caller}`);

  return {
    authorization: `Bearer ${token}`,
    [INTERNAL_CALLER_HEADER]: caller
  };
}

/**
 * Validates both the asserted workload and its edge credential. A receiver
 * only receives credentials for callers it deliberately trusts.
 */
export function validateInternalAuthorization(
  headers: InternalRequestHeaders,
  credentials: InternalCredentialMap
): InternalAuthorizationFailure | undefined {
  const configured = Object.entries(credentials).filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (configured.length === 0) {
    return { statusCode: 503, message: "Internal workload credentials are not configured" };
  }

  const caller = readInternalCaller(headers);
  if (!caller || !CALLER_PATTERN.test(caller)) {
    return { statusCode: 401, message: "Unauthorized internal caller" };
  }

  const expectedToken = credentials[caller];
  if (!expectedToken) {
    return { statusCode: 403, message: "Forbidden internal caller" };
  }

  const authorization = headers.authorization;
  const expected = `Bearer ${expectedToken}`;
  if (!authorization || !constantTimeEquals(authorization, expected)) {
    return { statusCode: 401, message: "Unauthorized internal caller" };
  }

  return undefined;
}

export function readInternalCaller(headers: InternalRequestHeaders): string | undefined {
  const rawCaller = headers[INTERNAL_CALLER_HEADER];
  if (Array.isArray(rawCaller)) return undefined;
  const caller = rawCaller?.trim();
  return caller && CALLER_PATTERN.test(caller) ? caller : undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
