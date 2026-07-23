import { createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  accessJwkSchema,
  accessJwksSchema,
  accessPrincipalSchema,
  accessSessionSchema,
  accessTokenClaimsSchema,
  platformControlTenantId,
  principalFromAccessTokenClaims,
  type AccessJwk,
  type AccessJwks,
  type AccessPrincipal,
  type AccessSession,
  type AccessTokenClaims
} from "@hyperion/platform-contracts";
import { z } from "zod";

const accessJwtHeaderSchema = z
  .object({
    alg: z.literal("RS256"),
    kid: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
    typ: z.literal("JWT")
  })
  .strict();

const DEFAULT_TOKEN_TTL_SECONDS = 300;
const MIN_TOKEN_TTL_SECONDS = 60;
const MAX_TOKEN_TTL_SECONDS = 900;
export const MAX_ACCESS_TOKEN_BYTES = 3500;

export class AccessTokenSizeError extends Error {
  constructor(readonly tokenBytes: number) {
    super(`Access token exceeds the ${MAX_ACCESS_TOKEN_BYTES}-byte cookie-safe budget (${tokenBytes} bytes)`);
    this.name = "AccessTokenSizeError";
  }
}

export interface AccessTokenServiceOptions {
  issuer: string;
  audience: string;
  keyId: string;
  privateKey: string | Buffer | KeyObject;
  previousJwks?: AccessJwks;
  ttlSeconds?: number;
  clockSkewSeconds?: number;
  now?: () => number;
}

export interface AccessTokenEnvironmentDependencies {
  readTextFile?: (path: string) => Promise<string>;
}

/**
 * Issues brief, audience-bound Access JWTs and verifies them without a database
 * or an Identity/Access network round-trip. The published set may retain prior
 * public keys during a bounded rotation window; only the active private key can
 * issue new tokens.
 */
export class AccessTokenService {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly ttlSeconds: number;
  readonly #clockSkewSeconds: number;
  readonly #privateKey: KeyObject;
  readonly #publicKeys: Map<string, KeyObject>;
  readonly #jwks: AccessJwks;
  readonly #now: () => number;

