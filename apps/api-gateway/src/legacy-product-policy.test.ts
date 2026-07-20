import { createHash } from "node:crypto";
import type { AccessPrincipal, ProductGrant } from "@hyperion/platform-contracts";
import { describe, expect, it } from "vitest";
import {
  authorizeLegacyProductRequest,
  isLegacyCustomerProductId,
  isLegacyGatewayEnabled,
  LEGACY_PRODUCT_POLICY_SNAPSHOT_VERSION,
  LEGACY_TENANT_ROUTE_POLICIES,
  readLegacyProductRequestScope
} from "./legacy-product-policy.js";

const TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";

function principal(grant: ProductGrant): AccessPrincipal {
  return {
    operator: {
      id: "9c8b7a6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d",
      email: "operator@hyperion.local",
      displayName: "Operator",
      role: "advisor"
    },
    grants: [grant]
  };
}

function grant(productId: string, roles: string[], capabilities: string[]): ProductGrant {
  return { tenantId: TENANT_ID, productId, roles, capabilities, active: true };
}

describe("frozen legacy gateway policy", () => {
  it("defaults LEGACY_GATEWAY_ENABLED to fail-closed", () => {
    expect(isLegacyGatewayEnabled({})).toBe(false);
    expect(isLegacyGatewayEnabled({ LEGACY_GATEWAY_ENABLED: "true" })).toBe(true);
    expect(isLegacyGatewayEnabled({ LEGACY_GATEWAY_ENABLED: "false" })).toBe(false);
  });

  it("pins the complete N-1 route inventory without provider imports", () => {
    expect(LEGACY_PRODUCT_POLICY_SNAPSHOT_VERSION).toBe(1);
    expect(LEGACY_TENANT_ROUTE_POLICIES).toHaveLength(139);
    expect(new Set(LEGACY_TENANT_ROUTE_POLICIES.map((policy) => policy.productId))).toEqual(
      new Set(["NOVA", "LUMEN", "PULSO_IRIS"])
    );
    expect(createHash("sha256").update(JSON.stringify(LEGACY_TENANT_ROUTE_POLICIES)).digest("hex")).toBe(
      "bfc7d19891fce5ba22c1a3c2dfc63c20ff98452fe2bf1f15d13714f84d79498b"
    );
  });

  it("maps compatibility namespaces through neutral configuration", () => {
    expect(readLegacyProductRequestScope(`/v1/tenants/${TENANT_ID}/voice/calls`)).toEqual({
      productId: "NOVA",
      tenantId: TENANT_ID
    });
    expect(readLegacyProductRequestScope("/v1/lumen/catalog")).toEqual({ productId: "LUMEN" });
    expect(readLegacyProductRequestScope(`/v1/tenants/${TENANT_ID}/unknown/route`)).toBeUndefined();
    expect(isLegacyCustomerProductId("PULSO_IRIS")).toBe(true);
    expect(isLegacyCustomerProductId("UNKNOWN")).toBe(false);
  });

  it("applies capabilities, admin fallback and roles without product branches", () => {
    expect(
      authorizeLegacyProductRequest(
        "GET",
        `/v1/tenants/${TENANT_ID}/lumen/worklist`,
        principal(grant("LUMEN", ["advisor"], ["lumen:read"]))
      )
    ).toBeUndefined();
    expect(
      authorizeLegacyProductRequest(
        "POST",
        `/v1/tenants/${TENANT_ID}/pulso-iris/appointments`,
        principal(grant("PULSO_IRIS", ["admin"], ["pulso:admin"]))
      )
    ).toBeUndefined();

    expect(
      authorizeLegacyProductRequest(
        "POST",
        `/v1/tenants/${TENANT_ID}/nova/campaigns`,
        principal(grant("NOVA", ["asesor"], ["nova:write"]))
      )
    ).toEqual({ statusCode: 403, message: "NOVA role is not allowed for this operation" });
  });

  it("fails closed for invalid provider-shaped grants and uncatalogued routes", () => {
    expect(
      authorizeLegacyProductRequest(
        "GET",
        `/v1/tenants/${TENANT_ID}/nova/campaigns`,
        principal(grant("NOVA", ["advisor"], ["nova:read"]))
      )
    ).toEqual({ statusCode: 403, message: "NOVA grant required for this tenant" });

    expect(
      authorizeLegacyProductRequest(
        "GET",
        `/v1/tenants/${TENANT_ID}/pulso-iris/config/import/not-allowlisted/template`,
        principal(grant("PULSO_IRIS", ["admin"], ["pulso:admin"]))
      )
    ).toEqual({ statusCode: 404, message: "Route is not part of the PULSO cell" });
  });
});
