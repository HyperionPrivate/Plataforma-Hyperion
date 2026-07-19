import { randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuditClient, PULSO_AUDIT_EVENT_TYPE } from "./audit-client.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_PULSO_FIXTURE_DATABASE_URL = process.env.TEST_PULSO_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_PULSO_FIXTURE_DATABASE_URL ? describe : describe.skip;

let client: pg.Client;
let fixtureClient: pg.Client;
let db: DatabaseClient;
let tenantId: string;

describeIntegration("PULSO transactional audit outbox", () => {
  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    fixtureClient = new Client({ connectionString: TEST_PULSO_FIXTURE_DATABASE_URL });
    await client.connect();
    await fixtureClient.connect();
    db = createDatabase(TEST_DATABASE_URL ?? "");
    tenantId = randomUUID();
    await fixtureClient.query(
      `insert into platform.tenants (id, slug, display_name)
       values ($1::uuid, $2, 'PULSO audit transaction integration')`,
      [tenantId, `pulso-audit-${tenantId}`]
    );
  });

  afterAll(async () => {
    await db?.close();
    if (client) {
      if (tenantId) {
        await client.query("delete from pulso_iris.outbox_events where tenant_id = $1::uuid", [tenantId]);
      }
      await client.end();
    }
    if (fixtureClient) {
      if (tenantId) await fixtureClient.query("delete from platform.tenants where id = $1::uuid", [tenantId]);
      await fixtureClient.end();
    }
  });

  it("accepts a real DatabaseTransaction and commits its audit row", async () => {
    const entityId = randomUUID();
    const warn = vi.fn();
    const emitAudit = createAuditClient({ logger: { warn } });

    await db.transaction(async (transaction) => {
      await emitAudit(
        {
          tenantId,
          actorId: "integration-operator",
          eventType: "appointment.registered",
          entityType: "appointment",
          entityId,
          metadata: { requestId: "committed-correlation" }
        },
        transaction
      );
    });

    const persisted = await client.query<{ id: string; aggregateId: string; payload: Record<string, unknown> }>(
      `select id, aggregate_id as "aggregateId", payload
         from pulso_iris.outbox_events
        where tenant_id = $1::uuid and event_type = $2 and payload->>'entityId' = $3`,
      [tenantId, PULSO_AUDIT_EVENT_TYPE, entityId]
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.aggregateId).toBe(persisted.rows[0]?.id);
    expect(persisted.rows[0]?.payload).toMatchObject({
      tenantId,
      actorId: "integration-operator",
      eventType: "appointment.registered",
      entityType: "appointment",
      entityId,
      metadata: { source: "pulso-iris-service" }
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("commits distinct audit facts for the same entity and deduplicates their replays", async () => {
    const entityId = randomUUID();
    const emitAudit = createAuditClient({ logger: { warn: vi.fn() } });
    const facts = [
      { suffix: "revision-1", revision: 1 },
      { suffix: "revision-2", revision: 2 }
    ];

    const emitFacts = () =>
      db.transaction(async (transaction) => {
        for (const fact of facts) {
          await emitAudit(
            {
              tenantId,
              eventType: "config.updated",
              entityType: "configuration",
              entityId,
              idempotencyKey: fact.suffix,
              metadata: { revision: fact.revision }
            },
            transaction
          );
        }
      });

    await emitFacts();
    await emitFacts();

    const persisted = await client.query<{ id: string; aggregateId: string; revision: number }>(
      `select id, aggregate_id as "aggregateId", (payload#>>'{metadata,revision}')::int as revision
         from pulso_iris.outbox_events
        where tenant_id = $1::uuid and event_type = $2 and payload->>'entityId' = $3
        order by (payload#>>'{metadata,revision}')::int`,
      [tenantId, PULSO_AUDIT_EVENT_TYPE, entityId]
    );
    expect(persisted.rows).toHaveLength(2);
    expect(new Set(persisted.rows.map((row) => row.id)).size).toBe(2);
    expect(persisted.rows.every((row) => row.aggregateId === row.id)).toBe(true);
    expect(persisted.rows.map((row) => row.revision)).toEqual([1, 2]);
  });

  it("rolls back the audit row with its owning transaction", async () => {
    const entityId = randomUUID();
    const emitAudit = createAuditClient({ logger: { warn: vi.fn() } });

    await expect(
      db.transaction(async (transaction) => {
        await emitAudit(
          {
            tenantId,
            eventType: "appointment.cancelled",
            entityType: "appointment",
            entityId,
            idempotencyKey: "rolled-back"
          },
          transaction
        );
        throw new Error("synthetic domain rollback");
      })
    ).rejects.toThrow("synthetic domain rollback");

    const persisted = await client.query<{ count: number }>(
      `select count(*)::int as count
         from pulso_iris.outbox_events
        where tenant_id = $1::uuid and event_type = $2 and payload->>'entityId' = $3`,
      [tenantId, PULSO_AUDIT_EVENT_TYPE, entityId]
    );
    expect(persisted.rows[0]?.count).toBe(0);
  });

  it("keeps separate facts when a client reuses the same correlation request id", async () => {
    const entityId = randomUUID();
    const emitAudit = createAuditClient({ logger: { warn: vi.fn() } });
    const event = {
      tenantId,
      eventType: "config.updated" as const,
      entityType: "configuration",
      entityId,
      metadata: { requestId: "client-reused-correlation-id" }
    };

    await db.transaction((transaction) => emitAudit(event, transaction));
    await db.transaction((transaction) => emitAudit(event, transaction));

    const persisted = await client.query<{ count: number }>(
      `select count(*)::int as count
         from pulso_iris.outbox_events
        where tenant_id = $1::uuid and event_type = $2 and payload->>'entityId' = $3`,
      [tenantId, PULSO_AUDIT_EVENT_TYPE, entityId]
    );
    expect(persisted.rows[0]?.count).toBe(2);
  });

  it("rejects divergent idempotency-key reuse and rolls back the owning mutation", async () => {
    const entityId = randomUUID();
    const siteName = `Audit idempotency ${entityId}`;
    const emitAudit = createAuditClient({ logger: { warn: vi.fn() } });
    const common = {
      tenantId,
      eventType: "config.updated" as const,
      entityType: "site",
      entityId,
      idempotencyKey: "site-revision-1"
    };

    await db.transaction(async (transaction) => {
      await transaction.query("insert into pulso_iris.sites (id, tenant_id, name) values ($1::uuid, $2::uuid, $3)", [
        entityId,
        tenantId,
        siteName
      ]);
      await emitAudit({ ...common, metadata: { revision: 1 } }, transaction);
    });

    await expect(
      db.transaction(async (transaction) => {
        await transaction.query("update pulso_iris.sites set name = $3 where tenant_id = $1 and id = $2", [
          tenantId,
          entityId,
          `${siteName} mutated`
        ]);
        await emitAudit({ ...common, metadata: { revision: 2 } }, transaction);
      })
    ).rejects.toThrow("idempotency key was reused for a different event");

    const persisted = await client.query<{ name: string; auditCount: number }>(
      `select s.name,
              (select count(*)::int
                 from pulso_iris.outbox_events o
                where o.tenant_id = $1::uuid
                  and o.event_type = $3
                  and o.payload->>'entityId' = $2) as "auditCount"
         from pulso_iris.sites s
        where s.tenant_id = $1::uuid and s.id = $2::uuid`,
      [tenantId, entityId, PULSO_AUDIT_EVENT_TYPE]
    );
    expect(persisted.rows[0]).toEqual({ name: siteName, auditCount: 1 });
  });
});
