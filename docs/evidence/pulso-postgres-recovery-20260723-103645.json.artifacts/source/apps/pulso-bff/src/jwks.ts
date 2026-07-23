import { createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  accessTokenClaimsSchema,
  principalFromAccessTokenClaims,
  type AccessPrincipal
} from "@hyperion/platform-contracts";
import { z } from "zod";

const jwtHeaderSchema = z
  .object({ alg: z.literal("RS256"), kid: z.string().min(1), typ: z.string().optional() })
  .passthrough();
const jwkSchema = z
  .object({
    kty: z.literal("RSA"),
    kid: z.string().min(1),
    n: z.string().min(1),
    e: z.string().min(1),
    alg: z.literal("RS256").optional(),
    use: z.literal("sig").optional()
  })
  .passthrough();
const jwksSchema = z.object({ keys: z.array(jwkSchema).min(1) }).strict();
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60 + 30;
const MAX_JWKS_DOCUMENT_BYTES = 64 * 1024;
const JWKS_JSON_MEDIA_TYPE_PATTERN = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/i;

export interface JwksAccessTokenVerifierOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
  /** Local/CI-only escape hatch for the private Access service DNS name. */
  allowPrivateHttp?: boolean;
  fetch?: typeof fetch;
  cacheTtlMs?: number;
  staleIfErrorMs?: number;
  refreshCooldownMs?: number;
  clockSkewSeconds?: number;
  now?: () => number;
}

interface CachedKeys {
  loadedAtMs: number;
  keys: Map<string, KeyObject>;
}

export class JwksAccessTokenVerifier {
  readonly #options: Required<Omit<JwksAccessTokenVerifierOptions, "fetch">> & { fetch: typeof fetch };
  #cache?: CachedKeys;
  #refresh?: Promise<CachedKeys>;
  #nextRefreshAllowedAtMs = 0;

