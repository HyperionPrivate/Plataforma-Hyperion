import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PlatformJwksVerifier } from "./jwks.js";

describe("platform admin local JWKS verification", () => {
  it("uses a cached key during a temporary Access outage", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "access-key-1", alg: "RS256", use: "sig" };
    let nowMs = 1_900_000_000_000;
    const requestFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const verifier = new PlatformJwksVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "platform-admin-bff",
      fetch: requestFetch,
      cacheTtlMs: 1_000,
      staleIfErrorMs: 60_000,
      now: () => nowMs
    });
    const token = createToken(privateKey, Math.floor(nowMs / 1000));

    expect((await verifier.resolve(token))?.operator.email).toBe("admin@example.com");
    requestFetch.mockRejectedValueOnce(new Error("Access unavailable"));
    nowMs += 2_000;
    expect((await verifier.resolve(token))?.grants[0]?.productId).toBe("PLATFORM");
    expect(requestFetch).toHaveBeenCalledTimes(2);
    expect((await verifier.resolve(token))?.operator.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(
      await verifier.resolve(createToken(privateKey, Math.floor(nowMs / 1000), {}, "unknown-kid"))
    ).toBeUndefined();
    expect(requestFetch).toHaveBeenCalledTimes(2);

    nowMs += 5_001;
    expect((await verifier.resolve(token))?.operator.email).toBe("admin@example.com");
    expect(requestFetch).toHaveBeenCalledTimes(3);
  });

  it("refreshes a fresh cache once for unknown kids and bounds kid-spray until cooldown", async () => {
    const current = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const currentJwk = {
      ...current.publicKey.export({ format: "jwk" }),
      kid: "access-key-1",
      alg: "RS256",
      use: "sig"
    };
    const rotatedJwk = {
      ...rotated.publicKey.export({ format: "jwk" }),
      kid: "access-key-2",
      alg: "RS256",
      use: "sig"
    };
    let nowMs = 1_900_000_000_000;
    let responseNumber = 0;
    const requestFetch = vi.fn(async () => {
      responseNumber += 1;
      const keys = responseNumber >= 3 ? [currentJwk, rotatedJwk] : [currentJwk];
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const verifier = new PlatformJwksVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "platform-admin-bff",
      fetch: requestFetch,
      cacheTtlMs: 60_000,
      refreshCooldownMs: 5_000,
      now: () => nowMs
    });
    const nowUnix = Math.floor(nowMs / 1000);
    expect(await verifier.resolve(createToken(current.privateKey, nowUnix))).toBeDefined();

    const spray = Array.from({ length: 20 }, (_, index) =>
      verifier.resolve(createToken(rotated.privateKey, nowUnix, {}, `spray-${index}`))
    );
    expect((await Promise.all(spray)).every((principal) => principal === undefined)).toBe(true);
    expect(requestFetch).toHaveBeenCalledTimes(2);

    nowMs += 5_001;
    expect(await verifier.resolve(createToken(rotated.privateKey, nowUnix, {}, "access-key-2"))).toBeDefined();
    expect(requestFetch).toHaveBeenCalledTimes(3);
  });

  it("never permits private HTTP JWKS in staging or production", () => {
    expect(
      () =>
        new PlatformJwksVerifier({
          jwksUrl: "http://identity-service:8081/.well-known/jwks.json",
          issuer: "https://access.example.test",
          audience: "platform-admin-bff",
          allowPrivateHttp: true,
          deploymentEnvironment: "production"
        })
    ).toThrow("must use HTTPS");
    expect(
      () =>
        new PlatformJwksVerifier({
          jwksUrl: "http://identity-service:8081/.well-known/jwks.json",
          issuer: "https://access.example.test",
          audience: "platform-admin-bff",
          allowPrivateHttp: true,
          deploymentEnvironment: "ci"
        })
    ).not.toThrow();
  });

  it("requires brief tokens with issued-at and not-before claims", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "access-key-1", alg: "RS256", use: "sig" };
    const nowMs = 1_900_000_000_000;
    const verifier = new PlatformJwksVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "platform-admin-bff",
      fetch: async () =>
        new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
      now: () => nowMs
    });
    const nowUnix = Math.floor(nowMs / 1000);

    expect(await verifier.resolve(createToken(privateKey, nowUnix, { iat: undefined }))).toBeUndefined();
    expect(await verifier.resolve(createToken(privateKey, nowUnix, { nbf: undefined }))).toBeUndefined();
    expect(await verifier.resolve(createToken(privateKey, nowUnix, { exp: nowUnix + 931 }))).toBeUndefined();
  });
});

function createToken(
  privateKey: Parameters<typeof sign>[2],
  nowUnix: number,
  overrides: { iat?: number; nbf?: number; exp?: number } = {},
  kid = "access-key-1"
): string {
  const header = encode({ alg: "RS256", kid, typ: "JWT" });
  const payload = encode({
    sub: "22222222-2222-4222-8222-222222222222",
    email: "admin@example.com",
    displayName: "Platform Admin",
    platformRole: "admin",
    grants: [
      {
        tenantId: "00000000-0000-4000-8000-000000000001",
        productId: "PLATFORM",
        roles: ["platform-admin"],
        capabilities: ["manage:platform"]
      }
    ],
    iss: "https://access.example.test",
    aud: "platform-admin-bff",
    iat: overrides.iat === undefined && "iat" in overrides ? undefined : (overrides.iat ?? nowUnix),
    nbf: overrides.nbf === undefined && "nbf" in overrides ? undefined : (overrides.nbf ?? nowUnix),
    exp: overrides.exp ?? nowUnix + 300
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
