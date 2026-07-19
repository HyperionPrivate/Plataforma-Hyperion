import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { platformControlTenantId } from "@hyperion/platform-contracts";
import { describe, expect, it } from "vitest";
import {
  AccessTokenService,
  AccessTokenSizeError,
  loadAccessTokenService,
  loadAccessTokenServices
} from "./access-token.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";

describe("Access RS256 tokens", () => {
  it("emits a brief audience-bound JWT containing active grants", () => {
    let nowMs = 1_900_000_000_000;
    const service = buildService({ now: () => nowMs, ttlSeconds: 300, clockSkewSeconds: 0 });
    const session = service.issue(principal());
    const claims = decodePart(session.token, 1) as Record<string, unknown>;

    expect(session.token.split(".")).toHaveLength(3);
    expect(session.tokenType).toBe("Bearer");
    expect(claims.aud).toBe("nova-bff");
    expect(claims.iss).toBe("https://access.example.test");
    expect(Number(claims.exp) - Number(claims.iat)).toBe(300);
    expect(claims.grants).toEqual([
      {
        tenantId,
        productId: "NOVA",
        roles: ["asesor"],
        capabilities: ["nova:read", "nova:write"],
        active: true
      }
    ]);
    expect(service.verify(session.token)?.operator.id).toBe(operatorId);

    nowMs += 301_000;
    expect(service.verify(session.token)).toBeUndefined();
  });

  it("publishes only public RS256 material and retains a prior key for rotation", () => {
    const previous = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const previousExport = createPublicKey(previous.privateKey).export({ format: "jwk" });
    const service = buildService({
      previousJwks: {
        keys: [
          {
            kty: "RSA",
            kid: "access-previous",
            n: previousExport.n!,
            e: previousExport.e!,
            alg: "RS256",
            use: "sig"
          }
        ]
      }
    });
    const keys = service.jwks().keys;

    expect(keys.map((key) => key.kid)).toEqual(["access-current", "access-previous"]);
    expect(keys.every((key) => key.alg === "RS256" && key.use === "sig")).toBe(true);
    expect(keys.some((key) => "d" in key || "p" in key || "q" in key)).toBe(false);
  });

  it("rejects a correctly signed token issued for another audience", () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const issuer = buildService({ privateKey: pair.privateKey, audience: "other-bff" });
    const verifier = buildService({ privateKey: pair.privateKey, audience: "nova-bff" });

    expect(verifier.verify(issuer.issue(principal()).token)).toBeUndefined();
  });

  it("fails closed without signing material in CI and accepts local N-1 fallback", async () => {
    await expect(loadAccessTokenService({ HYPERION_ENVIRONMENT: "ci" })).rejects.toThrow(
      "Access RS256 signing key is required"
    );
    await expect(loadAccessTokenService({ HYPERION_ENVIRONMENT: "local" })).resolves.toBeUndefined();
  });

  it("creates a dedicated audience issuer for every configured BFF", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const services = await loadAccessTokenServices({
      HYPERION_ENVIRONMENT: "ci",
      ACCESS_TOKEN_PRIVATE_KEY_PEM: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      ACCESS_TOKEN_ISSUER: "https://access.example.test",
      ACCESS_TOKEN_AUDIENCES: "nova-bff,lumen-bff,pulso-bff,platform-admin-bff",
      ACCESS_TOKEN_KEY_ID: "access-current"
    });

    expect([...services.keys()]).toEqual(["nova-bff", "lumen-bff", "pulso-bff", "platform-admin-bff"]);
    expect(decodePart(services.get("lumen-bff")!.issue(principal()).token, 1)).toMatchObject({ aud: "lumen-bff" });
  });

  it("emits only the caller product grants and reserves PLATFORM for the control tenant", () => {
    const platformService = buildService({ audience: "platform-admin-bff" });
    const session = platformService.issue({
      ...principal(),
      grants: [
        ...principal().grants,
        {
          tenantId,
          productId: "PLATFORM",
          roles: ["platform-admin"],
          capabilities: ["manage:platform"]
        },
        {
          tenantId: platformControlTenantId,
          productId: "PLATFORM",
          roles: ["platform-admin"],
          capabilities: ["manage:platform"]
        }
      ]
    });

    expect((decodePart(session.token, 1) as { grants: unknown[] }).grants).toEqual([
      {
        tenantId: platformControlTenantId,
        productId: "PLATFORM",
        roles: ["platform-admin"],
        capabilities: ["manage:platform"],
        active: true
      }
    ]);
  });

  it("fails closed when one product's grants exceed the cookie-safe token budget", () => {
    const service = buildService();
    const grants = Array.from({ length: 40 }, (_, index) => ({
      tenantId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      productId: "NOVA",
      roles: ["asesor"],
      capabilities: ["nova:read", "nova:write"]
    }));

    expect(() => service.issue({ ...principal(), grants })).toThrow(AccessTokenSizeError);
  });

  it("rejects weak RSA keys", () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
    expect(() => buildService({ privateKey: weak.privateKey })).toThrow("at least 2048 bits");
  });
});

function buildService(overrides: Partial<ConstructorParameters<typeof AccessTokenService>[0]> = {}) {
  const pair = overrides.privateKey ? undefined : generateKeyPairSync("rsa", { modulusLength: 2048 });
  return new AccessTokenService({
    issuer: "https://access.example.test",
    audience: "nova-bff",
    keyId: "access-current",
    privateKey: pair?.privateKey ?? overrides.privateKey!,
    now: () => 1_900_000_000_000,
    ...overrides
  });
}

function principal() {
  return {
    operator: {
      id: operatorId,
      email: "operator@example.com",
      displayName: "Operator",
      role: "advisor" as const
    },
    grants: [
      {
        tenantId,
        productId: "NOVA",
        roles: ["asesor"],
        capabilities: ["nova:read", "nova:write"]
      },
      {
        tenantId,
        productId: "LUMEN",
        roles: ["clinician"],
        capabilities: ["lumen:read"],
        active: true
      }
    ]
  };
}

function decodePart(token: string, index: number): unknown {
  return JSON.parse(Buffer.from(token.split(".")[index]!, "base64url").toString("utf8"));
}