  constructor(options: JwksAccessTokenVerifierOptions) {
    const jwksUrl = parseHttpsOrLocalHttpUrl(options.jwksUrl, options.allowPrivateHttp === true);
    if (!options.issuer.trim() || !options.audience.trim()) {
      throw new Error("Access token issuer and audience are required");
    }
    const refreshCooldownMs = options.refreshCooldownMs ?? 5_000;
    if (!Number.isFinite(refreshCooldownMs) || refreshCooldownMs < 0) {
      throw new Error("Access JWKS refresh cooldown must be non-negative");
    }
    this.#options = {
      ...options,
      jwksUrl,
      allowPrivateHttp: options.allowPrivateHttp ?? false,
      issuer: options.issuer.trim(),
      audience: options.audience.trim(),
      fetch: options.fetch ?? fetch,
      cacheTtlMs: options.cacheTtlMs ?? 5 * 60_000,
      staleIfErrorMs: options.staleIfErrorMs ?? 24 * 60 * 60_000,
      refreshCooldownMs: Math.trunc(refreshCooldownMs),
      clockSkewSeconds: options.clockSkewSeconds ?? 30,
      now: options.now ?? Date.now
    };
  }

  async readiness(): Promise<boolean> {
    const now = this.#options.now();
    if (this.#cache && this.#cache.keys.size > 0 && now - this.#cache.loadedAtMs <= this.#options.cacheTtlMs) {
      return true;
    }
    const hasUsableStaleKeys = Boolean(
      this.#cache && this.#cache.keys.size > 0 && now - this.#cache.loadedAtMs <= this.#options.staleIfErrorMs
    );
    if (now < this.#nextRefreshAllowedAtMs) return hasUsableStaleKeys;

    try {
      return (await this.#loadKeys()).keys.size > 0;
    } catch {
      this.#nextRefreshAllowedAtMs = this.#options.now() + this.#options.refreshCooldownMs;
      return hasUsableStaleKeys;
    }
  }

  async resolve(token: string): Promise<AccessPrincipal | undefined> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      const encodedHeader = parts[0]!;
      const encodedPayload = parts[1]!;
      const encodedSignature = parts[2]!;
      const header = jwtHeaderSchema.parse(parseBase64UrlJson(encodedHeader));
      const key = await this.#getKey(header.kid);
      if (!key) return undefined;
      if (
        !verify(
          "RSA-SHA256",
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          key,
          Buffer.from(encodedSignature, "base64url")
        )
      ) {
        return undefined;
      }

      const claims = accessTokenClaimsSchema.parse(parseBase64UrlJson(encodedPayload));
      const nowUnix = Math.floor(this.#options.now() / 1000);
      const skew = this.#options.clockSkewSeconds;
      if (
        claims.iss !== this.#options.issuer ||
        !audienceContains(claims.aud, this.#options.audience) ||
        claims.iat === undefined ||
        claims.nbf === undefined ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > MAX_ACCESS_TOKEN_LIFETIME_SECONDS ||
        claims.exp <= nowUnix - skew ||
        claims.nbf > nowUnix + skew ||
        claims.iat > nowUnix + skew
      ) {
        return undefined;
      }
      return principalFromAccessTokenClaims(claims);
    } catch {
      return undefined;
    }
  }

  async #getKey(kid: string): Promise<KeyObject | undefined> {
    const now = this.#options.now();
    if (this.#cache && now - this.#cache.loadedAtMs <= this.#options.cacheTtlMs) {
      const cached = this.#cache.keys.get(kid);
      if (cached) return cached;
    }
    const staleKey =
      this.#cache && now - this.#cache.loadedAtMs <= this.#options.staleIfErrorMs
        ? this.#cache.keys.get(kid)
        : undefined;
    if (now < this.#nextRefreshAllowedAtMs) return staleKey;

    try {
      const fresh = await this.#loadKeys();
      const key = fresh.keys.get(kid);
      if (!key) this.#nextRefreshAllowedAtMs = this.#options.now() + this.#options.refreshCooldownMs;
      return key;
    } catch {
      this.#nextRefreshAllowedAtMs = this.#options.now() + this.#options.refreshCooldownMs;
      return staleKey;
    }
  }

  async #loadKeys(): Promise<CachedKeys> {
    if (this.#refresh) return this.#refresh;
    this.#refresh = (async () => {
      const response = await this.#options.fetch(this.#options.jwksUrl, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(2_500)
      });
      if (!response.ok) {
        await cancelResponseBody(response);
        throw new Error("Access JWKS is unavailable");
      }
      const document = await readJwksDocument(response);
      const keys = new Map<string, KeyObject>();
      for (const key of document.keys) keys.set(key.kid, createPublicKey({ key, format: "jwk" }));
      const cache = { loadedAtMs: this.#options.now(), keys };
      this.#cache = cache;
      return cache;
    })();
    try {
      return await this.#refresh;
    } finally {
      this.#refresh = undefined;
    }
  }
}

async function readJwksDocument(response: Response): Promise<z.infer<typeof jwksSchema>> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
  if (!JWKS_JSON_MEDIA_TYPE_PATTERN.test(mediaType)) {
    await cancelResponseBody(response);
    throw new Error("Access JWKS returned a non-JSON response");
  }
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_JWKS_DOCUMENT_BYTES) {
    await cancelResponseBody(response);
    throw new Error("Access JWKS document exceeds the allowed size");
  }
  const body = await readBoundedJwksBody(response);
  const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  return jwksSchema.parse(payload);
}

async function readBoundedJwksBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JWKS_DOCUMENT_BYTES) {
        throw new Error("Access JWKS document exceeds the allowed size");
      }
      chunks.push(value);
    }
  } catch (error) {
    await cancelReader(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

function parseBase64UrlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function audienceContains(value: string | string[], expected: string): boolean {
  return typeof value === "string" ? value === expected : value.includes(expected);
}

function parseHttpsOrLocalHttpUrl(value: string, allowPrivateHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ACCESS_JWKS_URL must be a valid URL");
  }
  const privateHttpHosts = new Set(["localhost", "127.0.0.1", "::1", "identity-service"]);
  const permittedPrivateHttp = allowPrivateHttp && parsed.protocol === "http:" && privateHttpHosts.has(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !permittedPrivateHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("ACCESS_JWKS_URL must use HTTPS unless private HTTP is explicitly enabled for local/CI");
  }
  return parsed.toString();
}
