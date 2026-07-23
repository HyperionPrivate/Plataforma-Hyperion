import { z } from "zod";

export const accessTenantSnapshotV1EventType = "access.tenant.snapshot.v1" as const;

const tenantIdSchema = z.string().uuid();
const sourceVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sourceDateTimeSchema = z.string().datetime({ offset: true });

/**
 * Access-owned tenant lifecycle state suitable for product-local projections.
 * Deliberately excludes display, routing, grant and product-specific fields.
 */
export const accessTenantSnapshotPayloadSchema = z
  .object({
    tenantId: tenantIdSchema,
    status: z.enum(["active", "paused", "archived"]),
    sourceVersion: sourceVersionSchema,
    sourceUpdatedAt: sourceDateTimeSchema
  })
  .strict();

export const accessTenantSnapshotEventSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal(accessTenantSnapshotV1EventType),
    version: z.literal(1),
    occurredAt: sourceDateTimeSchema,
    tenantId: tenantIdSchema,
    payload: accessTenantSnapshotPayloadSchema
  })
  .strict()
  .refine((event) => event.tenantId === event.payload.tenantId, {
    message: "Envelope tenantId must match payload tenantId",
    path: ["payload", "tenantId"]
  });

export type AccessTenantSnapshotPayload = z.infer<typeof accessTenantSnapshotPayloadSchema>;
export type AccessTenantSnapshotEvent = z.infer<typeof accessTenantSnapshotEventSchema>;
