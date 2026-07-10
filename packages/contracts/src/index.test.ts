import { describe, expect, it } from "vitest";
import {
  platformCatalogSchema,
  productModules,
  pulsoIrisAgendaBlockListSchema,
  pulsoIrisAgendaSettingsInputSchema,
  pulsoIrisAgendaSettingsSchema,
  pulsoIrisAppointmentHoldSchema,
  pulsoIrisAvailabilityRuleListSchema,
  pulsoIrisAvailabilitySlotsSchema,
  pulsoIrisAppointmentListSchema,
  pulsoIrisCatalog,
  pulsoIrisCatalogSchema,
  pulsoIrisConfigurationImportApplyInputSchema,
  pulsoIrisConfigurationImportPreviewSchema,
  pulsoIrisConversationListSchema,
  pulsoIrisManualVerificationInputSchema,
  pulsoIrisMessageSchema,
  pulsoIrisProfessionalSchema,
  pulsoIrisSlotAlternativeSchema,
  serviceCatalog,
  tenantIdSchema,
  whatsappIntegrationStatusSchema,
  whatsappQrSchema
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

  it("parses agenda blocks and generated availability slots", () => {
    const blockRows = [
      {
        id: "6b6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
        tenantId: TENANT_ID,
        siteId: null,
        professionalId: "4f6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
        appointmentTypeId: null,
        startsAt: new Date("2026-07-20T13:00:00Z"),
        endsAt: new Date("2026-07-20T15:00:00Z"),
        reason: "Ausencia profesional",
        status: "active",
        createdAt: new Date("2026-07-08T10:00:00Z"),
        updatedAt: new Date("2026-07-08T10:00:00Z")
      }
    ];

    const parsedBlocks = pulsoIrisAgendaBlockListSchema.parse(blockRows);
    expect(parsedBlocks[0]?.siteId).toBeUndefined();
    expect(parsedBlocks[0]?.status).toBe("active");

    const slots = pulsoIrisAvailabilitySlotsSchema.parse({
      from: new Date("2026-07-20T12:00:00Z"),
      to: new Date("2026-07-20T18:00:00Z"),
      slots: [
        {
          ruleId: "2d6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
          siteId: "3e6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
          professionalId: "4f6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
          appointmentTypeId: "5a6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
          startsAt: new Date("2026-07-20T13:00:00Z"),
          endsAt: new Date("2026-07-20T13:20:00Z"),
          localDate: "2026-07-20",
          localTime: "08:00",
          timeZone: "America/Bogota",
          capacity: 2,
          booked: 1,
          remaining: 1,
          status: "available",
          siteName: "Sotomayor",
          professionalName: "Dra. Rios",
          appointmentTypeName: "Consulta",
          appointmentCategory: "consulta"
        }
      ]
    });

    expect(slots.slots[0]?.remaining).toBe(1);
    expect(slots.slots[0]?.startsAt).toBe("2026-07-20T13:00:00.000Z");
    expect(slots.slots[0]).toMatchObject({
      localDate: "2026-07-20",
      localTime: "08:00",
      timeZone: "America/Bogota"
    });
    const { timeZone: _timeZone, ...slotWithoutTimeZone } = slots.slots[0]!;
    expect(pulsoIrisAvailabilitySlotsSchema.safeParse({ ...slots, slots: [slotWithoutTimeZone] }).success).toBe(false);

    const alternativeInput = {
      startsAt: new Date("2026-07-20T13:20:00Z"),
      endsAt: new Date("2026-07-20T13:40:00Z"),
      localDate: "2026-07-20",
      localTime: "08:20",
      timeZone: "America/Bogota",
      siteId: "3e6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      professionalId: "4f6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      appointmentTypeId: "5a6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      remaining: 1,
      siteName: "Sotomayor",
      professionalName: "Dra. Rios",
      appointmentTypeName: "Consulta"
    };
    expect(pulsoIrisSlotAlternativeSchema.parse(alternativeInput)).toMatchObject({
      localTime: "08:20",
      timeZone: "America/Bogota"
    });
    const { localDate: _localDate, ...alternativeWithoutLocalDate } = alternativeInput;
    expect(pulsoIrisSlotAlternativeSchema.safeParse(alternativeWithoutLocalDate).success).toBe(false);
    expect(pulsoIrisSlotAlternativeSchema.safeParse({ ...alternativeInput, localTime: "08:20 UTC" }).success).toBe(
      false
    );
  });

  it("validates configurable agenda settings and safe limits", () => {
    const parsed = pulsoIrisAgendaSettingsSchema.parse({
      tenantId: TENANT_ID,
      mode: "hybrid_manual",
      timezone: "America/Bogota",
      bookingHorizonDays: 90,
      holdDurationMinutes: 10,
      maxAlternatives: 3,
      maxReschedules: 3,
      externalConfirmationSlaMinutes: 240,
      externalReferenceRequired: true,
      capacityPolicy: "strict",
      status: "active",
      updatedBy: null,
      createdAt: new Date("2026-07-09T10:00:00Z"),
      updatedAt: new Date("2026-07-09T10:00:00Z")
    });

    expect(parsed.mode).toBe("hybrid_manual");
    expect(parsed.updatedBy).toBeUndefined();
    expect(pulsoIrisAgendaSettingsInputSchema.safeParse({ bookingHorizonDays: 0 }).success).toBe(false);
    expect(pulsoIrisAgendaSettingsInputSchema.safeParse({}).success).toBe(false);
  });

  it("parses active holds and requires manual external evidence", () => {
    const hold = pulsoIrisAppointmentHoldSchema.parse({
      id: "1a6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      tenantId: TENANT_ID,
      patientId: null,
      conversationId: null,
      siteId: "3e6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      professionalId: "4f6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      payerId: null,
      appointmentTypeId: "5a6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      scheduledAt: new Date("2026-07-20T13:00:00Z"),
      durationMin: 20,
      slotCapacityToken: 1,
      status: "active",
      expiresAt: new Date("2026-07-20T12:10:00Z"),
      idempotencyKey: "hold-request-1",
      appointmentId: null,
      createdBy: "operator-1",
      consumedAt: null,
      cancelledAt: null,
      createdAt: new Date("2026-07-20T12:00:00Z"),
      updatedAt: new Date("2026-07-20T12:00:00Z")
    });

    expect(hold.status).toBe("active");
    expect(
      pulsoIrisManualVerificationInputSchema.safeParse({ externalReference: "", externalSystem: "Agenda" }).success
    ).toBe(false);
    expect(
      pulsoIrisManualVerificationInputSchema.safeParse({
        externalReference: "REF-CONTROLADA",
        externalSystem: "Sistema externo"
      }).success
    ).toBe(true);
  });

  it("validates CSV previews and idempotent apply requests", () => {
    const preview = pulsoIrisConfigurationImportPreviewSchema.parse({
      resource: "professionals",
      accepted: [{ row: 2, data: { name: "Profesional controlado" } }],
      rejected: [{ row: 3, reason: "professional_type is required" }],
      summary: { total: 2, accepted: 1, rejected: 1 }
    });

    expect(preview.summary.rejected).toBe(1);
    expect(
      pulsoIrisConfigurationImportApplyInputSchema.safeParse({ csv: "name\nControl", idempotencyKey: "" }).success
    ).toBe(false);
    expect(
      pulsoIrisConfigurationImportApplyInputSchema.safeParse({
        csv: "name\nControl",
        idempotencyKey: "import-control-1"
      }).success
    ).toBe(true);
  });

  it("projects a sanitized WhatsApp status and an ephemeral QR response", () => {
    const status = whatsappIntegrationStatusSchema.parse({
      tenantId: TENANT_ID,
      providerMode: "whatsapp_web_test",
      state: "qr_pending",
      phoneMasked: null,
      lastActivityAt: null,
      lastError: "Conexion temporalmente no disponible",
      qrExpiresAt: new Date("2026-07-09T16:05:00Z"),
      sessionRestorable: false,
      sessionMaterial: "must-not-pass-through",
      apiKey: "must-not-pass-through"
    });

    expect(status.lastError).toBe("Conexion temporalmente no disponible");
    expect(status).not.toHaveProperty("sessionMaterial");
    expect(status).not.toHaveProperty("apiKey");

    const qr = whatsappQrSchema.parse({
      tenantId: TENANT_ID,
      providerMode: "whatsapp_web_test",
      state: "qr_pending",
      qrDataUrl: "data:image/png;base64,CONTROLLED",
      qrExpiresAt: new Date("2026-07-09T16:05:00Z")
    });
    expect(qr.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qr.qrExpiresAt).toBe("2026-07-09T16:05:00.000Z");
  });

  it("parses pilot professionals and channel delivery metadata", () => {
    const professional = pulsoIrisProfessionalSchema.parse({
      id: "4f6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      tenantId: TENANT_ID,
      name: "Controlled pilot agenda",
      professionalType: "optometrist",
      subspecialty: "Controlled functional test",
      isPilot: true,
      status: "active",
      createdAt: new Date("2026-07-09T16:00:00Z"),
      updatedAt: new Date("2026-07-09T16:00:00Z")
    });
    expect(professional.isPilot).toBe(true);

    const message = pulsoIrisMessageSchema.parse({
      id: "5f6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      tenantId: TENANT_ID,
      conversationId: "6f6f4a3b-2c1d-4e6f-8a9b-0c1d2e3f4a5b",
      sender: "sofia",
      body: "Respuesta controlada",
      provider: "whatsapp_web_test",
      externalMessageId: null,
      providerMessageId: "outbound-control-1",
      deliveryStatus: "read",
      deliveredAt: new Date("2026-07-09T16:00:02Z"),
      createdAt: "2026-07-09T16:00:00.000Z",
      metadata: {}
    });
    expect(message.deliveryStatus).toBe("read");
  });
});
