import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { JwksAccessTokenVerifier } from "./jwks.js";

describe("NOVA BFF local Access token verification", () => {
  it("allows private Access HTTP only through the explicit local/CI escape hatch", () => {
    const base = {
      jwksUrl: "http://identity-service:8081/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "nova-bff"
    };
    expect(() => new JwksAccessTokenVerifier(base)).toThrow(/HTTPS/);
    expect(() => new JwksAccessTokenVerifier({ ...base, allowPrivateHttp: true })).not.toThrow();
    expect(
      () =>
        new JwksAccessTokenVerifier({
          ...base,
          jwksUrl: "http://untrusted.example.test/.well-known/jwks.json",
          allowPrivateHttp: true
        })
    ).toThrow(/HTTPS/);
  });

  it("fails readiness without keys but preserves a warm stale cache during a temporary JWKS outage", async () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = toJwk(publicKey, "access-key-readiness");
    let nowMs = 1_900_000_000_000;
    let outage = true;
    const requestFetch = vi.fn<typeof fetch>(async () => {
      if (outage) throw new Error("Access unavailable");
      return jsonResponse({ keys: [jwk] });
    });
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "nova-bff",
      fetch: requestFetch,
      cacheTtlMs: 1_000,
      staleIfErrorMs: 60_000,
      refreshFailureBackoffMs: 0,
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
        audience: "nova-bff",
        fetch: async () => response,
        refreshFailureBackoffMs: 0
      });
      await expect(verifier.readiness()).resolves.toBe(false);
    }
  });

  it("cancels unsuccessful and oversized JWKS response bodies and releases reader locks", async () => {
    for (const status of [503, 200]) {
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
        audience: "nova-bff",
        fetch: async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
        refreshFailureBackoffMs: 0
      });

      await expect(verifier.readiness()).resolves.toBe(false);
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    }
  });

  it("keeps verifying issued tokens with a cached key during a temporary Access outage", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = {
      ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
      kid: "access-key-1",
      alg: "RS256",
      use: "sig"
    };
    let nowMs = 1_900_000_000_000;
    const requestFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "nova-bff",
      fetch: requestFetch,
      cacheTtlMs: 1_000,
      staleIfErrorMs: 60_000,
      now: () => nowMs
    });
    const token = createToken(privateKey, Math.floor(nowMs / 1000));

    expect((await verifier.resolve(token))?.grants[0]?.productId).toBe("NOVA");
    requestFetch.mockRejectedValueOnce(new Error("Access unavailable"));
    nowMs += 2_000;
    expect((await verifier.resolve(token))?.operator.email).toBe("operator@example.com");
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });

  it("backs off a failed refresh and serves stale keys without blocking every request", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = toJwk(publicKey, "access-key-1");
    const failedRefresh = deferred<Response>();
    let nowMs = 1_900_000_000_000;
    let fetchCount = 0;
    const requestFetch = vi.fn<typeof fetch>(async () => {
      fetchCount += 1;
      if (fetchCount === 2) return failedRefresh.promise;
      return jsonResponse({ keys: [jwk] });
    });
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "nova-bff",
      fetch: requestFetch,
      cacheTtlMs: 1_000,
      staleIfErrorMs: 60_000,
      refreshFailureBackoffMs: 10_000,
      now: () => nowMs
    });
    const token = createToken(privateKey, Math.floor(nowMs / 1_000));

    expect(await verifier.resolve(token)).toBeDefined();
    nowMs += 2_000;

    const firstDuringOutage = verifier.resolve(token);
    expect(requestFetch).toHaveBeenCalledTimes(2);

    const followerDuringOutage = verifier.resolve(token);
    let followerSettled = false;
    void followerDuringOutage.then(() => {
      followerSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(followerSettled).toBe(true);
    expect((await followerDuringOutage)?.operator.email).toBe("operator@example.com");

    failedRefresh.reject(new Error("Access unavailable"));
    expect((await firstDuringOutage)?.operator.email).toBe("operator@example.com");

    const principalsDuringBackoff = await Promise.all(Array.from({ length: 12 }, () => verifier.resolve(token)));
    expect(principalsDuringBackoff.every((principal) => principal?.operator.email === "operator@example.com")).toBe(
      true
    );
    expect(requestFetch).toHaveBeenCalledTimes(2);

    nowMs += 9_999;
    expect(await verifier.resolve(token)).toBeDefined();
    expect(requestFetch).toHaveBeenCalledTimes(2);

    nowMs += 1;
    expect(await verifier.resolve(token)).toBeDefined();
    expect(requestFetch).toHaveBeenCalledTimes(3);
  });

  it("refreshes a fresh JWKS cache once when Access rotates to an unknown kid", async () => {
    const oldKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const newKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oldJwk = toJwk(oldKeys.publicKey, "access-key-1");
    const newJwk = toJwk(newKeys.publicKey, "access-key-2");
    const nowMs = 1_900_000_000_000;
    let fetchCount = 0;
    const requestFetch = vi.fn<typeof fetch>(async (_input, init): Promise<Response> => {
      expect(init?.redirect).toBe("error");
      fetchCount += 1;
      const keys = fetchCount === 1 ? [oldJwk] : [oldJwk, newJwk];
      return new Response(JSON.stringify({ keys }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "nova-bff",
      fetch: requestFetch,
      cacheTtlMs: 60_000,
      now: () => nowMs
    });
    const nowUnix = Math.floor(nowMs / 1000);

    expect(await verifier.resolve(createToken(oldKeys.privateKey, nowUnix))).toBeDefined();
    const rotatedToken = createToken(newKeys.privateKey, nowUnix, {}, "access-key-2");
    const rotatedPrincipals = await Promise.all([verifier.resolve(rotatedToken), verifier.resolve(rotatedToken)]);

    expect(rotatedPrincipals.every((principal) => principal?.operator.email === "operator@example.com")).toBe(true);
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });

  it("rate limits random unknown kids globally and accepts a rotated key after the cooldown", async () => {
    const oldKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const newKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const oldJwk = toJwk(oldKeys.publicKey, "access-key-1");
    const newJwk = toJwk(newKeys.publicKey, "access-key-2");
    let publishedKeys = [oldJwk];
    let nowMs = 1_900_000_000_000;
    const requestFetch = vi.fn<typeof fetch>(async () => jsonResponse({ keys: publishedKeys }));
    const verifier = new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "nova-bff",
      fetch: requestFetch,
      cacheTtlMs: 60_000,
      unknownKidRefreshCooldownMs: 10_000,
      now: () => nowMs
    });
    const nowUnix = Math.floor(nowMs / 1_000);

    expect(await verifier.resolve(createToken(oldKeys.privateKey, nowUnix))).toBeDefined();
    for (let index = 0; index < 25; index += 1) {
      expect(
        await verifier.resolve(createToken(oldKeys.privateKey, nowUnix, {}, `attacker-random-kid-${index}`))
      ).toBeUndefined();
    }
    expect(requestFetch).toHaveBeenCalledTimes(2);

    publishedKeys = [oldJwk, newJwk];
    const rotatedToken = createToken(newKeys.privateKey, nowUnix, {}, "access-key-2");
    nowMs += 9_999;
    expect(await verifier.resolve(rotatedToken)).toBeUndefined();
    expect(requestFetch).toHaveBeenCalledTimes(2);

    nowMs += 1;
    expect((await verifier.resolve(rotatedToken))?.operator.email).toBe("operator@example.com");
    expect(requestFetch).toHaveBeenCalledTimes(3);
  });

  it("rejects tokens without mandatory temporal claims or with an invalid lifetime", async () => {
    const nowUnix = 1_900_000_000;
    const { privateKey, verifier } = createVerifier(nowUnix * 1_000);

    expect(await verifier.resolve(createToken(privateKey, nowUnix, { iat: undefined }))).toBeUndefined();
    expect(await verifier.resolve(createToken(privateKey, nowUnix, { nbf: undefined }))).toBeUndefined();
    expect(await verifier.resolve(createToken(privateKey, nowUnix, { exp: nowUnix }))).toBeUndefined();
    expect(await verifier.resolve(createToken(privateKey, nowUnix, { exp: nowUnix + 931 }))).toBeUndefined();
    expect(await verifier.resolve(createToken(privateKey, nowUnix, { exp: nowUnix + 930 }))).toBeDefined();
  });

  it("applies the configured clock skew to issued-at, not-before and expiration", async () => {
    const nowUnix = 1_900_000_000;
    const { privateKey, verifier } = createVerifier(nowUnix * 1_000, 30);

    expect(
      await verifier.resolve(createToken(privateKey, nowUnix, { iat: nowUnix + 31, exp: nowUnix + 331 }))
    ).toBeUndefined();
    expect(await verifier.resolve(createToken(privateKey, nowUnix, { nbf: nowUnix + 31 }))).toBeUndefined();
    expect(
      await verifier.resolve(
        createToken(privateKey, nowUnix, {
          iat: nowUnix - 330,
          nbf: nowUnix - 330,
          exp: nowUnix - 30
        })
      )
    ).toBeUndefined();
    expect(
      await verifier.resolve(
        createToken(privateKey, nowUnix, {
          iat: nowUnix - 329,
          nbf: nowUnix - 329,
          exp: nowUnix - 29
        })
      )
    ).toBeDefined();
    expect(
      await verifier.resolve(
        createToken(privateKey, nowUnix, {
          iat: nowUnix + 30,
          nbf: nowUnix + 30,
          exp: nowUnix + 330
        })
      )
    ).toBeDefined();
  });
});