  constructor(options: AccessTokenServiceOptions) {
    this.issuer = validateIssuer(options.issuer);
    this.audience = validateAudience(options.audience);
    this.keyId = validateKeyId(options.keyId);
    this.ttlSeconds = validateTtl(options.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS);
    this.#clockSkewSeconds = validateClockSkew(options.clockSkewSeconds ?? 30);
    this.#now = options.now ?? Date.now;
    this.#privateKey = readRsaPrivateKey(options.privateKey);

    const activePublicKey = createPublicKey(this.#privateKey);
    const activeJwk = exportAccessJwk(activePublicKey, this.keyId);
    const previous = options.previousJwks?.keys ?? [];
    const allJwks = accessJwksSchema.parse({ keys: [activeJwk, ...previous] });
    if (new Set(allJwks.keys.map((key) => key.kid)).size !== allJwks.keys.length) {
      throw new Error("Access JWKS key ids must be unique");
    }

    this.#jwks = allJwks;
    this.#publicKeys = new Map(allJwks.keys.map((jwk) => [jwk.kid, createPublicKey({ key: jwk, format: "jwk" })]));
  }

  issue(principalInput: z.input<typeof accessPrincipalSchema>): AccessSession {
    const principal = accessPrincipalSchema.parse(principalInput);
    const nowUnix = Math.floor(this.#now() / 1000);
    const grants = principal.grants.filter((grant) => grant.active && grantMatchesAudience(grant, this.audience));
    const claims = accessTokenClaimsSchema.parse({
      sub: principal.operator.id,
      email: principal.operator.email,
      displayName: principal.operator.displayName,
      platformRole: principal.operator.role,
      grants,
      iss: this.issuer,
      aud: this.audience,
      iat: nowUnix,
      nbf: nowUnix,
      exp: nowUnix + this.ttlSeconds,
      jti: randomUUID()
    });
    const encodedHeader = encodeJson({ alg: "RS256", kid: this.keyId, typ: "JWT" });
    const encodedClaims = encodeJson(claims);
    const signature = sign("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedClaims}`), this.#privateKey);
    const token = `${encodedHeader}.${encodedClaims}.${signature.toString("base64url")}`;
    const tokenBytes = Buffer.byteLength(token, "utf8");
    if (tokenBytes > MAX_ACCESS_TOKEN_BYTES) throw new AccessTokenSizeError(tokenBytes);

    return accessSessionSchema.parse({
      token,
      accessToken: token,
      tokenType: "Bearer",
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      operator: principal.operator,
      grants
    });
  }

  verify(token: string): AccessPrincipal | undefined {
    return this.verifyClaims(token)?.principal;
  }

  /** Cryptographic + claim check; caller must still consult the jti denylist when a DB is available. */
  verifyClaims(token: string): { principal: AccessPrincipal; claims: AccessTokenClaims } | undefined {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      const encodedHeader = parts[0]!;
      const encodedClaims = parts[1]!;
      const encodedSignature = parts[2]!;
      const header = accessJwtHeaderSchema.parse(decodeJson(encodedHeader));
      const publicKey = this.#publicKeys.get(header.kid);
      if (!publicKey) return undefined;
      if (
        !verify(
          "RSA-SHA256",
          Buffer.from(`${encodedHeader}.${encodedClaims}`),
          publicKey,
          Buffer.from(encodedSignature, "base64url")
        )
      ) {
        return undefined;
      }

      const claims = accessTokenClaimsSchema.parse(decodeJson(encodedClaims));
      if (!this.#claimsAreCurrent(claims)) return undefined;
      return { principal: principalFromAccessTokenClaims(claims), claims };
    } catch {
      return undefined;
    }
  }

  jwks(): AccessJwks {
    // Return a copy so callers cannot mutate the in-memory verification set.
    return { keys: this.#jwks.keys.map((key) => ({ ...key })) };
  }

  #claimsAreCurrent(claims: AccessTokenClaims): boolean {
    const nowUnix = Math.floor(this.#now() / 1000);
    const skew = this.#clockSkewSeconds;
    const audienceMatches =
      typeof claims.aud === "string" ? claims.aud === this.audience : claims.aud.includes(this.audience);
    return (
      claims.iss === this.issuer &&
      audienceMatches &&
      claims.exp > nowUnix - skew &&
      claims.nbf !== undefined &&
      claims.nbf <= nowUnix + skew &&
      claims.iat !== undefined &&
      claims.iat <= nowUnix + skew &&
      claims.exp - claims.iat <= this.ttlSeconds + skew
    );
  }
}

function grantMatchesAudience(
  grant: z.output<typeof accessPrincipalSchema>["grants"][number],
  audience: string
): boolean {
  if (audience === "nova-bff") return grant.productId === "NOVA";
  if (audience === "lumen-bff") return grant.productId === "LUMEN";
  if (audience === "pulso-bff") return grant.productId === "PULSO_IRIS";
  if (audience === "platform-admin-bff") {
    return grant.productId === "PLATFORM" && grant.tenantId === platformControlTenantId;
  }
  return false;
}

/**
 * Loads signing material once at process startup. Restricted and CI runtimes
 * fail closed; local development may keep the N-1 opaque-session path when no
 * signing key has been configured.
 */
export async function loadAccessTokenService(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: AccessTokenEnvironmentDependencies = {}
): Promise<AccessTokenService | undefined> {
  const services = await loadAccessTokenServices(environment, dependencies);
  return services.values().next().value;
}

export async function loadAccessTokenServices(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: AccessTokenEnvironmentDependencies = {}
): Promise<ReadonlyMap<string, AccessTokenService>> {
  const privateKeyFile = environment.ACCESS_TOKEN_PRIVATE_KEY_FILE?.trim() || undefined;
  const privateKeyPem = environment.ACCESS_TOKEN_PRIVATE_KEY_PEM?.trim() || undefined;
  const required = signingKeysRequired(environment);
  if (privateKeyFile && privateKeyPem) {
    throw new Error("Configure only one of ACCESS_TOKEN_PRIVATE_KEY_FILE or ACCESS_TOKEN_PRIVATE_KEY_PEM");
  }
  if (!privateKeyFile && !privateKeyPem) {
    if (required) {
      throw new Error("Access RS256 signing key is required in CI, staging, and production");
    }
    return new Map();
  }

  const readTextFile = dependencies.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const key = privateKeyPem ?? (await readTextFile(privateKeyFile!));
  const previousJwksFile = environment.ACCESS_TOKEN_PREVIOUS_JWKS_FILE?.trim();
  const previousJwks = previousJwksFile
    ? accessJwksSchema.parse(JSON.parse(await readTextFile(previousJwksFile)))
    : undefined;

  const issuer = requireEnvironment(environment, "ACCESS_TOKEN_ISSUER");
  const keyId = requireEnvironment(environment, "ACCESS_TOKEN_KEY_ID");
  const ttlSeconds = readIntegerEnvironment(environment.ACCESS_TOKEN_TTL_SECONDS, DEFAULT_TOKEN_TTL_SECONDS);
  return new Map(
    readConfiguredAudiences(environment).map((audience) => [
      audience,
      new AccessTokenService({ issuer, audience, keyId, privateKey: key, previousJwks, ttlSeconds })
    ])
  );
}

export function signingKeysRequired(environment: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = environment.HYPERION_ENVIRONMENT?.trim().toLowerCase();
  if (explicit) return ["ci", "staging", "production"].includes(explicit);
  const nodeEnvironment = environment.NODE_ENV?.trim().toLowerCase();
  return ["test", "ci", "staging", "production"].includes(nodeEnvironment ?? "");
}

function exportAccessJwk(publicKey: KeyObject, kid: string): AccessJwk {
  const exported = publicKey.export({ format: "jwk" });
  return accessJwkSchema.parse({
    kty: exported.kty,
    kid,
    n: exported.n,
    e: exported.e,
    alg: "RS256",
    use: "sig"
  });
}

function readRsaPrivateKey(value: string | Buffer | KeyObject): KeyObject {
  let key: KeyObject;
  try {
    key = value instanceof Object && "type" in value ? (value as KeyObject) : createPrivateKey(value);
  } catch {
    throw new Error("ACCESS_TOKEN_PRIVATE_KEY is not a valid private key");
  }
  if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
    throw new Error("ACCESS_TOKEN_PRIVATE_KEY must be an RSA private key");
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength;
  if (modulusLength === undefined || modulusLength < 2048) {
    throw new Error("ACCESS_TOKEN_PRIVATE_KEY must use an RSA modulus of at least 2048 bits");
  }
  return key;
}

function validateIssuer(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("ACCESS_TOKEN_ISSUER must be a valid URL");
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error("ACCESS_TOKEN_ISSUER must use HTTPS (localhost HTTP is allowed for development)");
  }
  return trimmed;
}

function validateAudience(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9._:-]{1,127}$/.test(trimmed)) {
    throw new Error("ACCESS_TOKEN_AUDIENCE is invalid");
  }
  return trimmed;
}

function validateKeyId(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(trimmed)) throw new Error("ACCESS_TOKEN_KEY_ID is invalid");
  return trimmed;
}

