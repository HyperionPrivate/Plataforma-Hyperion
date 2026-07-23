import { describe, expect, it } from "vitest";
import {
  accessTenantSnapshotEventSchema,
  accessTenantSnapshotV1EventType,
  accessJwksSchema,
  accessSessionSchema,
  accessTokenClaimsSchema,
  findActiveProductGrant,
  platformControlTenantId,
  platformControlTenantIdSchema,
  principalFromAccessTokenClaims,
  productGrantSchema,
  serviceHealthSchema
} from "./index.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";

describe("platform-owned access contracts", () => {
  it("exports the provider-owned tenant snapshot contract from the aggregate entrypoint", () => {
    expect(accessTenantSnapshotV1EventType).toBe("access.tenant.snapshot.v1");
    expect(
      accessTenantSnapshotEventSchema.safeParse({
        id: "33333333-3333-4333-8333-333333333333",
        type: accessTenantSnapshotV1EventType,
        version: 1,
        occurredAt: "2026-07-18T23:00:00.000Z",
        tenantId,
        payload: {
          tenantId,
          status: "active",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-07-18T22:59:00.000Z"
        }
      }).success
    ).toBe(true);
  });

  it("reserves one stable non-customer tenant UUID for global platform control", () => {
    expect(platformControlTenantIdSchema.parse(platformControlTenantId)).toBe("00000000-0000-4000-8000-000000000001");
    expect(() => platformControlTenantIdSchema.parse(tenantId)).toThrow();
  });

  it("models authorization as tenant x product x capabilities", () => {
    const claims = accessTokenClaimsSchema.parse({
      sub: operatorId,
      email: "operator@example.com",
      displayName: "Operator",
      platformRole: "advisor",
      grants: [
        {
          tenantId,
          productId: "NOVA",
          roles: ["asesor"],
          capabilities: ["nova:read"]
        }
      ],
      iss: "https://access.example.test",
      aud: "nova-bff",
      exp: 2_000_000_000
    });
    const principal = principalFromAccessTokenClaims(claims);

    expect(findActiveProductGrant(principal, tenantId, "NOVA")?.capabilities).toEqual(["nova:read"]);
    expect(findActiveProductGrant(principal, tenantId, "LUMEN")).toBeUndefined();
  });

  it("rejects duplicate roles and capabilities so grants stay canonical", () => {
    expect(() =>
      productGrantSchema.parse({
        tenantId,
        productId: "NOVA",
        roles: ["asesor", "asesor"],
        capabilities: ["nova:read", "nova:read"]
      })
    ).toThrow();
  });

  it("keeps the access session compatible with the legacy token envelope", () => {
    const session = accessSessionSchema.parse({
      token: "signed-access-token-with-enough-bytes",
      accessToken: "signed-access-token-with-enough-bytes",
      tokenType: "Bearer",
      expiresAt: "2033-05-18T03:33:20.000Z",
      operator: {
        id: operatorId,
        email: "operator@example.com",
        displayName: "Operator",
        role: "advisor"
      },
      grants: [
        {
          tenantId,
          productId: "NOVA",
          roles: ["asesor"],
          capabilities: ["nova:read"]
        }
      ]
    });

    expect(session.token).toContain("access-token");
    expect(session.accessToken).toBe(session.token);
    expect(session.grants[0]?.tenantId).toBe(tenantId);
  });

  it("accepts only public RS256 signing keys in JWKS", () => {
    expect(
      accessJwksSchema.parse({
        keys: [{ kty: "RSA", kid: "access-2026-07", n: "modulus", e: "AQAB", alg: "RS256", use: "sig" }]
      }).keys[0]?.kid
    ).toBe("access-2026-07");
    expect(() =>
      accessJwksSchema.parse({
        keys: [{ kty: "RSA", kid: "access", n: "modulus", e: "AQAB", alg: "HS256", use: "sig" }]
      })
    ).toThrow();
  });

  it("keeps health neutral and accepts new provider-owned service names without a global catalog edit", () => {
    const health = serviceHealthSchema.parse({
      service: "lumen-projection-reconciler",
      status: "ok",
      version: "1.0.0",
      checkedAt: "2026-07-17T20:00:00.000Z",
      uptimeSeconds: 12
    });

    expect(health.service).toBe("lumen-projection-reconciler");
    expect(health.dependencies).toEqual([]);
    expect(() => serviceHealthSchema.parse({ ...health, service: "PULSO_IRIS" })).toThrow();
  });
});
