import {
  auditEventInputSchema,
  auditEventRecordV1BaseSchema,
  novaAuditEventRecordContract,
  validateAuditEventTenant
} from "@hyperion/audit-contracts";
import { envelope, productGrantSchema, tenantIdSchema, type AccessPrincipal } from "@hyperion/platform-contracts";
import { z } from "zod";

export { envelope, tenantIdSchema };
export { auditEventInputSchema as auditEventSchema };
export { novaAuditEventRecordContract } from "@hyperion/audit-contracts";
export * from "./bff-route-policies.js";

export const novaProductId = "NOVA" as const;
export const novaProductRoleSchema = z.enum(["admin", "supervisor", "asesor"]);
export const novaCapabilitySchema = z.enum(["nova:read", "nova:write", "nova:admin"]);
export const novaCellComponentSchema = z.enum(["nova", "voice", "liwa", "documents"]);

export const novaGrantSchema = productGrantSchema.extend({
  productId: z.literal(novaProductId),
  roles: z.array(novaProductRoleSchema).min(1),
  capabilities: z.array(novaCapabilitySchema).min(1)
});

export const novaAuditEventRecordV1Schema = auditEventRecordV1BaseSchema
  .extend({ type: z.literal(novaAuditEventRecordContract.eventType) })
  .superRefine(validateAuditEventTenant);

export type NovaProductRole = z.infer<typeof novaProductRoleSchema>;
export type NovaCapability = z.infer<typeof novaCapabilitySchema>;
export type NovaCellComponent = z.infer<typeof novaCellComponentSchema>;
export type NovaGrant = z.infer<typeof novaGrantSchema>;

export function findNovaGrant(principal: AccessPrincipal, tenantId: string): NovaGrant | undefined {
  for (const grant of principal.grants) {
    if (!grant.active || grant.tenantId !== tenantId || grant.productId !== novaProductId) continue;
    const parsed = novaGrantSchema.safeParse(grant);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

export function novaCapabilityForMethod(method: string): NovaCapability {
  return method === "GET" || method === "HEAD" ? "nova:read" : "nova:write";
}

export function novaGrantAllows(grant: NovaGrant, required: NovaCapability): boolean {
  return grant.capabilities.includes("nova:admin") || grant.capabilities.includes(required);
}

export const novaProductCode = novaProductId;

export const novaFlowIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{1,79}$/);

export const dataClassificationSchema = z.enum(["public", "internal", "confidential", "restricted"]);

export const durableEventEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  event_type: z.string().min(3).max(120),
  event_version: z.literal(1).default(1),
  occurred_at: z.string().datetime(),
  tenant_id: z.string().uuid(),
  correlation_id: z.string().uuid(),
  business_idempotency_key: z.string().min(3).max(240),
  data_classification: dataClassificationSchema.default("internal"),
  producer: z.string().min(2).max(80),
  payload: z.record(z.unknown())
});

export type DurableEventEnvelope = z.infer<typeof durableEventEnvelopeSchema>;

/** Accepts both the durable envelope and the legacy camelCase ingress used by NOVA services. */
export const novaIngressEventSchema = z
  .object({
    event_id: z.string().uuid().optional(),
    id: z.string().uuid().optional(),
    event_type: z.string().min(3).max(120).optional(),
    type: z.string().min(3).max(120).optional(),
    event_version: z.number().int().positive().optional(),
    version: z.number().int().positive().optional(),
    occurred_at: z.string().datetime().optional(),
    occurredAt: z.string().datetime().optional(),
    tenant_id: z.string().uuid().nullable().optional(),
    tenantId: z.string().uuid().nullable().optional(),
    correlation_id: z.string().uuid().optional(),
    business_idempotency_key: z.string().min(3).max(240).optional(),
    data_classification: dataClassificationSchema.optional(),
    producer: z.string().min(2).max(80).optional(),
    payload: z.record(z.unknown())
  })
  .transform((raw) => {
    const eventId = raw.event_id ?? raw.id;
    const eventType = raw.event_type ?? raw.type;
    const tenantId = raw.tenant_id ?? raw.tenantId;
    if (!eventId || !eventType || !tenantId) {
      throw new Error("event_id/id, event_type/type and tenant_id/tenantId are required");
    }
    return {
      event_id: eventId,
      event_type: eventType,
      event_version: raw.event_version ?? raw.version ?? 1,
      occurred_at: raw.occurred_at ?? raw.occurredAt ?? new Date().toISOString(),
      tenant_id: tenantId,
      correlation_id: raw.correlation_id,
      business_idempotency_key: raw.business_idempotency_key ?? `inbox:${eventId}`,
      data_classification: raw.data_classification ?? ("internal" as const),
      producer: raw.producer ?? "unknown",
      payload: raw.payload
    };
  });

