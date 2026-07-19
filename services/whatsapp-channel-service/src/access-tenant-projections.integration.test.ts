import { createDatabase } from "@hyperion/database";
import {
  accessTenantSnapshotEventSchema,
  accessTenantSnapshotV1EventType,
  type AccessTenantSnapshotEvent
} from "@hyperion/platform-contracts/access-tenant-snapshot";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { consumeAccessTenantSnapshot } from "./access-tenant-projections.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

describeIntegration("Access → Channel tenant snapshot projection", () => {
  const db = createDatabase(databaseUrl!);

  afterAll(async () => {
    // CI provisions a disposable database. The runtime role intentionally has
    // no DELETE grant on projection history, so fixture cleanup must never
    // widen the production ACL.
    await db.close();
  });

  it("applies monotonically, deduplicates exactly and needs no Access row", async () => {
    const tenantId = randomUUID();
    const first = event(tenantId, 10, "active");

    await expect(consumeAccessTenantSnapshot(db, first)).resolves.toEqual({ status: "accepted" });
    await expect(consumeAccessTenantSnapshot(db, first)).resolves.toEqual({ status: "duplicate" });

    const stale = event(tenantId, 9, "paused");
    await expect(consumeAccessTenantSnapshot(db, stale)).resolves.toEqual({ status: "stale" });

    const sameVersionConflict = event(tenantId, 10, "archived");
    await expect(consumeAccessTenantSnapshot(db, sameVersionConflict)).resolves.toEqual({
      status: "conflict",
      reason: "source_version"
    });

    const next = event(tenantId, 11, "paused");
    await expect(consumeAccessTenantSnapshot(db, next)).resolves.toEqual({ status: "accepted" });

    const state = await db.query<{
      status: string;
      sourceVersion: string;
      sourceEventId: string;
      inboxCount: number;
    }>(
      `select snapshot.status, snapshot.source_version::text as "sourceVersion",
              snapshot.source_event_id as "sourceEventId",
              (select count(*)::int from channel_runtime.access_projection_inbox where tenant_id = $1) as "inboxCount"
         from channel_runtime.tenant_snapshots snapshot
        where snapshot.tenant_id = $1`,
      [tenantId]
    );
    expect(state.rows).toEqual([
      {
        status: "paused",
        sourceVersion: "11",
        sourceEventId: next.id,
        inboxCount: 4
      }
    ]);
  });

  it("rejects reusing one global event id for another tenant", async () => {
    const firstTenant = randomUUID();
    const secondTenant = randomUUID();
    const first = event(firstTenant, 1, "active");
    await expect(consumeAccessTenantSnapshot(db, first)).resolves.toEqual({ status: "accepted" });

    const collision = accessTenantSnapshotEventSchema.parse({
      ...first,
      tenantId: secondTenant,
      payload: { ...first.payload, tenantId: secondTenant }
    });
    await expect(consumeAccessTenantSnapshot(db, collision)).resolves.toEqual({
      status: "conflict",
      reason: "event_id"
    });
  });
});

function event(
  tenantId: string,
  sourceVersion: number,
  status: "active" | "paused" | "archived"
): AccessTenantSnapshotEvent {
  return accessTenantSnapshotEventSchema.parse({
    id: randomUUID(),
    type: accessTenantSnapshotV1EventType,
    version: 1,
    occurredAt: new Date().toISOString(),
    tenantId,
    payload: {
      tenantId,
      status,
      sourceVersion,
      sourceUpdatedAt: new Date().toISOString()
    }
  });
}
