import { describe, expect, it } from "vitest";
import {
  auditEntityTypeSchema,
  auditEventRecordV1Contracts,
  auditEventRecordV1Schema,
  auditEventViewListSchema,
  legacyAuditEventRecordV1Contract,
  novaAuditEventRecordContract
} from "./index.js";

const EVENT = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  occurredAt: "2026-07-17T12:00:00.000Z",
  tenantId: "22222222-2222-4222-8222-222222222222",
  payload: {
    tenantId: "22222222-2222-4222-8222-222222222222",
    eventType: "campaign.started",
    entityType: "campaign"
  }
} as const;

describe("Audit-owned ingress envelope", () => {
  it("binds the envelope tenant to the audit payload tenant", () => {
    const event = {
      ...EVENT,
      type: "nova.audit.event.record.v1",
      payload: {
        tenantId: "33333333-3333-4333-8333-333333333333",
        eventType: "campaign.started",
        entityType: "campaign"
      }
    };

    expect(auditEventRecordV1Schema.safeParse(event).success).toBe(false);
  });

  it("accepts exactly the provider contracts in the Audit-owned catalog", () => {
    for (const contract of Object.values(auditEventRecordV1Contracts)) {
      expect(auditEventRecordV1Schema.safeParse({ ...EVENT, type: contract.eventType }).success).toBe(true);
    }
    expect(auditEventRecordV1Schema.safeParse({ ...EVENT, type: "rogue.audit.event.record.v1" }).success).toBe(false);
  });

  it("assigns the NOVA contract exclusively to nova-core", () => {
    expect(novaAuditEventRecordContract).toEqual({
      eventType: "nova.audit.event.record.v1",
      sourceService: "nova-core-service"
    });
    expect(
      Object.values(auditEventRecordV1Contracts).filter(
        ({ eventType }) => eventType === novaAuditEventRecordContract.eventType
      )
    ).toEqual([novaAuditEventRecordContract]);
  });

  it("keeps the N-1 contract drain-only and outside the current accepted schema", () => {
    expect(legacyAuditEventRecordV1Contract).toMatchObject({
      eventType: "audit.event.record.v1",
      persistedEventType: "legacy.audit.event.record.v1",
      sourceService: "legacy-unknown"
    });
    expect(
      auditEventRecordV1Schema.safeParse({ ...EVENT, type: legacyAuditEventRecordV1Contract.eventType }).success
    ).toBe(false);
  });

  it("defines a strict provider-owned read model for source-scoped audit history", () => {
    expect(auditEntityTypeSchema.safeParse("appointment").success).toBe(true);
    expect(auditEntityTypeSchema.safeParse("Appointment/../../tenant").success).toBe(false);
    expect(
      auditEventViewListSchema.parse([
        {
          id: EVENT.id,
          eventType: "appointment.verified",
          actorId: null,
          metadata: { source: "pulso-iris-service" },
          createdAt: new Date(EVENT.occurredAt)
        }
      ])
    ).toEqual([
      {
        id: EVENT.id,
        eventType: "appointment.verified",
        actorId: null,
        metadata: { source: "pulso-iris-service" },
        createdAt: EVENT.occurredAt
      }
    ]);
  });
});
