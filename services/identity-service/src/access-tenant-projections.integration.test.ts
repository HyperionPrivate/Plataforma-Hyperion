import { createDatabase, type DatabaseClient } from "@hyperion/database";
import type { HttpOutboxFetch } from "@hyperion/durable-events";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PostgresAccessTenantProjectionOutbox,
  createAccessTenantProjectionHttpDispatcher,
  enqueueAccessTenantSnapshot,
  reconcileAccessTenantSnapshots,
  replayCurrentAccessTenantProjection
} from "./access-tenant-projections.js";

const fixtureUrl = process.env.TEST_ACCESS_FIXTURE_DATABASE_URL?.trim();
const identityUrl = process.env.TEST_IDENTITY_DATABASE_URL?.trim();
const disposableDatabase = process.env.TEST_ACCESS_DATABASE_DISPOSABLE === "true";
const integration = fixtureUrl && identityUrl && disposableDatabase ? describe : describe.skip;

interface ProjectionRow {
  readonly attemptCount: number;
  readonly eventId: string;
  readonly lastErrorCode: string | null;
  readonly payload: Record<string, unknown>;
  readonly payloadHash: string;
  readonly publishedAt: Date | null;
  readonly sourceVersion: string;
  readonly stateSourceVersion: string;
  readonly status: string;
}

