import { describe, expect, it } from "vitest";
import { lumenProjectionEventSchema, lumenProjectionResultSchema } from "./projection-events.js";

const TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const EVENT = {
  id: "a56e320f-cbce-4e96-b7fc-c79e52970a52",
  type: "access.lumen.tenant-snapshot.v1",
  version: 1,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: TENANT_ID,
  payload: {
    tenantId: TENANT_ID,
    status: "active",
    isDemo: true,
    sourceVersion: 1,
    sourceUpdatedAt: "2026-07-13T14:59:00.000Z"
  }
} as const;

describe("LUMEN provider-owned projection contracts v1", () => {
  it("accepts the strict event envelope and its consumer result", () => {
    expect(lumenProjectionEventSchema.safeParse(EVENT).success).toBe(true);
    expect(lumenProjectionResultSchema.safeParse({ status: "accepted", projection: "tenant_snapshot" }).success).toBe(
      true
    );
  });

  it("rejects cross-tenant envelopes, sensitive extras and unknown results", () => {
    expect(
      lumenProjectionEventSchema.safeParse({
        ...EVENT,
        tenantId: "7fba9ced-2c1a-4bbd-b2ee-72c379a56143"
      }).success
    ).toBe(false);
    expect(
      lumenProjectionEventSchema.safeParse({ ...EVENT, payload: { ...EVENT.payload, transcript: "forbidden" } }).success
    ).toBe(false);
    expect(lumenProjectionResultSchema.safeParse({ status: "ignored", projection: "tenant_snapshot" }).success).toBe(
      false
    );
  });
});
