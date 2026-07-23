import { accessPrincipalSchema } from "@hyperion/platform-contracts";
import { describe, expect, it } from "vitest";
import {
  findPulsoGrant,
  pulsoCapabilityForMethod,
  pulsoAgendaReadinessSchema,
  pulsoCellComponentSchema,
  pulsoCellServiceSchema,
  pulsoConsoleRequestHeaderValue,
  pulsoDeliveryGuardRequestSchema,
  pulsoDeliveryGuardResultSchema,
  pulsoGrantAllows,
  pulsoProductId,
  pulsoSofiaConversationContextRequestSchema,
  pulsoSofiaConversationContextResultSchema,
  pulsoSofiaInboundLookupRequestSchema,
  pulsoSofiaInboundLookupResultSchema,
  pulsoServiceForComponent
} from "./index.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

describe("PULSO provider-owned edge contracts v1", () => {
  it("accepts only a tenant-scoped PULSO grant with known roles and capabilities", () => {
    const principal = accessPrincipalSchema.parse({
      operator: {
        id: "22222222-2222-4222-8222-222222222222",
        email: "advisor@example.test",
        displayName: "PULSO Advisor",
        role: "advisor"
      },
      grants: [
        {
          tenantId: TENANT_ID,
          productId: pulsoProductId,
          roles: ["advisor"],
          capabilities: ["pulso:read", "pulso:write"],
          active: true
        }
      ]
    });

    const grant = findPulsoGrant(principal, TENANT_ID);
    expect(grant?.productId).toBe("PULSO_IRIS");
    expect(grant && pulsoGrantAllows(grant, "pulso:write")).toBe(true);
  });

  it("separates browser namespaces from the complete cell-owned service inventory", () => {
    expect(pulsoCellComponentSchema.options).toEqual(["pulso-iris", "integrations"]);
    expect(pulsoConsoleRequestHeaderValue).toBe("pulso-console");
    expect(pulsoCellServiceSchema.options).toEqual([
      "core",
      "sofia",
      "prompt-flow",
      "knowledge",
      "integration",
      "whatsapp"
    ]);
    expect(pulsoServiceForComponent("pulso-iris")).toBe("core");
    expect(pulsoServiceForComponent("integrations")).toBe("integration");
    expect(pulsoCapabilityForMethod("DELETE")).toBe("pulso:write");
  });

  it("accepts only a coherent provider-owned agenda readiness projection", () => {
    const ready = pulsoAgendaReadinessSchema.parse({
      tenantId: TENANT_ID,
      ready: true,
      mode: "internal",
      status: "active",
      activeProfessionalCount: 2,
      activeAvailabilityRuleCount: 4,
      checkedAt: "2026-07-17T12:00:00.000Z"
    });

    expect(ready.ready).toBe(true);
    expect(
      pulsoAgendaReadinessSchema.safeParse({
        ...ready,
        activeAvailabilityRuleCount: 0
      }).success
    ).toBe(false);
    expect(
      pulsoAgendaReadinessSchema.parse({
        tenantId: TENANT_ID,
        ready: false,
        mode: null,
        status: null,
        activeProfessionalCount: 0,
        activeAvailabilityRuleCount: 0,
        checkedAt: "2026-07-17T12:00:00.000Z"
      }).ready
    ).toBe(false);
  });

  it("defines a strict delivery guard body and a minimal result", () => {
    expect(
      pulsoDeliveryGuardRequestSchema.parse({
        conversationId: "33333333-3333-4333-8333-333333333333",
        body: "Mensaje privado",
        expectedDeliveryStatus: "queued"
      })
    ).toEqual({
      conversationId: "33333333-3333-4333-8333-333333333333",
      body: "Mensaje privado",
      expectedDeliveryStatus: "queued"
    });
    expect(
      pulsoDeliveryGuardRequestSchema.safeParse({
        conversationId: "33333333-3333-4333-8333-333333333333",
        body: "Mensaje privado",
        expectedDeliveryStatus: "queued",
        unexpected: true
      }).success
    ).toBe(false);
    expect(
      pulsoDeliveryGuardResultSchema.parse({
        messageId: "44444444-4444-4444-8444-444444444444",
        matches: true
      })
    ).toEqual({
      messageId: "44444444-4444-4444-8444-444444444444",
      matches: true
    });
  });

  it("defines strict tenant-bound SOFIA context contracts", () => {
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const patientId = "44444444-4444-4444-8444-444444444444";
    const messageId = "55555555-5555-4555-8555-555555555555";

    expect(
      pulsoSofiaInboundLookupRequestSchema.safeParse({
        conversationId,
        patientId,
        messageId,
        unexpected: true
      }).success
    ).toBe(false);
    const inbound = pulsoSofiaInboundLookupResultSchema.parse({
      found: true,
      tenantId: TENANT_ID,
      conversationId,
      patientId,
      conversationStatus: "active",
      message: { id: messageId, sender: "patient", body: "CONFIRMO" }
    });
    expect(inbound.found && inbound.message.body).toBe("CONFIRMO");
    expect(
      pulsoSofiaInboundLookupResultSchema.safeParse({
        found: false,
        message: { id: messageId, sender: "patient", body: "CONFIRMO" }
      }).success
    ).toBe(false);

    expect(pulsoSofiaConversationContextRequestSchema.parse({ conversationId, patientId })).toEqual({
      conversationId,
      patientId
    });
    expect(
      pulsoSofiaConversationContextResultSchema.safeParse({
        tenantId: TENANT_ID,
        conversationId,
        patientId,
        patientName: null,
        sofiaState: {},
        history: [],
        unexpected: true
      }).success
    ).toBe(false);
  });
});