export type NovaIngressEvent = z.infer<typeof novaIngressEventSchema>;

export function envelopeEvent<T extends z.ZodTypeAny>(eventType: string, payloadSchema: T) {
  return durableEventEnvelopeSchema.extend({
    event_type: z.literal(eventType),
    payload: payloadSchema
  });
}

const phoneE164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

export const contactImportedPayloadSchema = z.object({
  contact_id: z.string().uuid(),
  phone_e164: phoneE164,
  agency_code: z.string().min(2).max(40).optional(),
  full_name_masked: z.string().max(160).optional()
});

export const contactScoredPayloadSchema = z.object({
  contact_id: z.string().uuid(),
  segment: z.string().min(1).max(80),
  score: z.number(),
  propensity: z.number().optional(),
  urgency: z.number().optional(),
  wave: z.enum(["voz", "whatsapp", "mixto"]).optional()
});

export const contactEligibilityDecidedPayloadSchema = z.object({
  contact_id: z.string().uuid(),
  eligibility: z.enum(["eligible", "blocked_window", "blocked_opt_out", "blocked_policy", "blocked_frequency"]),
  reason: z.string().max(240).optional()
});

export const voiceCallRequestedPayloadSchema = z.object({
  call_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  phone_e164: phoneE164,
  campaign_id: z.string().uuid().optional(),
  enrollment_id: z.string().uuid().optional(),
  agent_config_ref: z.string().max(160).optional(),
  product_flow: novaFlowIdSchema.optional()
});

export const voiceCallRequestedV2PayloadSchema = voiceCallRequestedPayloadSchema.extend({
  dynamic_vars: z.record(z.string().max(240)).optional()
});

export const voiceCallDispatchedPayloadSchema = z.object({
  call_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  campaign_id: z.string().uuid().optional(),
  transport: z.enum(["dialer", "elevenlabs_sip_direct"]),
  dialer_call_ref: z.string().max(160).optional(),
  provider_conversation_id: z.string().max(160).optional()
});

export const voiceCallCompletedPayloadSchema = z.object({
  call_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  campaign_id: z.string().uuid().optional(),
  enrollment_id: z.string().uuid().optional(),
  status: z.enum(["completed", "failed", "needs_reconciliation"]),
  result_code: z.string().max(80).optional(),
  disposition: z.string().max(80).optional(),
  intent: z.string().max(80).optional(),
  amd_label: z.string().max(80).optional(),
  provider_conversation_id: z.string().max(160).optional(),
  transcript_excerpt: z.string().max(4000).optional()
});

export const waSendRequestedPayloadSchema = z.object({
  message_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().min(3).max(160),
  mode: z.enum(["flow", "text"]),
  flow_id: z.string().max(80).optional(),
  text: z.string().max(2000).optional(),
  agency_tag: z.string().max(40).optional(),
  review_id: z.string().uuid().optional(),
  product_flow: novaFlowIdSchema.optional()
});

export const waMessageSentPayloadSchema = z.object({
  message_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().min(3).max(160).optional(),
  provider_ref: z.string().max(160).optional(),
  mode: z.enum(["flow", "text"]),
  text: z.string().max(4000).optional()
});

/** Inbound LIWA → Ops Conversaciones (chat clone). */
export const waMessageReceivedPayloadSchema = z.object({
  message_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().min(3).max(160).optional(),
  text: z.string().min(1).max(4000),
  external_id: z.string().max(240).optional(),
  kind: z.enum(["text", "document", "system"]).optional().default("text"),
  agency_code: z.string().max(40).optional()
});

export const documentReceivedPayloadSchema = z.object({
  document_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().max(160).optional(),
  storage_key: z.string().min(3).max(320),
  content_type: z.string().min(3).max(120),
  byte_size: z.number().int().positive().max(20_971_520)
});

export const documentValidatedPayloadSchema = z.object({
  document_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().max(160).optional(),
  status: z.enum(["validated", "rejected"]),
  rejection_reason: z.string().max(240).optional()
});

export const prequalCompletedPayloadSchema = z.object({
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().max(160).optional(),
  result: z.record(z.unknown()).optional()
});

export const csatRecordedPayloadSchema = z.object({
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().max(160).optional(),
  score: z.number().min(1).max(5),
  note: z.string().max(500).optional(),
  channel: z.enum(["whatsapp", "voice"]).optional()
});

