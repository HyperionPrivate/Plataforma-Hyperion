import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  computeChecksum,
  listMigrationFiles,
  MIGRATION_ADVISORY_LOCK_KEYS,
  migrationRunsInTransaction,
  readNonTransactionalStatements,
  runMigrations
} from "./runner.js";

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
      let tenantId = "";
      let connectionId = "";
      let validBindingId = "";
      let validReceivedId = "";
      let validProcessingId = "";
      let processedId = "";
      let missingBindingId = "";
      let invalidContractId = "";
      try {
        tenantId = (
          await client.query<{ id: string }>(
            `insert into platform.tenants (slug, display_name)
               values ($1, 'Channel upgrade test') returning id`,
            [`channel-upgrade-${randomUUID()}`]
          )
        ).rows[0]!.id;
        connectionId = (
          await client.query<{ id: string }>(
            `insert into channel_runtime.connections (tenant_id, state)
               values ($1, 'ready') returning id`,
            [tenantId]
          )
        ).rows[0]!.id;
        validBindingId = (
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

      await migrateFrom021Through022(databaseUrl);

      // Simulate an N-1 writer that began before the trigger fence. Its row
      // lock makes CREATE TRIGGER wait; after this transaction commits, the
      // migration backfill must observe the row before releasing newer writers.
      const preFenceWriter = new Client({ connectionString: databaseUrl });
      await preFenceWriter.connect();
      await preFenceWriter.query("begin");
      const preFenceEventId = await insertInbound(preFenceWriter, {
        tenantId,
        connectionId,
        bindingId: validBindingId,
        externalMessageId: "n-minus-one-before-fence",
        body: "writer anterior al fence",
        status: "received"
      });

      const upgradePromise = runMigrations(databaseUrl, sqlDir);
      try {
        await waitForTriggerFence(admin, databaseName);
        await preFenceWriter.query("commit");
      } catch (error) {
        await preFenceWriter.query("rollback");
        await upgradePromise.catch(() => undefined);
        throw error;
      } finally {
        await preFenceWriter.end();
      }

      const firstUpgrade = await upgradePromise;
      expect(firstUpgrade.applied.slice(0, 9)).toEqual([
        "020-service-role-nologin-fence.sql",
        "022-channel-inbound-outbox-fence.sql",
        "023-channel-inbound-outbox-backfill.sql",
        "024-service-database-roles.sql",
        "024-service-role-membership-fence.sql",
        "025-audit-ledger-autonomy.sql",
        "026-audit-source-provenance.sql",
        "027-audit-source-provenance-contract.sql",
        "028-audit-source-provenance-index.sql"
      ]);

      const verification = new Client({ connectionString: databaseUrl });
      await verification.connect();
      try {
        const postFenceEventId = await insertInbound(verification, {
          tenantId,
          connectionId,
          bindingId: validBindingId,
          externalMessageId: "n-minus-one-after-fence",
          body: "writer anterior que reanuda con dual-write",
          status: "received"
        });

        const backfilled = await verification.query<{
          aggregateId: string;
          payload: Record<string, unknown>;
        }>(
          `select aggregate_id as "aggregateId", payload
             from channel_runtime.outbox_events
             order by aggregate_id`
        );
        expect(backfilled.rows).toHaveLength(4);
        expect(backfilled.rows.map((row) => row.aggregateId).sort()).toEqual(
          [validReceivedId, validProcessingId, preFenceEventId, postFenceEventId].sort()
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

        // Old expand migrations are immutable and ledger-guarded; they are not
        // executed manually after later contract migrations add stricter row
        // requirements. Runner replay below proves 023 remains skipped.
        const afterUpgrade = await verification.query<{ count: number }>(
          `select count(*)::int as count from channel_runtime.outbox_events`
        );
        expect(afterUpgrade.rows[0]?.count).toBe(4);

        const migration021 = await readFile(path.join(sqlDir, "021-autonomous-event-flow.sql"), "utf8");
        const recordedChecksum = await verification.query<{ checksum: string }>(
          `select checksum from platform.schema_migrations where name = '021-autonomous-event-flow.sql'`
        );
        expect(recordedChecksum.rows[0]?.checksum).toBe(computeChecksum(migration021));
      } finally {
        await verification.end();
      }

      await verifyInvalidOrderingIndexRecovery(databaseUrl);
      await verifyMigrationRunnerSessionLock(databaseUrl);

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

  it("applies the additive fence after historical 023 and repairs its post-backfill gap", async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    const databaseName = `hyperion_channel_post_023_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
    let databaseCreated = false;

    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
      databaseCreated = true;
      await migrateThrough020(databaseUrl);
      await migrateFiles(databaseUrl, [
        "021-autonomous-event-flow.sql",
        "022-lumen-autonomy.sql",
        "023-channel-inbound-outbox-backfill.sql"
      ]);

      const writer = new Client({ connectionString: databaseUrl });
      await writer.connect();
      let tenantId = "";
      let connectionId = "";
      let bindingId = "";
      let missedEventId = "";
      try {
        tenantId = (
          await writer.query<{ id: string }>(
            "insert into platform.tenants (slug, display_name) values ($1, 'Post 023 repair') returning id",
            [`post-023-${randomUUID()}`]
          )
        ).rows[0]!.id;
        connectionId = (
          await writer.query<{ id: string }>(
            "insert into channel_runtime.connections (tenant_id, state) values ($1, 'ready') returning id",
            [tenantId]
          )
        ).rows[0]!.id;
        bindingId = (
          await writer.query<{ id: string }>(
            `insert into channel_runtime.thread_bindings (
               tenant_id, connection_id, provider, external_thread_id,
               phone_e164_hash, phone_masked
             ) values ($1, $2, 'whatsapp_web_test', $3, $4, '********3000')
             returning id`,
            [tenantId, connectionId, "573001113000@s.whatsapp.net", "b".repeat(64)]
          )
        ).rows[0]!.id;
        missedEventId = await insertInbound(writer, {
          tenantId,
          connectionId,
          bindingId,
          externalMessageId: "created-after-historical-023",
          body: "fila perdida por el backfill unico",
          status: "received"
        });
        const beforeFence = await writer.query<{ count: number }>(
          "select count(*)::int as count from channel_runtime.outbox_events where aggregate_id = $1",
          [missedEventId]
        );
        expect(beforeFence.rows[0]?.count).toBe(0);
      } finally {
        await writer.end();
      }

      const upgrade = await runMigrations(databaseUrl, sqlDir);
      expect(upgrade.applied).toContain("022-channel-inbound-outbox-fence.sql");
      expect(upgrade.skipped).toContain("023-channel-inbound-outbox-backfill.sql");

      const verification = new Client({ connectionString: databaseUrl });
      await verification.connect();
      try {
        const repaired = await verification.query<{ count: number }>(
          "select count(*)::int as count from channel_runtime.outbox_events where aggregate_id = $1",
          [missedEventId]
        );
        expect(repaired.rows[0]?.count).toBe(1);

        const postFenceEventId = await insertInbound(verification, {
          tenantId,
          connectionId,
          bindingId,
          externalMessageId: "created-after-additive-fence",
          body: "dual write activo",
          status: "received"
        });
        const dualWritten = await verification.query<{ count: number }>(
          "select count(*)::int as count from channel_runtime.outbox_events where aggregate_id = $1",
          [postFenceEventId]
        );
        expect(dualWritten.rows[0]?.count).toBe(1);
      } finally {
        await verification.end();
      }
    } finally {
      if (databaseCreated) {
        await admin.query(`drop database if exists "${databaseName}" with (force)`);
      }
      await admin.end();
    }
  }, 120_000);

  it("fails closed when sequence 2 was processed before sequence 1", async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    const databaseName = `hyperion_channel_gap_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
    let databaseCreated = false;

    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
      databaseCreated = true;
      await migrateThrough020(databaseUrl);
      const files = await listMigrationFiles(sqlDir);
      const migration021 = files.indexOf("021-autonomous-event-flow.sql");
      const migration029 = files.indexOf("029-lumen-audio-cleanup-recovery.sql");
      if (migration021 < 0 || migration029 < migration021) {
        throw new Error("Channel checkpoint test migration range is incomplete");
      }
      await migrateFiles(databaseUrl, files.slice(migration021, migration029 + 1));

      const tenantId = randomUUID();
      const streamId = randomUUID();
      const eventIds = [randomUUID(), randomUUID(), randomUUID()];
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query("insert into platform.tenants (id, slug, display_name) values ($1, $2, 'Gap checkpoint')", [
          tenantId,
          `gap-${randomUUID()}`
        ]);
        await client.query(
          `insert into pulso_iris.channel_threads (
             id, tenant_id, provider, external_thread_id, phone_e164_hash, phone_masked
           ) values ($1, $2, 'whatsapp_web_test', $3, $4, '********4000')`,
          [streamId, tenantId, `${randomUUID()}@s.whatsapp.net`, "c".repeat(64)]
        );

        for (const [offset, eventId] of eventIds.entries()) {
          await client.query(
            `insert into channel_runtime.outbox_events (
               id, tenant_id, event_type, event_version, aggregate_type, aggregate_id,
               payload, occurred_at, created_at
             ) values (
               $1, $2, 'channel.inbound.received.v1', 1, 'channel_inbound_event', $3,
               jsonb_build_object('threadBindingId', $4::uuid),
               $5::timestamptz, $5::timestamptz
             )`,
            [eventId, tenantId, randomUUID(), streamId, new Date(Date.UTC(2026, 6, 13, 12, 0, offset)).toISOString()]
          );
        }

        for (const eventId of [eventIds[1]!]) {
          await client.query(
            `insert into pulso_iris.inbox_events (
               event_id, tenant_id, source_service, event_type, event_version,
               payload_hash, occurred_at, processed_at, result
             ) values (
               $1, $2, 'whatsapp-channel-service', 'channel.inbound.received.v1', 1,
               $3, now(), now(), '{}'::jsonb
             )`,
            [eventId, tenantId, "d".repeat(64)]
          );
        }
      } finally {
        await client.end();
      }

      await expect(
        migrateFiles(databaseUrl, [
          "030-channel-conversation-ordering.sql",
          "031-channel-conversation-ordering-indexes.sql",
          "034-channel-conversation-ordering-contract.sql"
        ])
      ).rejects.toThrow("processed PULSO history contains a sequence gap");

      const verification = new Client({ connectionString: databaseUrl });
      await verification.connect();
      try {
        const expansion = await verification.query<{ present: boolean }>(
          `select exists (
             select 1
               from information_schema.columns
              where table_schema = 'pulso_iris'
                and table_name = 'channel_threads'
                and column_name = 'last_inbound_sequence'
           ) as present`
        );
        expect(expansion.rows[0]?.present).toBe(false);
        const ledger = await verification.query<{ recorded: boolean }>(
          `select exists (
             select 1 from platform.schema_migrations
              where name = '030-channel-conversation-ordering.sql'
           ) as recorded`
        );
        expect(ledger.rows[0]?.recorded).toBe(false);
      } finally {
        await verification.end();
      }
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

async function migrateFrom021Through022(databaseUrl: string): Promise<void> {
  await migrateFiles(databaseUrl, ["021-autonomous-event-flow.sql", "022-lumen-autonomy.sql"]);
}

async function migrateFiles(databaseUrl: string, files: string[]): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      const content = await readFile(path.join(sqlDir, file), "utf8");
      if (!migrationRunsInTransaction(content)) {
        for (const statement of readNonTransactionalStatements(content)) {
          await client.query(statement);
        }
        await client.query("insert into platform.schema_migrations (name, checksum) values ($1, $2)", [
          file,
          computeChecksum(content)
        ]);
        continue;
      }
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

async function waitForTriggerFence(admin: InstanceType<typeof Client>, databaseName: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await admin.query<{ blocked: boolean }>(
      `select exists (
         select 1
           from pg_stat_activity
          where datname = $1
            and wait_event_type = 'Lock'
            and state = 'active'
       ) as blocked`,
      [databaseName]
    );
    if (blocked.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("migration 022 did not acquire its trigger fence");
}

async function verifyInvalidOrderingIndexRecovery(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const streamId = randomUUID();
  const firstEventId = randomUUID();
  const duplicateEventId = randomUUID();
  await client.connect();
  try {
    await client.query("drop index concurrently if exists pulso_iris.uq_pulso_channel_inbox_stream_sequence");
    await client.query(
      `insert into pulso_iris.inbox_events (
         event_id, tenant_id, source_service, event_type, event_version,
         payload_hash, occurred_at, stream_id, stream_sequence
       ) values
         ($1, $3, 'whatsapp-channel-service', 'channel.inbound.received.v2', 2,
          $5, now(), $4, 1),
         ($2, $3, 'whatsapp-channel-service', 'channel.inbound.received.v2', 2,
          $5, now(), $4, 1)`,
      [firstEventId, duplicateEventId, tenantId, streamId, "a".repeat(64)]
    );

    await expect(
      client.query(
        `create unique index concurrently uq_pulso_channel_inbox_stream_sequence
           on pulso_iris.inbox_events(tenant_id, source_service, stream_id, stream_sequence)
           where source_service = 'whatsapp-channel-service'
             and event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')
             and stream_id is not null
             and stream_sequence is not null`
      )
    ).rejects.toMatchObject({ code: "23505" });

    const invalidIndex = await client.query<{ valid: boolean }>(
      `select index_info.indisvalid as valid
         from pg_catalog.pg_index index_info
        where index_info.indexrelid =
              'pulso_iris.uq_pulso_channel_inbox_stream_sequence'::regclass`
    );
    expect(invalidIndex.rows[0]).toEqual({ valid: false });

    await client.query("delete from pulso_iris.inbox_events where event_id = $1", [duplicateEventId]);
    // Simulates a crash before the non-transactional migration ledger write.
    await client.query(
      "delete from platform.schema_migrations where name = '031-channel-conversation-ordering-indexes.sql'"
    );
  } finally {
    await client.end();
  }

  const recovered = await runMigrations(databaseUrl, sqlDir);
  expect(recovered.applied).toEqual(["031-channel-conversation-ordering-indexes.sql"]);

  const verification = new Client({ connectionString: databaseUrl });
  await verification.connect();
  try {
    const indexes = await verification.query<{ definition: string; ready: boolean; valid: boolean }>(
      `select pg_catalog.pg_get_indexdef(index_info.indexrelid) as definition,
              index_info.indisready as ready,
              index_info.indisvalid as valid
         from pg_catalog.pg_index index_info
        where index_info.indexrelid in (
          'channel_runtime.uq_channel_outbox_stream_sequence'::regclass,
          'channel_runtime.ix_channel_outbox_stream_head'::regclass,
          'pulso_iris.uq_pulso_channel_inbox_stream_sequence'::regclass
        )
        order by definition`
    );
    expect(indexes.rows).toHaveLength(3);
    expect(indexes.rows.every((index) => index.valid && index.ready)).toBe(true);
    expect(indexes.rows.every((index) => index.definition.includes("stream"))).toBe(true);

    const ledger = await verification.query<{ recorded: boolean }>(
      `select exists (
         select 1 from platform.schema_migrations
          where name = '031-channel-conversation-ordering-indexes.sql'
       ) as recorded`
    );
    expect(ledger.rows[0]?.recorded).toBe(true);
    await verification.query("delete from pulso_iris.inbox_events where event_id = $1", [firstEventId]);
  } finally {
    await verification.end();
  }
}

async function verifyMigrationRunnerSessionLock(databaseUrl: string): Promise<void> {
  const blocker = new Client({ connectionString: databaseUrl });
  let lockHeld = false;
  let runnerSettled = false;
  let blockedRun: Promise<Awaited<ReturnType<typeof runMigrations>>> | undefined;
  await blocker.connect();
  try {
    await blocker.query("select pg_advisory_lock($1::integer, $2::integer)", [...MIGRATION_ADVISORY_LOCK_KEYS]);
    lockHeld = true;
    blockedRun = runMigrations(databaseUrl, sqlDir).finally(() => {
      runnerSettled = true;
    });

    let waitingRunnerObserved = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await blocker.query<{ waiting: boolean }>(
        `select exists (
           select 1
             from pg_catalog.pg_locks
            where locktype = 'advisory'
              and classid::bigint = $1
              and objid::bigint = $2
              and not granted
         ) as waiting`,
        [...MIGRATION_ADVISORY_LOCK_KEYS]
      );
      if (waiting.rows[0]?.waiting) {
        waitingRunnerObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(waitingRunnerObserved).toBe(true);
    expect(runnerSettled).toBe(false);
    await blocker.query("select pg_advisory_unlock($1::integer, $2::integer)", [...MIGRATION_ADVISORY_LOCK_KEYS]);
    lockHeld = false;

    const result = await blockedRun;
    expect(result.applied).toEqual([]);
  } finally {
    if (lockHeld) {
      await blocker.query("select pg_advisory_unlock($1::integer, $2::integer)", [...MIGRATION_ADVISORY_LOCK_KEYS]);
    }
    await blocker.end();
    await blockedRun?.catch(() => undefined);
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