function validateTtl(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_TOKEN_TTL_SECONDS || value > MAX_TOKEN_TTL_SECONDS) {
    throw new Error(`ACCESS_TOKEN_TTL_SECONDS must be between ${MIN_TOKEN_TTL_SECONDS} and ${MAX_TOKEN_TTL_SECONDS}`);
  }
  return value;
}

function validateClockSkew(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 60) {
    throw new Error("Access token clock skew must be between 0 and 60 seconds");
  }
  return value;
}

function requireEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when Access JWT signing is configured`);
  return value;
}

function readIntegerEnvironment(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error("ACCESS_TOKEN_TTL_SECONDS must be an integer");
  return Number(value);
}

function readConfiguredAudiences(environment: NodeJS.ProcessEnv): string[] {
  const plural = environment.ACCESS_TOKEN_AUDIENCES?.trim();
  const singular = environment.ACCESS_TOKEN_AUDIENCE?.trim();
  const values = (plural ? plural.split(",") : singular ? [singular] : [])
    .map((value) => validateAudience(value))
    .filter((value, index, all) => all.indexOf(value) === index);
  if (values.length === 0) {
    throw new Error(
      "ACCESS_TOKEN_AUDIENCES (or ACCESS_TOKEN_AUDIENCE) is required when Access JWT signing is configured"
    );
  }
  return values;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
