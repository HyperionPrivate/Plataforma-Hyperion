import { tenantIdSchema } from "@hyperion/platform-contracts";
import { z } from "zod";

export const novaAuditEventRecordContract = {
  eventType: "nova.audit.event.record.v1",
  sourceService: "nova-core-service"
} as const;

/**
 * Audit owns the ingress contracts it accepts. Product packages may re-export
 * their entry, but the platform-side consumer must never import a product
 * contract package just to decide which event types are valid.
 */
export const auditEventRecordV1Contracts = {
  sofia: {
    eventType: "sofia.audit.event.record.v1",
    sourceService: "sofia-automation"
  },
  lumen: {
    eventType: "lumen.audit.event.record.v1",
    sourceService: "lumen-service"
  },
  pulso: {
    eventType: "pulso.audit.event.record.v1",
    sourceService: "pulso-iris-service"
  },
  channel: {
    eventType: "channel.audit.event.record.v1",
    sourceService: "whatsapp-channel-service"
  },
  nova: novaAuditEventRecordContract
} as const;

/** Drain-only N-1 wire contract retained until its durable is empty. */
export const legacyAuditEventRecordV1Contract = {
  eventType: "audit.event.record.v1",
  persistedEventType: "legacy.audit.event.record.v1",
  sourceService: "legacy-unknown"
} as const;

export const auditEventRecordV1TypeSchema = z.enum([
  auditEventRecordV1Contracts.sofia.eventType,
  auditEventRecordV1Contracts.lumen.eventType,
  auditEventRecordV1Contracts.pulso.eventType,
  auditEventRecordV1Contracts.channel.eventType,
  auditEventRecordV1Contracts.nova.eventType
]);

export const auditEventInputSchema = z
  .object({
    tenantId: tenantIdSchema.optional(),
    actorId: z.string().min(1).optional(),
    eventType: z.string().min(3),
    entityType: z.string().min(2),
    entityId: z.string().min(1).optional(),
    metadata: z.record(z.unknown()).default({})
  })
  .strict();

export const auditEventRecordV1BaseSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string().regex(/^[a-z][a-z0-9-]*\.audit\.event\.record\.v1$/),
    version: z.literal(1),
    occurredAt: z.string().datetime({ offset: true }),
    tenantId: tenantIdSchema.nullable(),
    payload: auditEventInputSchema
  })
  .strict();

export function validateAuditEventTenant(
  event: z.infer<typeof auditEventRecordV1BaseSchema>,
  context: z.RefinementCtx
): void {
  if ((event.payload.tenantId ?? null) !== event.tenantId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "tenantId must match payload.tenantId" });
  }
}

export const auditEventRecordV1Schema = auditEventRecordV1BaseSchema
  .extend({ type: auditEventRecordV1TypeSchema })
  .superRefine(validateAuditEventTenant);

export const auditInboxResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), eventId: z.string().uuid() }).passthrough(),
  z.object({ status: z.literal("duplicate"), eventId: z.string().uuid() }),
  z.object({ status: z.literal("conflict"), eventId: z.string().uuid() })
]);

export const auditEntityTypeSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/);

export const auditEventViewSchema = z
  .object({
    id: z.string().uuid(),
    eventType: z.string().min(3).max(160),
    actorId: z.string().min(1).nullable(),
    metadata: z.record(z.unknown()),
    createdAt: z
      .union([z.string().datetime({ offset: true }), z.date()])
      .transform((value) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString()))
  })
  .strict();

export const auditEventViewListSchema = z.array(auditEventViewSchema).max(200);

export type AuditEventInput = z.infer<typeof auditEventInputSchema>;
export type AuditEventRecordV1 = z.infer<typeof auditEventRecordV1Schema>;
export type AuditInboxResult = z.infer<typeof auditInboxResultSchema>;
export type AuditEventView = z.infer<typeof auditEventViewSchema>;
export type AuditEventRecordV1Contract = (typeof auditEventRecordV1Contracts)[keyof typeof auditEventRecordV1Contracts];
export type AuditEventRecordV1Type = AuditEventRecordV1Contract["eventType"];
export type AuditEventSourceService = AuditEventRecordV1Contract["sourceService"];
export type PersistedAuditEventRecordV1Type =
  AuditEventRecordV1Type | typeof legacyAuditEventRecordV1Contract.persistedEventType;
export type PersistedAuditEventSourceService =
  AuditEventSourceService | typeof legacyAuditEventRecordV1Contract.sourceService;
