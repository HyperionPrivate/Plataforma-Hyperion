import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { JwksAccessTokenVerifier } from "./jwks.js";

describe("PULSO BFF local Access token verification", () => {
  it("allows only explicitly enabled, known private HTTP JWKS hosts", () => {
    const base = {
      jwksUrl: "http://identity-service:8081/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "pulso-bff"
    };
    expect(() => new JwksAccessTokenVerifier(base)).toThrow(/HTTPS/);
    expect(() => new JwksAccessTokenVerifier({ ...base, allowPrivateHttp: true })).not.toThrow();
    for (const jwksUrl of [
      "http://untrusted.example.test/.well-known/jwks.json",
      "ftp://identity-service/.well-known/jwks.json",
      "http://identity-service@untrusted.example.test/.well-known/jwks.json"
    ]) {
      expect(() => new JwksAccessTokenVerifier({ ...base, jwksUrl, allowPrivateHttp: true })).toThrow(/HTTPS/);
    }
  });

  it("fails readiness without keys but preserves a warm stale cache during a temporary JWKS outage", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = {
      ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
      kid: "access-key-readiness",
      alg: "RS256",
      use: "sig"
    };
    let nowMs = 1_900_000_000_000;
    let outage = true;
    const requestFetch = vi.fn<typeof fetch>(async () => {
      if (outage) throw new Error("Access unavailable");
      return Response.json({ keys: [jwk] });
    });
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "pulso-bff",
      fetch: requestFetch,
      cacheTtlMs: 1_000,
      staleIfErrorMs: 60_000,
      refreshCooldownMs: 0,
      now: () => nowMs
    });

    await expect(verifier.readiness()).resolves.toBe(false);
    outage = false;
    await expect(verifier.readiness()).resolves.toBe(true);
    nowMs += 2_000;
    outage = true;
    await expect(verifier.readiness()).resolves.toBe(true);
    nowMs += 60_001;
    await expect(verifier.readiness()).resolves.toBe(false);
    expect(requestFetch).toHaveBeenCalledTimes(4);
  });

  it("rejects non-JSON and structurally invalid JWKS readiness documents", async () => {
    for (const response of [
      new Response(JSON.stringify({ keys: [] }), { headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ keys: [{ kid: "not-rsa" }] }), {
        headers: { "content-type": "application/json" }
      }),
      new Response(JSON.stringify({ keys: [{ kty: "RSA" }] }), { headers: { "content-type": "text/plain" } })
    ]) {
      const verifier = new JwksAccessTokenVerifier({
        jwksUrl: "https://access.example.test/.well-known/jwks.json",
        issuer: "https://access.example.test",
        audience: "pulso-bff",
        fetch: async () => response,
        refreshCooldownMs: 0
      });
      await expect(verifier.readiness()).resolves.toBe(false);
    }
  });

  it("cancels a chunked JWKS document as soon as it exceeds the streaming limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      }
    });
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "pulso-bff",
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
      refreshCooldownMs: 0
    });

    await expect(verifier.readiness()).resolves.toBe(false);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("cancels a non-success JWKS response body before entering refresh cooldown", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      }
    });
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "pulso-bff",
      fetch: async () => new Response(body, { status: 503, headers: { "content-type": "application/json" } }),
      refreshCooldownMs: 0
    });

    await expect(verifier.readiness()).resolves.toBe(false);
    expect(cancelled).toBe(true);
    expect(body.locked).toBe(false);
  });

  it("enforces signature, issuer and PULSO audience while tolerating a temporary JWKS outage", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = {
      ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
      kid: "access-key-1",
      alg: "RS256",
      use: "sig"
    };
    let nowMs = 1_900_000_000_000;
    const requestFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "pulso-bff",
      fetch: requestFetch,
      cacheTtlMs: 1_000,
      staleIfErrorMs: 60_000,
      now: () => nowMs
    });

    expect((await verifier.resolve(createToken(privateKey, nowMs, "pulso-bff")))?.grants[0]?.productId).toBe(
      "PULSO_IRIS"
    );
    expect(await verifier.resolve(createToken(privateKey, nowMs, "lumen-bff"))).toBeUndefined();
    expect(await verifier.resolve(createToken(privateKey, nowMs, "pulso-bff", { nbf: undefined }))).toBeUndefined();
    expect(
      await verifier.resolve(createToken(privateKey, nowMs, "pulso-bff", { exp: Math.floor(nowMs / 1000) + 931 }))
    ).toBeUndefined();
    requestFetch.mockRejectedValueOnce(new Error("Access unavailable"));
    nowMs += 2_000;
    expect((await verifier.resolve(createToken(privateKey, nowMs, "pulso-bff")))?.operator.email).toBe(
      "operator@example.com"
    );
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });

  it("coalesces unknown-kid and outage refresh storms behind a cooldown while preserving rotation", async () => {
    const first = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const firstJwk = {
      ...(first.publicKey.export({ format: "jwk" }) as JsonWebKey),
      kid: "access-key-1",
      alg: "RS256",
      use: "sig"
    };
    const rotatedJwk = {
      ...(rotated.publicKey.export({ format: "jwk" }) as JsonWebKey),
      kid: "access-key-2",
      alg: "RS256",
      use: "sig"
    };
    let nowMs = 1_900_000_000_000;
    let keys = [firstJwk];
    let outage = false;
    const requestFetch = vi.fn<typeof fetch>(async () => {
      if (outage) throw new Error("Access unavailable");
      return Response.json({ keys });
    });
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "pulso-bff",
      fetch: requestFetch,
      cacheTtlMs: 1_000,
      staleIfErrorMs: 60_000,
      refreshCooldownMs: 5_000,
      now: () => nowMs
    });

    expect(await verifier.resolve(createToken(first.privateKey, nowMs, "pulso-bff"))).toBeDefined();
    const misses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        verifier.resolve(createToken(first.privateKey, nowMs, "pulso-bff", {}, `random-kid-${index}`))
      )
    );
    expect(misses.every((value) => value === undefined)).toBe(true);
    expect(requestFetch).toHaveBeenCalledTimes(2);

    keys = [firstJwk, rotatedJwk];
    expect(
      await verifier.resolve(createToken(rotated.privateKey, nowMs, "pulso-bff", {}, "access-key-2"))
    ).toBeUndefined();
    expect(requestFetch).toHaveBeenCalledTimes(2);
    nowMs += 5_001;
    expect(
      await verifier.resolve(createToken(rotated.privateKey, nowMs, "pulso-bff", {}, "access-key-2"))
    ).toBeDefined();
    expect(requestFetch).toHaveBeenCalledTimes(3);

    outage = true;
    nowMs += 1_001;
    const stale = await Promise.all(
      Array.from({ length: 12 }, () =>
        verifier.resolve(createToken(rotated.privateKey, nowMs, "pulso-bff", {}, "access-key-2"))
      )
    );
    expect(stale.every((value) => value !== undefined)).toBe(true);
    expect(requestFetch).toHaveBeenCalledTimes(4);
    expect(
      await verifier.resolve(createToken(rotated.privateKey, nowMs, "pulso-bff", {}, "access-key-2"))
    ).toBeDefined();
    expect(
      await verifier.resolve(createToken(first.privateKey, nowMs, "pulso-bff", {}, "unknown-during-outage"))
    ).toBeUndefined();
    expect(requestFetch).toHaveBeenCalledTimes(4);
    nowMs += 5_001;
    expect(
      await verifier.resolve(createToken(rotated.privateKey, nowMs, "pulso-bff", {}, "access-key-2"))
    ).toBeDefined();
    expect(requestFetch).toHaveBeenCalledTimes(5);
  });
});

function createToken(
  privateKey: KeyObject,
  nowMs: number,
  audience: string,
  overrides: Record<string, unknown> = {},
  kid = "access-key-1"
): string {
  const nowUnix = Math.floor(nowMs / 1000);
  const header = encode({ alg: "RS256", kid, typ: "JWT" });
  const payload = encode({
    sub: "22222222-2222-4222-8222-222222222222",
    email: "operator@example.com",
    displayName: "Operator",
    platformRole: "advisor",
    grants: [
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        productId: "PULSO_IRIS",
        roles: ["advisor"],
        capabilities: ["pulso:read"]
      }
    ],
    iss: "https://access.example.test",
    aud: audience,
    iat: nowUnix,
    nbf: nowUnix,
    exp: nowUnix + 300,
    ...overrides
  });
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