integration("Access tenant snapshot producer on disposable PostgreSQL", () => {
  const tenantId = randomUUID();
  const tenantSlug = `projection-${tenantId.replaceAll("-", "")}`;
  const workerId = `access-projection-${randomUUID()}`;
  let fixture: DatabaseClient;
  let identity: DatabaseClient;

  beforeAll(async () => {
    fixture = createDatabase(fixtureUrl!);
    identity = createDatabase(identityUrl!);

    const [fixtureIdentity, runtimeIdentity] = await Promise.all([
      fixture.query<{ currentDatabase: string; currentRole: string }>(
        'select current_database() as "currentDatabase", current_user as "currentRole"'
      ),
      identity.query<{ currentDatabase: string; currentRole: string }>(
        'select current_database() as "currentDatabase", current_user as "currentRole"'
      )
    ]);
    expect(fixtureIdentity.rows[0]?.currentRole).toBe("hyperion_access_migrator");
    expect(runtimeIdentity.rows[0]?.currentRole).toBe("hyperion_identity");
    expect(runtimeIdentity.rows[0]?.currentDatabase).toBe(fixtureIdentity.rows[0]?.currentDatabase);

    await fixture.query(
      `insert into platform.tenants (id, slug, display_name, status, metadata)
       values ($1, $2, 'Access tenant projection PostgreSQL fixture', 'active', '{"fixture":true}'::jsonb)`,
      [tenantId, tenantSlug]
    );
  });

  afterAll(async () => {
    // Access 004 makes tenant lifecycle archive-only until the provider owns a
    // tombstone contract. The CI database is disposable; terminalize the
    // fixture without weakening or bypassing the hard-delete guard.
    if (fixture) {
      await fixture.query("update platform.tenants set status = 'archived' where id = $1", [tenantId]);
    }
    await Promise.all([identity?.close(), fixture?.close()]);
  });

  it("atomically reconciles, retries a failed destination, and replays only the exact current event", async () => {
    const privileges = await identity.query<{
      canInsertOutbox: boolean;
      canMutateTenant: boolean;
      canUpdateState: boolean;
    }>(`
      select has_table_privilege(current_user, 'platform.tenants', 'INSERT,UPDATE,DELETE')
               as "canMutateTenant",
             has_table_privilege(current_user, 'access_runtime.tenant_projection_outbox', 'INSERT')
               as "canInsertOutbox",
             has_table_privilege(current_user, 'access_runtime.tenant_projection_state', 'UPDATE')
               as "canUpdateState"
    `);
    expect(privileges.rows).toEqual([{ canInsertOutbox: true, canMutateTenant: false, canUpdateState: true }]);
    await expect(
      identity.query("update platform.tenants set status = 'paused' where id = $1", [tenantId])
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      identity.transaction(async (transaction) => {
        await expect(enqueueAccessTenantSnapshot(transaction, tenantId)).resolves.toEqual({ eventsEnqueued: 1 });
        throw new Error("force projection transaction rollback");
      })
    ).rejects.toThrow("force projection transaction rollback");
    await expect(readProjectionRows(fixture, tenantId)).resolves.toEqual([]);

    await expect(reconcileAccessTenantSnapshots(identity, 10)).resolves.toEqual({
      candidatesProcessed: 1,
      eventsEnqueued: 1,
      hasMore: false
    });
    const [first] = await readProjectionRows(fixture, tenantId);
    expect(first).toMatchObject({
      attemptCount: 0,
      lastErrorCode: null,
      sourceVersion: first?.stateSourceVersion,
      status: "queued"
    });
    expect(first?.payload).toEqual({
      tenantId,
      status: "active",
      sourceVersion: Number(first.sourceVersion),
      sourceUpdatedAt: expect.any(String)
    });
    expect(first?.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(reconcileAccessTenantSnapshots(identity, 10)).resolves.toEqual({
      candidatesProcessed: 0,
      eventsEnqueued: 0,
      hasMore: false
    });

    let destinationAvailable = false;
    const deliveries: Array<{
      readonly body: Record<string, unknown>;
      readonly caller: string | null;
      readonly eventId: string | null;
    }> = [];
    const fetch: HttpOutboxFetch = async (_input, init) => {
      const headers = new Headers(init?.headers);
      deliveries.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        caller: headers.get("x-hyperion-caller"),
        eventId: headers.get("x-hyperion-event-id")
      });
      if (!destinationAvailable) throw new TypeError("projection destination unavailable");
      return new Response(null, { status: 204 });
    };
    const outbox = new PostgresAccessTenantProjectionOutbox(
      identity,
      workerId,
      "https://channel.example/internal/v1/events/access-tenant-snapshots"
    );
    const dispatcher = createAccessTenantProjectionHttpDispatcher(
      outbox,
      workerId,
      "access-projection-integration-token-0001",
      fetch
    );

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    const [failed] = await readProjectionRows(fixture, tenantId);
    expect(failed).toMatchObject({
      attemptCount: 1,
      eventId: first?.eventId,
      lastErrorCode: "network_error",
      publishedAt: null,
      status: "retry_scheduled"
    });

    await fixture.query("update access_runtime.tenant_projection_outbox set next_attempt_at = now() where id = $1", [
      first?.eventId
    ]);
    destinationAvailable = true;
    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const [recovered] = await readProjectionRows(fixture, tenantId);
    expect(recovered).toMatchObject({
      attemptCount: 2,
      eventId: first?.eventId,
      lastErrorCode: null,
      publishedAt: expect.any(Date),
      status: "published"
    });
    expect(deliveries.slice(0, 2).map(({ eventId }) => eventId)).toEqual([first?.eventId, first?.eventId]);
    expect(deliveries[1]?.body).toEqual(deliveries[0]?.body);

    await fixture.query(
      `update platform.tenants
          set status = 'paused', updated_at = clock_timestamp() + interval '1 second'
        where id = $1`,
      [tenantId]
    );
    await expect(reconcileAccessTenantSnapshots(identity, 10)).resolves.toMatchObject({
      candidatesProcessed: 1,
      eventsEnqueued: 1
    });
    const [, second] = await readProjectionRows(fixture, tenantId);
    expect(second).toMatchObject({
      sourceVersion: String(Number(first?.sourceVersion) + 1),
      stateSourceVersion: String(Number(first?.sourceVersion) + 1),
      status: "queued"
    });
    expect(second?.eventId).not.toBe(first?.eventId);
    expect(second?.payload).toMatchObject({ tenantId, status: "paused", sourceVersion: Number(second?.sourceVersion) });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    await fixture.query(
      `update access_runtime.tenant_projection_outbox
          set published_at = now() - interval '4 minutes'
        where tenant_id = $1 and status = 'published'`,
      [tenantId]
    );

    await expect(replayCurrentAccessTenantProjection(identity, { tenantId })).resolves.toEqual({
      eventId: second?.eventId,
      tenantId,
      sourceVersion: Number(second?.sourceVersion),
      eventType: "access.tenant.snapshot.v1"
    });
    await expect(replayCurrentAccessTenantProjection(identity, { tenantId })).resolves.toBeUndefined();

    const replayQueued = await readProjectionRows(fixture, tenantId);
    expect(replayQueued[0]).toMatchObject({ eventId: first?.eventId, status: "published" });
    expect(replayQueued[1]).toMatchObject({
      attemptCount: 0,
      eventId: second?.eventId,
      payload: second?.payload,
      publishedAt: null,
      sourceVersion: second?.sourceVersion,
      status: "retry_scheduled"
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const finalRows = await readProjectionRows(fixture, tenantId);
    expect(finalRows[1]).toMatchObject({
      attemptCount: 1,
      eventId: second?.eventId,
      payload: second?.payload,
      sourceVersion: second?.sourceVersion,
      status: "published"
    });
    expect(deliveries).toHaveLength(4);
    expect(deliveries.every(({ caller }) => caller === "identity-service")).toBe(true);
    expect(deliveries.slice(2).map(({ eventId }) => eventId)).toEqual([second?.eventId, second?.eventId]);
    expect(deliveries[3]?.body).toEqual(deliveries[2]?.body);
    await dispatcher.stop();
  });
});

async function readProjectionRows(db: DatabaseClient, tenantId: string): Promise<ProjectionRow[]> {
  const result = await db.query<ProjectionRow>(
    `select event_row.id::text as "eventId",
            event_row.source_version::text as "sourceVersion",
            state_row.source_version::text as "stateSourceVersion",
            state_row.payload_hash as "payloadHash",
            event_row.payload,
            event_row.status,
            event_row.attempt_count as "attemptCount",
            event_row.published_at as "publishedAt",
            event_row.last_error_code as "lastErrorCode"
       from access_runtime.tenant_projection_outbox event_row
       join access_runtime.tenant_projection_state state_row on state_row.tenant_id = event_row.tenant_id
      where event_row.tenant_id = $1
      order by event_row.source_version`,
    [tenantId]
  );
  return result.rows;
}
