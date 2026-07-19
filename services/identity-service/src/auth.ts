import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

function scrypt(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

const DEFAULT_SESSION_TTL_HOURS = 12;

/**
 * Session lifetime in hours. Configurable via SESSION_TTL_HOURS so operators
 * (e.g. the CoopFuturo lab console) can run long sessions without being logged
 * out mid-flow. Falls back to 12h when unset or invalid; clamped to 1..720h.
 */
export function getSessionTtlHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SESSION_TTL_HOURS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SESSION_TTL_HOURS;
  }
  return Math.min(720, Math.max(1, Math.trunc(raw)));
}

export const SESSION_TTL_HOURS = getSessionTtlHours();

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  });

  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  const cost = Number(rawN);
  const blockSize = Number(rawR);
  const parallelism = Number(rawP);
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelism)) {
    return false;
  }

  const salt = Buffer.from(String(rawSalt), "base64url");
  const expected = Buffer.from(String(rawHash), "base64url");
  const derived = await scrypt(password, salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelism,
    maxmem: SCRYPT_MAXMEM
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length >= 20 ? token : undefined;
}
