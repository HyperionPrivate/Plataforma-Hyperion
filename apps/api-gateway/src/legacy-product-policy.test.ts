import { describe, expect, it } from "vitest";
import {
  isLegacyCustomerProductId,
  isLegacyGatewayEnabled,
  legacyGatewayTelemetry,
  noteLegacyGatewayDeprecatedHit,
  noteLegacyGatewayDisabledReject,
  readLegacyProductRequestScope
} from "./legacy-product-policy.js";

const TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";

describe("retired legacy gateway product policy", () => {
  it("always reports the multiproduct facade as disabled (DEBT-020 / DEBT-032)", () => {
    expect(isLegacyGatewayEnabled({})).toBe(false);
    expect(isLegacyGatewayEnabled({ LEGACY_GATEWAY_ENABLED: "true" })).toBe(false);
    expect(isLegacyGatewayEnabled({ LEGACY_GATEWAY_ENABLED: "false" })).toBe(false);
  });

  it("detects product scope for tenant namespaces and unscoped discovery paths", () => {
    expect(readLegacyProductRequestScope(`/v1/tenants/${TENANT_ID}/voice/calls`)).toEqual({
      productId: "NOVA",
      tenantId: TENANT_ID
    });
    expect(readLegacyProductRequestScope(`/v1/tenants/${TENANT_ID}/lumen/worklist`)).toEqual({
      productId: "LUMEN",
      tenantId: TENANT_ID
    });
    expect(readLegacyProductRequestScope(`/v1/tenants/${TENANT_ID}/pulso-iris/overview`)).toEqual({
      productId: "PULSO_IRIS",
      tenantId: TENANT_ID
    });
    expect(readLegacyProductRequestScope(`/v1/tenants/${TENANT_ID}/integrations/whatsapp/status`)).toEqual({
      productId: "PULSO_IRIS",
      tenantId: TENANT_ID
    });
    expect(readLegacyProductRequestScope("/v1/lumen/catalog")).toEqual({ productId: "LUMEN" });
    expect(readLegacyProductRequestScope("/v1/nova/health")).toEqual({ productId: "NOVA" });
    expect(readLegacyProductRequestScope("/v1/pulso-iris/catalog")).toEqual({ productId: "PULSO_IRIS" });
    expect(readLegacyProductRequestScope(`/v1/tenants/${TENANT_ID}/unknown/route`)).toBeUndefined();
    expect(readLegacyProductRequestScope("/v1/platform/catalog")).toBeUndefined();
  });

  it("recognizes legacy customer product ids used by tenant directory filtering", () => {
    expect(isLegacyCustomerProductId("PULSO_IRIS")).toBe(true);
    expect(isLegacyCustomerProductId("LUMEN")).toBe(true);
    expect(isLegacyCustomerProductId("NOVA")).toBe(true);
    expect(isLegacyCustomerProductId("UNKNOWN")).toBe(false);
  });

  it("increments telemetry counters independently", () => {
    const beforeDeprecated = legacyGatewayTelemetry.deprecatedRouteHits;
    const beforeDisabled = legacyGatewayTelemetry.disabledRejects;

    noteLegacyGatewayDeprecatedHit();
    noteLegacyGatewayDisabledReject();
    noteLegacyGatewayDisabledReject();

    expect(legacyGatewayTelemetry.deprecatedRouteHits).toBe(beforeDeprecated + 1);
    expect(legacyGatewayTelemetry.disabledRejects).toBe(beforeDisabled + 2);
  });
});
