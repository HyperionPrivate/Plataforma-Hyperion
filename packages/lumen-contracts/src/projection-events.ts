import { z } from "zod";

const sourceVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sourceUpdatedAtSchema = z.string().datetime({ offset: true });
const shortNullableTextSchema = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();

export const lumenTenantSnapshotPayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    status: z.enum(["active", "paused", "archived"]),
    isDemo: z.boolean(),
    sourceVersion: sourceVersionSchema,
    sourceUpdatedAt: sourceUpdatedAtSchema
  })
  .strict();

export const lumenOperatorGrantPayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    operatorId: z.string().uuid(),
    role: z.string().trim().min(1).max(80),
    isActive: z.boolean(),
    canReview: z.boolean(),
    sourceVersion: sourceVersionSchema,
    sourceUpdatedAt: sourceUpdatedAtSchema
  })
  .strict()
  .refine((payload) => payload.isActive || !payload.canReview, {
    message: "Inactive operators cannot retain review permission",
    path: ["canReview"]
  });

export const lumenEncounterReferencePayloadSchema = z
  .object({
    tenantId: z.string().uuid(),
    encounterId: z.string().uuid(),
    patientId: z.string().uuid(),
    siteId: z.string().uuid(),
    professionalId: z.string().uuid(),
    patientDisplayName: z.string().trim().min(1).max(240),
    patientAge: z.number().int().min(0).max(130).nullable(),
    payer: shortNullableTextSchema(240),
    documentMasked: shortNullableTextSchema(80),
    professionalName: z.string().trim().min(1).max(240),
    subspecialty: shortNullableTextSchema(240),
    siteName: z.string().trim().min(1).max(240),
    patientIsDemo: z.literal(true),
    professionalIsDemo: z.literal(true),
    sourceVersion: sourceVersionSchema,
    sourceUpdatedAt: sourceUpdatedAtSchema
  })
  .strict();

function eventSchema<TType extends string, TPayload extends z.ZodTypeAny>(type: TType, payload: TPayload) {
  return z
    .object({
      id: z.string().uuid(),
      type: z.literal(type),
      version: z.literal(1),
      occurredAt: z.string().datetime({ offset: true }),
      tenantId: z.string().uuid(),
      payload
    })
    .strict();
}

export const lumenTenantSnapshotEventSchema = eventSchema(
  "access.lumen.tenant-snapshot.v1",
  lumenTenantSnapshotPayloadSchema
);
export const lumenOperatorGrantEventSchema = eventSchema(
  "access.lumen.operator-grant.v1",
  lumenOperatorGrantPayloadSchema
);
export const lumenEncounterReferenceEventSchema = eventSchema(
  "pulso.lumen.encounter-reference.v1",
  lumenEncounterReferencePayloadSchema
);

export const lumenProjectionEventSchema = z
  .union([lumenTenantSnapshotEventSchema, lumenOperatorGrantEventSchema, lumenEncounterReferenceEventSchema])
  .refine((event) => event.tenantId.toLowerCase() === event.payload.tenantId.toLowerCase(), {
    message: "Envelope tenantId must match payload tenantId",
    path: ["tenantId"]
  });

export const lumenProjectionKindSchema = z.enum(["tenant_snapshot", "operator_grant", "encounter_reference"]);
export const lumenProjectionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted"), projection: lumenProjectionKindSchema }).strict(),
  z.object({ status: z.literal("duplicate"), projection: lumenProjectionKindSchema }).strict(),
  z.object({ status: z.literal("stale"), projection: lumenProjectionKindSchema }).strict(),
  z
    .object({
      status: z.literal("conflict"),
      projection: lumenProjectionKindSchema.optional(),
      reason: z.enum(["event_id", "source_version"])
    })
    .strict(),
  z.object({ status: z.literal("frozen"), projection: z.literal("encounter_reference") }).strict()
]);

export type LumenTenantSnapshotEvent = z.infer<typeof lumenTenantSnapshotEventSchema>;
export type LumenOperatorGrantEvent = z.infer<typeof lumenOperatorGrantEventSchema>;
export type LumenEncounterReferenceEvent = z.infer<typeof lumenEncounterReferenceEventSchema>;
export type LumenProjectionEvent = z.infer<typeof lumenProjectionEventSchema>;
export type LumenProjectionKind = z.infer<typeof lumenProjectionKindSchema>;
export type LumenProjectionResult = z.infer<typeof lumenProjectionResultSchema>;