export const optOutPayloadSchema = z.object({
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().max(160).optional(),
  reason: z.string().max(240).optional()
});

export const tipificacionRecordedPayloadSchema = z.object({
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().max(160).optional(),
  tipificacion: z.string().min(1).max(80),
  stage: z.string().max(40).optional()
});

export const handoffRequestedPayloadSchema = z.object({
  handoff_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  contact_ref: z.string().max(160).optional(),
  agency_code: z.string().min(2).max(40),
  agency_tag: z.string().max(40).optional(),
  reason: z.string().max(240).optional()
});

export const leadQualifiedPayloadSchema = z.object({
  lead_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  stage: z.enum([
    "pendiente",
    "contactado",
    "interesado",
    "documento",
    "transferido",
    "renovado",
    "no_interes",
    "new",
    "contacted",
    "prequalified",
    "handoff",
    "won",
    "lost"
  ]),
  tipification: z.string().max(80).optional()
});

export const coreOutcomeRecordedPayloadSchema = z.object({
  outcome_id: z.string().uuid(),
  contact_id: z.string().uuid(),
  kind: z.enum(["csat", "core_financial", "campaign"]),
  score: z.number().optional(),
  external_ref: z.string().max(160).optional()
});

export const contactImportedEventSchema = envelopeEvent("contact.imported", contactImportedPayloadSchema);
export const contactScoredEventSchema = envelopeEvent("contact.scored", contactScoredPayloadSchema);
export const contactEligibilityDecidedEventSchema = envelopeEvent(
  "contact.eligibility.decided",
  contactEligibilityDecidedPayloadSchema
);
export const voiceCallRequestedEventSchema = envelopeEvent("voice.call.requested", voiceCallRequestedPayloadSchema);
export const voiceCallRequestedV2EventSchema = envelopeEvent(
  "voice.call.requested.v2",
  voiceCallRequestedV2PayloadSchema
);
export const voiceCallDispatchedEventSchema = envelopeEvent("voice.call.dispatched", voiceCallDispatchedPayloadSchema);
export const voiceCallCompletedEventSchema = envelopeEvent("voice.call.completed", voiceCallCompletedPayloadSchema);
export const waSendRequestedEventSchema = envelopeEvent("wa.send.requested", waSendRequestedPayloadSchema);
export const waMessageSentEventSchema = envelopeEvent("wa.message.sent", waMessageSentPayloadSchema);
export const waMessageReceivedEventSchema = envelopeEvent("wa.message.received", waMessageReceivedPayloadSchema);
export const documentReceivedEventSchema = envelopeEvent("document.received", documentReceivedPayloadSchema);
export const documentValidatedEventSchema = envelopeEvent("document.validated", documentValidatedPayloadSchema);
export const prequalCompletedEventSchema = envelopeEvent("wa.prequal.completed", prequalCompletedPayloadSchema);
export const csatRecordedEventSchema = envelopeEvent("csat.recorded", csatRecordedPayloadSchema);
export const optOutEventSchema = envelopeEvent("contact.opt_out", optOutPayloadSchema);
export const tipificacionRecordedEventSchema = envelopeEvent(
  "crm.tipificacion.recorded",
  tipificacionRecordedPayloadSchema
);
export const handoffRequestedEventSchema = envelopeEvent("handoff.requested", handoffRequestedPayloadSchema);
export const leadQualifiedEventSchema = envelopeEvent("lead.qualified", leadQualifiedPayloadSchema);
export const coreOutcomeRecordedEventSchema = envelopeEvent("core.outcome.recorded", coreOutcomeRecordedPayloadSchema);

export const novaCatalog = {
  product: {
    code: novaProductId,
    name: "NOVA",
    description: "Campañas de contacto proactivo por voz IA y mensajería."
  },
  roles: ["admin", "supervisor", "asesor"] as const,
  contexts: ["nova-core", "voice-channel", "liwa-channel", "documents"] as const,
  eventTypes: [
    "contact.imported",
    "contact.scored",
    "contact.eligibility.decided",
    "voice.call.requested",
    "voice.call.dispatched",
    "voice.call.completed",
    "wa.send.requested",
    "wa.message.sent",
    "wa.message.received",
    "wa.prequal.completed",
    "document.received",
    "document.validated",
    "handoff.requested",
    "csat.recorded",
    "contact.opt_out",
    "crm.tipificacion.recorded",
    "lead.qualified",
    "core.outcome.recorded"
  ] as const
};

/** Additive event catalog for consumers that have adopted the v2 voice request contract. */
export const novaEventTypesV2 = [...novaCatalog.eventTypes, "voice.call.requested.v2"] as const;
