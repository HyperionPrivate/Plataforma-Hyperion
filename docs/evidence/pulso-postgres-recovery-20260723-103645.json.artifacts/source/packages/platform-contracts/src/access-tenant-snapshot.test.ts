import { describe, expect, it } from "vitest";
import {
  accessTenantSnapshotEventSchema,
  accessTenantSnapshotPayloadSchema,
  accessTenantSnapshotV1EventType
} from "./access-tenant-snapshot.js";

const TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const EVENT = {
  id: "a56e320f-cbce-4e96-b7fc-c79e52970a52",
  type: accessTenantSnapshotV1EventType,
  version: 1,
  occurredAt: "2026-07-18T23:00:00.000Z",
  tenantId: TENANT_ID,
  payload: {
    tenantId: TENANT_ID,
    status: "active",
    sourceVersion: 1,
    sourceUpdatedAt: "2026-07-18T22:59:00.000Z"
  }
} as const;

describe("Access-owned tenant snapshot contract v1", () => {
  it("accepts only the generic tenant lifecycle envelope", () => {
    expect(accessTenantSnapshotEventSchema.parse(EVENT)).toEqual(EVENT);

    for (const status of ["active", "paused", "archived"] as const) {
      expect(accessTenantSnapshotPayloadSchema.safeParse({ ...EVENT.payload, status }).success).toBe(true);
    }
  });

  it("rejects invalid envelope identity, type, version and timestamps", () => {
    for (const candidate of [
      { ...EVENT, id: "not-a-uuid" },
      { ...EVENT, type: "access.lumen.tenant-snapshot.v1" },
      { ...EVENT, version: 2 },
      { ...EVENT, occurredAt: "2026-07-18" },
      { ...EVENT, tenantId: "not-a-uuid" }
    ]) {
      expect(accessTenantSnapshotEventSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("requires matching envelope and payload tenants", () => {
    const result = accessTenantSnapshotEventSchema.safeParse({
      ...EVENT,
      payload: { ...EVENT.payload, tenantId: "7fba9ced-2c1a-4bbd-b2ee-72c379a56143" }
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          message: "Envelope tenantId must match payload tenantId",
          path: ["payload", "tenantId"]
        })
      );
    }
  });

  it("requires a positive JS-safe source version and valid source timestamp", () => {
    for (const sourceVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(accessTenantSnapshotPayloadSchema.safeParse({ ...EVENT.payload, sourceVersion }).success).toBe(false);
    }
    expect(
      accessTenantSnapshotPayloadSchema.safeParse({ ...EVENT.payload, sourceVersion: Number.MAX_SAFE_INTEGER }).success
    ).toBe(true);
    expect(
      accessTenantSnapshotPayloadSchema.safeParse({ ...EVENT.payload, sourceUpdatedAt: "not-a-datetime" }).success
    ).toBe(false);
  });

  it("rejects extra, identifying and product-specific fields at every object boundary", () => {
    expect(accessTenantSnapshotEventSchema.safeParse({ ...EVENT, subject: "tenant" }).success).toBe(false);

    for (const extra of [
      { slug: "coop-futuro" },
      { name: "Coop Futuro" },
      { metadata: {} },
      { grants: [] },
      { productId: "PULSO_IRIS" },
      { isDemo: true }
    ]) {
      expect(
        accessTenantSnapshotEventSchema.safeParse({
          ...EVENT,
          payload: { ...EVENT.payload, ...extra }
        }).success
      ).toBe(false);
    }
  });
});
