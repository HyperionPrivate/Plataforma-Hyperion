import { createPublicKey, verify, type KeyObject } from "node:crypto";
import {
  accessJwksSchema,
  accessTokenClaimsSchema,
  principalFromAccessTokenClaims,
  type AccessPrincipal
} from "@hyperion/platform-contracts";
import { z } from "zod";

const jwtHeaderSchema = z
  .object({ alg: z.literal("RS256"), kid: z.string().min(1), typ: z.string().optional() })
  .passthrough();

export interface PlatformJwksVerifierOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
  fetch?: typeof fetch;
  cacheTtlMs?: number;
  staleIfErrorMs?: number;
  refreshCooldownMs?: number;
  clockSkewSeconds?: number;
  now?: () => number;
  allowPrivateHttp?: boolean;
  deploymentEnvironment?: string;
}

interface CachedKeys {
  loadedAtMs: number;
  keys: Map<string, KeyObject>;
}

/** Local JWT verification keeps platform administration available during a brief Access outage. */
export class PlatformJwksVerifier {
  readonly #options: Required<Omit<PlatformJwksVerifierOptions, "fetch">> & { fetch: typeof fetch };
  #cache?: CachedKeys;
  #refresh?: Promise<CachedKeys>;
  #refreshAllowedAtMs = 0;

  constructor(options: PlatformJwksVerifierOptions) {
    const jwksUrl = parseJwksUrl(
      options.jwksUrl,
      options.allowPrivateHttp ?? false,
      options.deploymentEnvironment ?? "production"
    );
    if (!options.issuer.trim() || !options.audience.trim()) {
      throw new Error("Access token issuer and audience are required");
    }
    const refreshCooldownMs = options.refreshCooldownMs ?? 5_000;
    if (!Number.isSafeInteger(refreshCooldownMs) || refreshCooldownMs < 1 || refreshCooldownMs > 60_000) {
      throw new Error("JWKS refresh cooldown must be between 1 and 60000 milliseconds");
    }
    this.#options = {
      ...options,
      jwksUrl,
      issuer: options.issuer.trim(),
      audience: options.audience.trim(),
      fetch: options.fetch ?? fetch,
      cacheTtlMs: options.cacheTtlMs ?? 5 * 60_000,
      staleIfErrorMs: options.staleIfErrorMs ?? 24 * 60 * 60_000,
      refreshCooldownMs,
      clockSkewSeconds: options.clockSkewSeconds ?? 30,
      now: options.now ?? Date.now,
      allowPrivateHttp: options.allowPrivateHttp ?? false,
      deploymentEnvironment: options.deploymentEnvironment ?? "production"
    };
  }

  async resolve(token: string): Promise<AccessPrincipal | undefined> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return undefined;
      const encodedHeader = parts[0]!;
      const encodedPayload = parts[1]!;
      const header = jwtHeaderSchema.parse(decodeJson(encodedHeader));
      const key = await this.#getKey(header.kid);
      if (!key) return undefined;
      if (
        !verify(
          "RSA-SHA256",
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          key,
          Buffer.from(parts[2]!, "base64url")
        )
      ) {
        return undefined;
      }
      const claims = accessTokenClaimsSchema.parse(decodeJson(encodedPayload));
      const nowUnix = Math.floor(this.#options.now() / 1000);
      const skew = this.#options.clockSkewSeconds;
      const audienceMatches =
        typeof claims.aud === "string"
          ? claims.aud === this.#options.audience
          : claims.aud.includes(this.#options.audience);
      if (
        claims.iss !== this.#options.issuer ||
        !audienceMatches ||
        claims.iat === undefined ||
        claims.nbf === undefined ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 930 ||
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
    const cachedKey = this.#cache?.keys.get(kid);
    const cacheAge = this.#cache ? now - this.#cache.loadedAtMs : Number.POSITIVE_INFINITY;
    if (cachedKey && cacheAge <= this.#options.cacheTtlMs) return cachedKey;

    if (this.#refresh) {
      if (cachedKey && cacheAge <= this.#options.staleIfErrorMs) return cachedKey;
      try {
        return (await this.#refresh).keys.get(kid);
      } catch {
        return undefined;
      }
    }
    if (now < this.#refreshAllowedAtMs) {
      return cachedKey && cacheAge <= this.#options.staleIfErrorMs ? cachedKey : undefined;
    }

    const refreshingForMissingKid = Boolean(this.#cache && !cachedKey);
    if (refreshingForMissingKid) this.#refreshAllowedAtMs = now + this.#options.refreshCooldownMs;
    try {
      return (await this.#loadKeys()).keys.get(kid);
    } catch {
      this.#refreshAllowedAtMs = now + this.#options.refreshCooldownMs;
      return cachedKey && cacheAge <= this.#options.staleIfErrorMs ? cachedKey : undefined;
    }
  }

  async #loadKeys(): Promise<CachedKeys> {
    if (this.#refresh) return this.#refresh;
    this.#refresh = (async () => {
      const response = await this.#options.fetch(this.#options.jwksUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(2_500),
        redirect: "error"
      });
      if (!response.ok) throw new Error("Access JWKS is unavailable");
      const document = accessJwksSchema.parse(await response.json());
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

function parseJwksUrl(value: string, allowPrivateHttp: boolean, deploymentEnvironment: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ACCESS_JWKS_URL must be a valid URL");
  }
  const environment = deploymentEnvironment.trim().toLowerCase();
  const privateHttpAllowed =
    allowPrivateHttp &&
    ["local", "development", "test", "ci"].includes(environment) &&
    ["localhost", "127.0.0.1", "::1", "identity-service"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && privateHttpAllowed)) ||
    url.username ||
    url.password
  ) {
    throw new Error("ACCESS_JWKS_URL must use HTTPS outside an explicitly allowed local/CI service network");
  }
  return url.toString();
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
