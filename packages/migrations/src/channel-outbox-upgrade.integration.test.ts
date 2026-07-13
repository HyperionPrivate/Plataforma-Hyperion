import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { computeChecksum, listMigrationFiles, runMigrations } from "./runner.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;
const sqlDir = fileURLToPath(new URL("../sql", import.meta.url));

describeIntegration("020 -> latest channel outbox upgrade", () => {
  it("backfills every representable non-terminal inbound exactly once and explicitly terminalizes the rest", async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    const databaseName = `hyperion_channel_upgrade_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
    let databaseCreated = false;

    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
      databaseCreated = true;
      await migrateThrough020(databaseUrl);

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      let validReceivedId = "";
      let validProcessingId = "";
      let processedId = "";
      let missingBindingId = "";
      let invalidContractId = "";
      try {
        const tenantId = (
          await client.query<{ id: string }>(
            `insert into platform.tenants (slug, display_name)
               values ($1, 'Channel upgrade test') returning id`,
            [`channel-upgrade-${randomUUID()}`]
          )
        ).rows[0]!.id;
        const connectionId = (
          await client.query<{ id: string }>(
            `insert into channel_runtime.connections (tenant_id, state)
               values ($1, 'ready') returning id`,
            [tenantId]
          )
        ).rows[0]!.id;
        const validBindingId = (
          await client.query<{ id: string }>(
            `insert into channel_runtime.thread_bindings (
                 tenant_id, connection_id, provider, external_thread_id,
                 phone_e164_hash, phone_masked
               ) values ($1, $2, 'whatsapp_web_test', $3, $4, '********1000')
               returning id`,
            [tenantId, connectionId, "573001111000@s.whatsapp.net", "a".repeat(64)]
          )
        ).rows[0]!.id;
        const invalidBindingId = (
          await client.query<{ id: string }>(
            `insert into channel_runtime.thread_bindings (
                 tenant_id, connection_id, provider, external_thread_id,
                 phone_e164_hash, phone_masked
               ) values ($1, $2, 'whatsapp_web_test', $3, $4, '********2000')
               returning id`,
            [tenantId, connectionId, "573001112000@s.whatsapp.net", "Z".repeat(64)]
          )
        ).rows[0]!.id;

        validReceivedId = await insertInbound(client, {
          tenantId,
          connectionId,
          bindingId: validBindingId,
          externalMessageId: "legacy-received",
          body: "legacy recibido",
          status: "received"
        });
        validProcessingId = await insertInbound(client, {
          tenantId,
          connectionId,
          bindingId: validBindingId,
          externalMessageId: "legacy-processing",
          body: "legacy en procesamiento",
          status: "processing"
        });
        processedId = await insertInbound(client, {
          tenantId,
          connectionId,
          bindingId: validBindingId,
          externalMessageId: "legacy-processed",
          body: "legacy terminal",
          status: "processed"
        });
        missingBindingId = await insertInbound(client, {
          tenantId,
          connectionId,
          bindingId: null,
          externalMessageId: "legacy-missing-binding",
          body: "legacy sin identidad",
          status: "queued"
        });
        invalidContractId = await insertInbound(client, {
          tenantId,
          connectionId,
          bindingId: invalidBindingId,
          externalMessageId: "legacy-invalid-contract",
          body: "legacy invalido",
          status: "retry_scheduled"
        });
      } finally {
        await client.end();
      }

      const firstUpgrade = await runMigrations(databaseUrl, sqlDir);
      expect(firstUpgrade.applied).toEqual([
        "021-autonomous-event-flow.sql",
        "022-lumen-autonomy.sql",
        "023-channel-inbound-outbox-backfill.sql",
        "024-service-database-roles.sql",
        "025-audit-ledger-autonomy.sql",
        "026-audit-source-provenance.sql"
      ]);

      const verification = new Client({ connectionString: databaseUrl });
      await verification.connect();
      try {
        const backfilled = await verification.query<{
          aggregateId: string;
          payload: Record<string, unknown>;
        }>(
          `select aggregate_id as "aggregateId", payload
             from channel_runtime.outbox_events
             order by aggregate_id`
        );
        expect(backfilled.rows).toHaveLength(2);
        expect(backfilled.rows.map((row) => row.aggregateId).sort()).toEqual(
          [validReceivedId, validProcessingId].sort()
        );
        for (const row of backfilled.rows) {
          expect(Object.keys(row.payload).sort()).toEqual(
            [
              "body",
              "externalMessageId",
              "externalThreadId",
              "inboundEventId",
              "phoneHash",
              "phoneMasked",
              "provider",
              "receivedAt",
              "threadBindingId"
            ].sort()
          );
          expect(typeof row.payload.receivedAt).toBe("string");
          expect(Number.isNaN(Date.parse(String(row.payload.receivedAt)))).toBe(false);
        }

        const terminalized = await verification.query<{
          id: string;
          status: string;
          errorCode: string | null;
          metadata: Record<string, unknown>;
        }>(
          `select id, status, last_error_code as "errorCode", metadata
             from channel_runtime.inbound_events
             where id = any($1::uuid[])
             order by id`,
          [[missingBindingId, invalidContractId]]
        );
        expect(terminalized.rows).toHaveLength(2);
        expect(terminalized.rows.find((row) => row.id === missingBindingId)).toMatchObject({
          status: "dead_letter",
          errorCode: "legacy_inbound_binding_missing",
          metadata: {
            outboxBackfillStatus: "dead_letter",
            outboxErrorCode: "legacy_inbound_binding_missing"
          }
        });
        expect(terminalized.rows.find((row) => row.id === invalidContractId)).toMatchObject({
          status: "dead_letter",
          errorCode: "legacy_inbound_contract_invalid",
          metadata: {
            outboxBackfillStatus: "dead_letter",
            outboxErrorCode: "legacy_inbound_contract_invalid"
          }
        });

        const terminalSource = await verification.query<{ status: string; outboxCount: number }>(
          `select event.status,
                    (select count(*)::int
                     from channel_runtime.outbox_events outbox
                     where outbox.aggregate_id = event.id) as "outboxCount"
             from channel_runtime.inbound_events event
             where event.id = $1`,
          [processedId]
        );
        expect(terminalSource.rows[0]).toEqual({ status: "processed", outboxCount: 0 });

        const stranded = await verification.query<{ count: number }>(
          `select count(*)::int as count
             from channel_runtime.inbound_events event
             where event.status in ('received', 'queued', 'processing', 'retry_scheduled')
               and not exists (
                 select 1 from channel_runtime.outbox_events outbox
                 where outbox.tenant_id = event.tenant_id
                   and outbox.event_type = 'channel.inbound.received.v1'
                   and outbox.aggregate_id = event.id
               )`
        );
        expect(stranded.rows[0]?.count).toBe(0);

        const migration023 = await readFile(path.join(sqlDir, "023-channel-inbound-outbox-backfill.sql"), "utf8");
        await verification.query(migration023);
        const afterSqlReplay = await verification.query<{ count: number }>(
          `select count(*)::int as count from channel_runtime.outbox_events`
        );
        expect(afterSqlReplay.rows[0]?.count).toBe(2);

        const migration021 = await readFile(path.join(sqlDir, "021-autonomous-event-flow.sql"), "utf8");
        const recordedChecksum = await verification.query<{ checksum: string }>(
          `select checksum from platform.schema_migrations where name = '021-autonomous-event-flow.sql'`
        );
        expect(recordedChecksum.rows[0]?.checksum).toBe(computeChecksum(migration021));
      } finally {
        await verification.end();
      }

      const replayedUpgrade = await runMigrations(databaseUrl, sqlDir);
      expect(replayedUpgrade.applied).toEqual([]);
      expect(replayedUpgrade.skipped).toContain("023-channel-inbound-outbox-backfill.sql");
    } finally {
      if (databaseCreated) {
        await admin.query(`drop database if exists "${databaseName}" with (force)`);
      }
      await admin.end();
    }
  }, 120_000);
});

async function migrateThrough020(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("create schema if not exists platform");
    await client.query(`
      create table if not exists platform.schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    const files = await listMigrationFiles(sqlDir);
    const lastIndex = files.indexOf("020-lumen-real-audio-pipeline.sql");
    if (lastIndex < 0) throw new Error("020 migration is missing");

    for (const file of files.slice(0, lastIndex + 1)) {
      const content = await readFile(path.join(sqlDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(content);
        await client.query("insert into platform.schema_migrations (name, checksum) values ($1, $2)", [
          file,
          computeChecksum(content)
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

async function insertInbound(
  client: InstanceType<typeof Client>,
  input: {
    tenantId: string;
    connectionId: string;
    bindingId: string | null;
    externalMessageId: string;
    body: string;
    status: "received" | "queued" | "processing" | "processed" | "retry_scheduled";
  }
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `insert into channel_runtime.inbound_events (
       tenant_id, connection_id, thread_binding_id, provider,
       external_message_id, body, status, occurred_at,
       attempt_count, locked_at, locked_by, processed_at
     ) values (
       $1, $2, $3, 'whatsapp_web_test', $4, $5, $6,
       '2026-07-01T12:00:00.000Z',
       case when $6 = 'processing' then 1 else 0 end,
       case when $6 = 'processing' then now() else null end,
       case when $6 = 'processing' then 'legacy-worker' else null end,
       case when $6 = 'processed' then now() else null end
     ) returning id`,
    [input.tenantId, input.connectionId, input.bindingId, input.externalMessageId, input.body, input.status]
  );
  return inserted.rows[0]!.id;
}

function withDatabase(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}
