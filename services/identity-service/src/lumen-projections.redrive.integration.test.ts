import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  replayCurrentAccessLumenProjection,
  redriveAccessLumenProjectionDeadLetter,
  type AccessLumenProjectionKind
} from "./lumen-projections.js";

const fixtureUrl = process.env.TEST_ACCESS_FIXTURE_DATABASE_URL?.trim();
const identityUrl = process.env.TEST_IDENTITY_DATABASE_URL?.trim();
const disposableDatabase = process.env.TEST_ACCESS_DATABASE_DISPOSABLE === "true";
const integration = fixtureUrl && identityUrl && disposableDatabase ? describe : describe.skip;

interface StoredProjectionRow {
  readonly aggregateId: string;
  readonly attemptCount: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly payload: Record<string, unknown>;
  readonly projectionKind: AccessLumenProjectionKind;
  readonly publishedAt: Date | null;
  readonly sourceVersion: string;
  readonly status: string;
}

integration("Access→LUMEN exact replay on disposable PostgreSQL", () => {
  const tenantId = randomUUID();
  const operatorId = randomUUID();
  const tenantEventId = randomUUID();
  const operatorEventId = randomUUID();
  const deadLetterEventId = randomUUID();
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
    expect(runtimeIdentity.rows[0]?.currentDatabase).not.toBe("postgres");

    const tenantPayload = {
      tenantId,
      status: "active",
      isDemo: true,
      sourceVersion: 101,
      sourceUpdatedAt: "2026-07-19T05:00:00.000Z"
    };
    const operatorPayload = {
      tenantId,
      operatorId,
      role: "advisor",
      isActive: true,
      canReview: true,
      sourceVersion: 202,
      sourceUpdatedAt: "2026-07-19T05:01:00.000Z"
    };

    await fixture.transaction(async (transaction) => {
      await transaction.query(
        `insert into platform.tenants (id, slug, display_name, metadata)
         values ($1, $2, 'LUMEN exact replay disposable fixture', '{"is_demo":true,"fixture":true}'::jsonb)`,
        [tenantId, `lumen-replay-${tenantId.replaceAll("-", "")}`]
      );
      await transaction.query(
        `insert into access_runtime.lumen_projection_state
           (projection_kind, tenant_id, aggregate_id, source_version, source_updated_at, payload_hash)
         values
           ('tenant_snapshot', $1, $1, 101, $2, $3),
           ('operator_grant', $1, $4, 202, $5, $6)`,
        [
          tenantId,
          tenantPayload.sourceUpdatedAt,
          "a".repeat(64),
          operatorId,
          operatorPayload.sourceUpdatedAt,
          "b".repeat(64)
        ]
      );
      await transaction.query(
        `insert into access_runtime.lumen_projection_outbox
           (id, tenant_id, projection_kind, aggregate_id, source_version,
            event_type, event_version, payload, occurred_at, status,
            attempt_count, published_at)
         values
           ($1, $2, 'tenant_snapshot', $2, 101,
            'access.lumen.tenant-snapshot.v1', 1, $3::jsonb,
            now() - interval '10 minutes', 'published', 7, now() - interval '4 minutes'),
           ($4, $2, 'operator_grant', $5, 202,
            'access.lumen.operator-grant.v1', 1, $6::jsonb,
            now() - interval '10 minutes', 'published', 8, now() - interval '4 minutes'),
           ($7, $2, 'operator_grant', $5, 201,
            'access.lumen.operator-grant.v1', 1, $8::jsonb,
            now() - interval '11 minutes', 'dead_letter', 20, null)`,
        [
          tenantEventId,
          tenantId,
          JSON.stringify(tenantPayload),
          operatorEventId,
          operatorId,
          JSON.stringify(operatorPayload),
          deadLetterEventId,
          JSON.stringify({ ...operatorPayload, sourceVersion: 201, isActive: false, canReview: false })
        ]
      );
    });
  });

  afterAll(async () => {
    // Access migration 004 intentionally rejects tenant DELETE. This test is
    // admitted only for an explicitly disposable logical database and leaves
    // its UUID-scoped fixture for database teardown instead of bypassing the
    // lifecycle trigger or widening the runtime role.
    await Promise.all([identity?.close(), fixture?.close()]);
  });

  it("uses only the fenced Identity runtime ACL", async () => {
    const privileges = await identity.query<{
      canDeleteOutbox: boolean;
      canMutateTenant: boolean;
      canUpdateOutbox: boolean;
    }>(`
      select has_table_privilege(current_user, 'platform.tenants', 'INSERT,UPDATE,DELETE')
               as "canMutateTenant",
             has_table_privilege(current_user, 'access_runtime.lumen_projection_outbox', 'UPDATE')
               as "canUpdateOutbox",
             has_table_privilege(current_user, 'access_runtime.lumen_projection_outbox', 'DELETE')
               as "canDeleteOutbox"
    `);
    expect(privileges.rows).toEqual([{ canDeleteOutbox: false, canMutateTenant: false, canUpdateOutbox: true }]);
    await expect(
      identity.query("update platform.tenants set status = 'paused' where id = $1", [tenantId])
    ).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    ["tenant_snapshot", tenantEventId, tenantId, "101", "access.lumen.tenant-snapshot.v1"],
    ["operator_grant", operatorEventId, operatorId, "202", "access.lumen.operator-grant.v1"]
  ] as const)(
    "requeues the exact current %s event and makes a repeated replay a no-op",
    async (projectionKind, eventId, aggregateId, sourceVersion, eventType) => {
      const before = await readProjection(identity, eventId);
      expect(before).toMatchObject({
        eventId,
        aggregateId,
        projectionKind,
        sourceVersion,
        eventType,
        eventVersion: 1,
        status: "published",
        publishedAt: expect.any(Date)
      });

      await expect(
        replayCurrentAccessLumenProjection(identity, { eventId, tenantId, projectionKind })
      ).resolves.toEqual({
        eventId,
        tenantId,
        projectionKind,
        aggregateId,
        sourceVersion,
        eventType,
        eventVersion: 1
      });
      await expect(
        replayCurrentAccessLumenProjection(identity, { eventId, tenantId, projectionKind })
      ).resolves.toBeUndefined();

      const after = await readProjection(identity, eventId);
      expect(after).toEqual({
        ...before,
        attemptCount: 0,
        publishedAt: null,
        status: "retry_scheduled"
      });
    }
  );

  it("keeps exact dead-letter redrive available without confusing it with current replay", async () => {
    await expect(
      redriveAccessLumenProjectionDeadLetter(identity, {
        eventId: deadLetterEventId,
        tenantId,
        projectionKind: "operator_grant"
      })
    ).resolves.toMatchObject({
      eventId: deadLetterEventId,
      tenantId,
      projectionKind: "operator_grant",
      sourceVersion: "201"
    });
    await expect(
      replayCurrentAccessLumenProjection(identity, {
        eventId: deadLetterEventId,
        tenantId,
        projectionKind: "operator_grant"
      })
    ).resolves.toBeUndefined();
  });
});

async function readProjection(db: DatabaseClient, eventId: string): Promise<StoredProjectionRow> {
  const result = await db.query<StoredProjectionRow>(
    `select id::text as "eventId", projection_kind as "projectionKind",
            aggregate_id::text as "aggregateId", source_version::text as "sourceVersion",
            event_type as "eventType", event_version as "eventVersion", payload,
            status, attempt_count as "attemptCount", published_at as "publishedAt"
       from access_runtime.lumen_projection_outbox
      where id = $1`,
    [eventId]
  );
  const row = result.rows[0];
  if (!row) throw new Error("LUMEN projection fixture is missing");
  return row;
}
