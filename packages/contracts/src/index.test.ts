import { describe, expect, it } from "vitest";
import {
  platformCatalogSchema,
  productModules,
  pulsoIrisAvailabilityRuleListSchema,
  pulsoIrisAppointmentListSchema,
  pulsoIrisCatalog,
  pulsoIrisCatalogSchema,
  pulsoIrisConversationListSchema,
  serviceCatalog,
  tenantIdSchema
} from "./index.js";

const TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";

describe("platform contracts", () => {
  it("keeps the service and product catalog valid", () => {
    expect(() =>
      platformCatalogSchema.parse({
        services: serviceCatalog,
        productModules
      })
    ).not.toThrow();
  });

  it("keeps the Pulso Iris catalog valid", () => {
    expect(() => pulsoIrisCatalogSchema.parse(pulsoIrisCatalog)).not.toThrow();
  });

  it("accepts tenant ids only when they are UUIDs", () => {
    expect(tenantIdSchema.safeParse(TENANT_ID).success).toBe(true);
    expect(tenantIdSchema.safeParse("abc/../../etc").success).toBe(false);
    expect(tenantIdSchema.safeParse(undefined).success).toBe(false);
  });

  it("parses conversation rows as returned by PostgreSQL (Date and null values)", () => {
    const rows = [
      {
        id: "0f4d3c2b-1a09-48f7-a6e5-d4c3b2a19087",
        tenantId: TENANT_ID,
        patientId: null,
        channel: "whatsapp",
        direction: "inbound",
        status: "active",
        primaryIntent: null,
        startedAt: new Date("2026-07-08T10:00:00Z"),
        endedAt: null,
        createdAt: new Date("2026-07-08T10:00:00Z"),
        updatedAt: new Date("2026-07-08T10:05:00Z")
      }
    ];

    const parsed = pulsoIrisConversationListSchema.parse(rows);
    expect(parsed[0]?.startedAt).toBe("2026-07-08T10:00:00.000Z");
    expect(parsed[0]?.patientId).toBeUndefined();
    expect(parsed[0]?.direction).toBe("inbound");
  });

  it("parses appointment rows including payer and legacy fields", () => {
    const rows = [
      {
        id: "1e5f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
        tenantId: TENANT_ID,
        patientId: null,
        conversationId: null,
        siteId: null,
        professionalId: null,
        payerId: null,
        appointmentType: "consulta_oftalmologica",
        status: "offered",
        scheduledAt: new Date("2026-07-10T14:30:00Z"),
        legacyReference: null,
        createdAt: new Date("2026-07-08T10:00:00Z"),
        updatedAt: new Date("2026-07-08T10:00:00Z")
      }
    ];

    const parsed = pulsoIrisAppointmentListSchema.parse(rows);
    expect(parsed[0]?.scheduledAt).toBe("2026-07-10T14:30:00.000Z");
    expect(parsed[0]?.appointmentType).toBe("consulta_oftalmologica");
    expect(parsed[0]?.payerId).toBeUndefined();
  });

  it("parses availability rule rows for agenda configuration", () => {
    const rows = [
      {
        id: "2d6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
        tenantId: TENANT_ID,
        siteId: "3e6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
        professionalId: "4f6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
        appointmentTypeId: "5a6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
        weekday: 1,
        startsAt: "08:00:00",
        endsAt: "12:00:00",
        slotDurationMin: 20,
        capacity: 2,
        timezone: "America/Bogota",
        effectiveFrom: null,
        effectiveTo: null,
        status: "active",
        notes: null,
        createdAt: new Date("2026-07-08T10:00:00Z"),
        updatedAt: new Date("2026-07-08T10:00:00Z")
      }
    ];

    const parsed = pulsoIrisAvailabilityRuleListSchema.parse(rows);
    expect(parsed[0]?.startsAt).toBe("08:00:00");
    expect(parsed[0]?.effectiveFrom).toBeUndefined();
    expect(parsed[0]?.capacity).toBe(2);
  });
});
