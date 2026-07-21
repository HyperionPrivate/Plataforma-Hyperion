import { describe, expect, it } from "vitest";
import { accessPrincipalSchema } from "@hyperion/platform-contracts";
import {
  findNovaGrant,
  novaAuditEventRecordV1Schema,
  novaCapabilityForMethod,
  novaCatalog,
  novaGrantAllows,
  voiceCallRequestedPayloadSchema,
  voiceCallRequestedV2PayloadSchema
} from "./index.js";

describe("NOVA-owned authorization contracts", () => {
  it("accepts only a NOVA grant for the requested tenant", () => {
    const tenantId = "11111111-1111-4111-8111-111111111111";
    const principal = accessPrincipalSchema.parse({
      operator: {
        id: "22222222-2222-4222-8222-222222222222",
        email: "operator@example.com",
        displayName: "Operator",
        role: "advisor"
      },
      grants: [{ tenantId, productId: "NOVA", roles: ["asesor"], capabilities: ["nova:read"] }]
    });
    const grant = findNovaGrant(principal, tenantId);

    expect(grant).toBeDefined();
    expect(novaGrantAllows(grant!, novaCapabilityForMethod("GET"))).toBe(true);
    expect(novaGrantAllows(grant!, novaCapabilityForMethod("POST"))).toBe(false);
  });

  it("specializes the Audit-owned envelope with the NOVA producer type", () => {
    expect(
      novaAuditEventRecordV1Schema.safeParse({
        id: "11111111-1111-4111-8111-111111111111",
        type: "other.audit.event.record.v1",
        version: 1,
        occurredAt: "2026-07-17T12:00:00.000Z",
        tenantId: null,
        payload: { eventType: "campaign.started", entityType: "campaign" }
      }).success
    ).toBe(false);
  });

  it("keeps customer routing and flow identifiers outside the generic catalog", () => {
    expect(novaCatalog).not.toHaveProperty("product.firstTenant");
    expect(novaCatalog).not.toHaveProperty("agencies");
    expect(
      voiceCallRequestedPayloadSchema.safeParse({
        call_id: "11111111-1111-4111-8111-111111111111",
        contact_id: "22222222-2222-4222-8222-222222222222",
        phone_e164: "+573001112233",
        product_flow: "tenant_flow_42"
      }).success
    ).toBe(true);
    expect(
      voiceCallRequestedV2PayloadSchema.safeParse({
        call_id: "11111111-1111-4111-8111-111111111111",
        contact_id: "22222222-2222-4222-8222-222222222222",
        phone_e164: "+573001112233",
        dynamic_vars: { nombre: "Asociado" }
      }).success
    ).toBe(true);
  });
});