function createVerifier(
  nowMs: number,
  clockSkewSeconds = 30
): {
  privateKey: KeyObject;
  verifier: JwksAccessTokenVerifier;
} {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
    kid: "access-key-1",
    alg: "RS256",
    use: "sig"
  };
  return {
    privateKey,
    verifier: new JwksAccessTokenVerifier({
      jwksUrl: "https://access.example.test/.well-known/jwks.json",
      issuer: "https://access.example.test",
      audience: "nova-bff",
      fetch: async () =>
        new Response(JSON.stringify({ keys: [jwk] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
      clockSkewSeconds,
      now: () => nowMs
    })
  };
}

function createToken(
  privateKey: KeyObject,
  nowUnix: number,
  overrides: Record<string, unknown> = {},
  kid = "access-key-1"
): string {
  const header = encode({ alg: "RS256", kid, typ: "JWT" });
  const payload = encode({
    sub: "22222222-2222-4222-8222-222222222222",
    email: "operator@example.com",
    displayName: "Operator",
    platformRole: "advisor",
    grants: [
      {
        tenantId: "11111111-1111-4111-8111-111111111111",
        productId: "NOVA",
        roles: ["asesor"],
        capabilities: ["nova:read"]
      }
    ],
    iss: "https://access.example.test",
    aud: "nova-bff",
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

function toJwk(publicKey: KeyObject, kid: string): JsonWebKey & { kid: string; alg: "RS256"; use: "sig" } {
  return {
    ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
    kid,
    alg: "RS256",
    use: "sig"
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
