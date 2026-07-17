import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { listMigrationFiles, runMigrations } from "./runner.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;
const sqlDir = fileURLToPath(new URL("../sql", import.meta.url));

describeIntegration("phased PULSO -> SOFIA ordering upgrade", () => {
  it("rejects a published PULSO successor, then resumes 036 after the history is reconciled", async () => {
    await withUpgradeDatabase("hyperion_pulso_ordering", async ({ databaseUrl, addThrough }) => {
      await runMigrations(databaseUrl, await addThrough("034-channel-conversation-ordering-contract.sql"));

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const [firstOutboxId, secondOutboxId] = await (async () => {
        try {
          const tenantId = await insertTenant(client, "pulso-gap");
          const stream = await insertLegacyPulsoStream(client, tenantId, ["queued", "published"]);
          return [stream.outboxIds[0]!, stream.outboxIds[1]!] as const;
        } finally {
          await client.end();
        }
      })();

      await runMigrations(databaseUrl, await addThrough("035-pulso-sofia-conversation-ordering.sql"));
      const phaseScope = await addThrough("037-pulso-sofia-conversation-ordering-indexes.sql");
      await expect(runMigrations(databaseUrl, phaseScope)).rejects.toThrow(
        "published history is not a contiguous prefix"
      );

      const partial = new Client({ connectionString: databaseUrl });
      await partial.connect();
      try {
        const state = await partial.query<{
          id: string;
          streamSequence: string;
          sourceSequence: string;
        }>(
          `select id, stream_sequence as "streamSequence",
                  source_stream_sequence as "sourceSequence"
             from pulso_iris.outbox_events
            where id = any($1::uuid[])
            order by stream_sequence`,
          [[firstOutboxId, secondOutboxId]]
        );
        expect(state.rows.map((row) => [row.id, Number(row.streamSequence), Number(row.sourceSequence)])).toEqual([
          [firstOutboxId, 1, 1],
          [secondOutboxId, 2, 2]
        ]);

        await partial.query(
          `update pulso_iris.outbox_events
              set status = 'published', published_at = now(), updated_at = now()
            where id = $1`,
          [firstOutboxId]
        );
      } finally {
        await partial.end();
      }

      const resumed = await runMigrations(databaseUrl, phaseScope);
      expect(resumed.applied).toEqual([
        "036-pulso-sofia-conversation-ordering-backfill.sql",
        "037-pulso-sofia-conversation-ordering-indexes.sql"
      ]);
      const replayed = await runMigrations(databaseUrl, phaseScope);
      expect(replayed.applied).toEqual([]);
      expect(replayed.skipped.slice(-3)).toEqual([
        "035-pulso-sofia-conversation-ordering.sql",
        "036-pulso-sofia-conversation-ordering-backfill.sql",
        "037-pulso-sofia-conversation-ordering-indexes.sql"
      ]);
    });
  }, 180_000);

  it("rejects SOFIA processed sequence 2 without sequence 1 and resumes from the partial backfill", async () => {
    await withUpgradeDatabase("hyperion_sofia_inbox_gap", async ({ databaseUrl, addThrough }) => {
      await runMigrations(databaseUrl, await addThrough("034-channel-conversation-ordering-contract.sql"));

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const [tenantId, firstOutboxId] = await (async () => {
        try {
          const insertedTenantId = await insertTenant(client, "sofia-inbox-gap");
          const stream = await insertLegacyPulsoStream(client, insertedTenantId, ["queued", "queued"]);
          const insertedFirstOutboxId = stream.outboxIds[0]!;
          await insertLegacySofiaInbox(client, {
            eventId: stream.outboxIds[1]!,
            tenantId: insertedTenantId,
            processed: true
          });
          return [insertedTenantId, insertedFirstOutboxId] as const;
        } finally {
          await client.end();
        }
      })();

      await runMigrations(databaseUrl, await addThrough("035-pulso-sofia-conversation-ordering.sql"));
      const phaseScope = await addThrough("037-pulso-sofia-conversation-ordering-indexes.sql");
      await expect(runMigrations(databaseUrl, phaseScope)).rejects.toThrow(
        "processed inbox history is not a contiguous prefix"
      );

      const repair = new Client({ connectionString: databaseUrl });
      await repair.connect();
      try {
        const position = await repair.query<{
          streamId: string;
          streamSequence: string;
          sourceStreamId: string;
          sourceStreamSequence: string;
        }>(
          `select stream_id as "streamId", stream_sequence as "streamSequence",
                  source_stream_id as "sourceStreamId",
                  source_stream_sequence as "sourceStreamSequence"
             from pulso_iris.outbox_event_positions
            where tenant_id = $1 and event_id = $2`,
          [tenantId, firstOutboxId]
        );
        const first = position.rows[0]!;
        await insertLegacySofiaInbox(repair, {
          eventId: firstOutboxId,
          tenantId,
          processed: true,
          position: {
            streamId: first.streamId,
            streamSequence: Number(first.streamSequence),
            sourceStreamId: first.sourceStreamId,
            sourceStreamSequence: Number(first.sourceStreamSequence)
          }
        });
      } finally {
        await repair.end();
      }

      await expect(runMigrations(databaseUrl, phaseScope)).resolves.toMatchObject({
        applied: [
          "036-pulso-sofia-conversation-ordering-backfill.sql",
          "037-pulso-sofia-conversation-ordering-indexes.sql"
        ]
      });

      const verification = new Client({ connectionString: databaseUrl });
      await verification.connect();
      try {
        const checkpoint = await verification.query<{ lastSequence: string }>(
          `select last_sequence as "lastSequence"
             from agent_runtime.pulso_stream_positions
            where tenant_id = $1`,
          [tenantId]
        );
        expect(Number(checkpoint.rows[0]?.lastSequence)).toBe(2);
      } finally {
        await verification.end();
      }
    });
  }, 180_000);

  it("rejects a completed SOFIA successor above an unfinished predecessor", async () => {
    await withUpgradeDatabase("hyperion_sofia_job_gap", async ({ databaseUrl, addThrough }) => {
      await runMigrations(databaseUrl, await addThrough("034-channel-conversation-ordering-contract.sql"));

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const firstJobId = await (async () => {
        try {
          const tenantId = await insertTenant(client, "sofia-job-gap");
          const conversationId = randomUUID();
          const insertedFirstJobId = await insertLegacyJob(client, {
            tenantId,
            conversationId,
            status: "queued",
            createdAt: "2026-07-13T13:00:00.000Z"
          });
          await insertLegacyJob(client, {
            tenantId,
            conversationId,
            status: "completed",
            createdAt: "2026-07-13T13:00:01.000Z"
          });
          return insertedFirstJobId;
        } finally {
          await client.end();
        }
      })();

      await runMigrations(databaseUrl, await addThrough("035-pulso-sofia-conversation-ordering.sql"));
      const phaseScope = await addThrough("037-pulso-sofia-conversation-ordering-indexes.sql");
      await expect(runMigrations(databaseUrl, phaseScope)).rejects.toThrow(
        "completed history is not a contiguous prefix"
      );

      const repair = new Client({ connectionString: databaseUrl });
      await repair.connect();
      try {
        await repair.query(
          `update agent_runtime.jobs
              set status = 'completed', completed_at = now(), updated_at = now()
            where id = $1`,
          [firstJobId]
        );
      } finally {
        await repair.end();
      }

      await expect(runMigrations(databaseUrl, phaseScope)).resolves.toMatchObject({
        applied: [
          "036-pulso-sofia-conversation-ordering-backfill.sql",
          "037-pulso-sofia-conversation-ordering-indexes.sql"
        ]
      });
    });
  }, 180_000);

  it("rejects an ambiguous local PULSO inbox correlation instead of choosing a source position", async () => {
    await withUpgradeDatabase("hyperion_pulso_ambiguous", async ({ databaseUrl, addThrough }) => {
      await runMigrations(databaseUrl, await addThrough("034-channel-conversation-ordering-contract.sql"));

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const tenantId = await insertTenant(client, "pulso-ambiguous");
        const stream = await insertLegacyPulsoStream(client, tenantId, ["queued"]);
        await client.query(
          `insert into pulso_iris.inbox_events (
             event_id, tenant_id, source_service, event_type, event_version,
             payload_hash, occurred_at, processed_at, result, stream_id, stream_sequence
           ) values (
             $1, $2, 'whatsapp-channel-service', 'channel.inbound.received.v1', 1,
             $3, '2026-07-13T12:00:01.000Z', '2026-07-13T12:00:01.000Z',
             $4::jsonb, $5, 2
           )`,
          [
            randomUUID(),
            tenantId,
            "b".repeat(64),
            JSON.stringify({ messageId: stream.messageIds[0], conversationId: stream.conversationId }),
            stream.threadBindingId
          ]
        );
      } finally {
        await client.end();
      }

      await runMigrations(databaseUrl, await addThrough("035-pulso-sofia-conversation-ordering.sql"));
      await expect(
        runMigrations(databaseUrl, await addThrough("036-pulso-sofia-conversation-ordering-backfill.sql"))
      ).rejects.toThrow("no local owner-resolved source position");
    });
  }, 180_000);

  it("keeps the exact N-1 Channel, PULSO and SOFIA durable writers compatible with owner-ledger positions", async () => {
    await withUpgradeDatabase("hyperion_n1_durable", async ({ databaseUrl, addThrough }) => {
      await runMigrations(databaseUrl, await addThrough("038-n-minus-one-durable-event-compatibility.sql"));

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const tenantId = await insertTenant(client, "n1-durable");
        const connectionId = (
          await client.query<{ id: string }>(
            `insert into channel_runtime.connections (tenant_id, state)
             values ($1, 'ready') returning id`,
            [tenantId]
          )
        ).rows[0]!.id;
        const threadBindingId = randomUUID();
        const externalThreadId = `n1-${randomUUID()}@s.whatsapp.net`;
        await client.query(
          `insert into channel_runtime.thread_bindings (
             id, tenant_id, connection_id, provider, external_thread_id,
             phone_e164_hash, phone_masked
           ) values ($1, $2, $3, 'whatsapp_web_test', $4, $5, '********0499')`,
          [threadBindingId, tenantId, connectionId, externalThreadId, "d".repeat(64)]
        );
        await client.query("set role hyperion_channel");
        const inboundEventId = (
          await client.query<{ id: string }>(
            `insert into channel_runtime.inbound_events (
               tenant_id, connection_id, thread_binding_id, provider,
               external_message_id, body, status, occurred_at
             ) values (
               $1, $2, $3, 'whatsapp_web_test', $4,
               'Consulta administrativa sintética N-1', 'received', $5
             ) returning id`,
            [tenantId, connectionId, threadBindingId, `n1-${randomUUID()}`, "2026-07-13T16:00:00.000Z"]
          )
        ).rows[0]!.id;
        const collidingInboundEventId = (
          await client.query<{ id: string }>(
            `insert into channel_runtime.inbound_events (
               tenant_id, connection_id, thread_binding_id, provider,
               external_message_id, body, status, occurred_at
             ) values (
               $1, $2, $3, 'whatsapp_web_test', $4,
               'Segunda consulta con el mismo timestamp', 'received', $5
             ) returning id`,
            [tenantId, connectionId, threadBindingId, `n1-${randomUUID()}`, "2026-07-13T16:00:00.000Z"]
          )
        ).rows[0]!.id;
        await client.query("reset role");
        const channelEvent = (
          await client.query<{ id: string; streamId: string; streamSequence: string }>(
            `select id, stream_id as "streamId", stream_sequence as "streamSequence"
               from channel_runtime.outbox_events
              where tenant_id = $1 and aggregate_id = $2`,
            [tenantId, inboundEventId]
          )
        ).rows[0]!;
        expect(channelEvent).toMatchObject({ streamId: threadBindingId, streamSequence: "1" });
        const collidingChannelEvent = (
          await client.query<{ id: string; streamId: string; streamSequence: string }>(
            `select id, stream_id as "streamId", stream_sequence as "streamSequence"
               from channel_runtime.outbox_events
              where tenant_id = $1 and aggregate_id = $2`,
            [tenantId, collidingInboundEventId]
          )
        ).rows[0]!;
        expect(collidingChannelEvent).toMatchObject({ streamId: threadBindingId, streamSequence: "2" });

        await client.query("set role hyperion_pulso");
        await client.query(
          `insert into pulso_iris.inbox_events (
             event_id, tenant_id, source_service, event_type, event_version,
             payload_hash, occurred_at
           ) values (
             $1, $2, 'whatsapp-channel-service', 'channel.inbound.received.v1', 1,
             $3, $4
           )`,
          [channelEvent.id, tenantId, "a".repeat(64), "2026-07-13T16:00:00.000Z"]
        );
        await client.query(
          `insert into pulso_iris.inbox_events (
             event_id, tenant_id, source_service, event_type, event_version,
             payload_hash, occurred_at
           ) values (
             $1, $2, 'whatsapp-channel-service', 'channel.inbound.received.v1', 1,
             $3, $4
           )`,
          [collidingChannelEvent.id, tenantId, "c".repeat(64), "2026-07-13T16:00:00.000Z"]
        );
        const pulsoChannelInbox = (
          await client.query<{ streamId: string; streamSequence: string }>(
            `select stream_id as "streamId", stream_sequence as "streamSequence"
               from pulso_iris.inbox_events where event_id = $1`,
            [channelEvent.id]
          )
        ).rows[0]!;
        expect(pulsoChannelInbox).toEqual({ streamId: threadBindingId, streamSequence: "1" });

        await client.query(
          `insert into pulso_iris.channel_threads (
             id, tenant_id, provider, external_thread_id,
             phone_e164_hash, phone_masked, last_inbound_at
           ) values ($1, $2, 'whatsapp_web_test', $3, $4, '********0499', $5)`,
          [threadBindingId, tenantId, externalThreadId, "d".repeat(64), "2026-07-13T16:00:00.000Z"]
        );
        const conversationId = randomUUID();
        const messageId = randomUUID();
        const pulsoEventId = (
          await client.query<{ id: string }>(
            `insert into pulso_iris.outbox_events (
               tenant_id, event_type, event_version, aggregate_type, aggregate_id,
               payload, status, occurred_at
             ) values (
               $1, 'pulso.message.received.v1', 1, 'message', $2, $3::jsonb,
               'queued', $4
             ) returning id`,
            [
              tenantId,
              messageId,
              JSON.stringify({
                inboundEventId,
                threadBindingId,
                patientId: randomUUID(),
                conversationId,
                messageId,
                occurredAt: "2026-07-13T16:00:00.000Z"
              }),
              "2026-07-13T16:00:00.000Z"
            ]
          )
        ).rows[0]!.id;
        const pulsoPosition = (
          await client.query<{
            streamId: string;
            streamSequence: string;
            sourceStreamId: string;
            sourceStreamSequence: string;
          }>(
            `select stream_id as "streamId", stream_sequence as "streamSequence",
                    source_stream_id as "sourceStreamId",
                    source_stream_sequence as "sourceStreamSequence"
               from pulso_iris.outbox_event_positions
              where tenant_id = $1 and event_id = $2`,
            [tenantId, pulsoEventId]
          )
        ).rows[0]!;
        expect(pulsoPosition).toEqual({
          streamId: conversationId,
          streamSequence: "1",
          sourceStreamId: threadBindingId,
          sourceStreamSequence: "1"
        });
        await client.query("reset role");

        await client.query("set role hyperion_sofia");
        await client.query(
          `insert into agent_runtime.inbox_events (
             event_id, tenant_id, source_service, event_type, event_version,
             payload_hash, occurred_at
           ) values (
             $1, $2, 'pulso-core', 'pulso.message.received.v1', 1, $3, $4
           )`,
          [pulsoEventId, tenantId, "b".repeat(64), "2026-07-13T16:00:00.000Z"]
        );
        const agentInboxPosition = (
          await client.query<{
            streamId: string;
            streamSequence: string;
            sourceStreamId: string;
            sourceStreamSequence: string;
          }>(
            `select stream_id as "streamId", stream_sequence as "streamSequence",
                    source_stream_id as "sourceStreamId",
                    source_stream_sequence as "sourceStreamSequence"
               from agent_runtime.inbox_events where event_id = $1`,
            [pulsoEventId]
          )
        ).rows[0]!;
        expect(agentInboxPosition).toEqual(pulsoPosition);

        const job = (
          await client.query<{ streamId: string; streamSequence: string; orderingSource: string }>(
            `insert into agent_runtime.jobs (
               tenant_id, conversation_id, inbound_event_id, idempotency_key, status, input
             ) values ($1, $2, $3, $4, 'queued', '{}'::jsonb)
             returning stream_id as "streamId", stream_sequence as "streamSequence",
                       ordering_source as "orderingSource"`,
            [tenantId, conversationId, inboundEventId, `n1-durable-${randomUUID()}`]
          )
        ).rows[0]!;
        expect(job).toEqual({
          streamId: conversationId,
          streamSequence: "1",
          orderingSource: "legacy_polling_allocator"
        });
        await client.query("reset role");

        await client.query("set role hyperion_pulso");
        await expect(
          client.query(
            `insert into pulso_iris.inbox_events (
               event_id, tenant_id, source_service, event_type, event_version,
               payload_hash, occurred_at, stream_id, stream_sequence
             ) values (
               $1, $2, 'whatsapp-channel-service', 'channel.inbound.received.v1', 1,
               $3, $4, $5, 999
             )`,
            [channelEvent.id, tenantId, "d".repeat(64), "2026-07-13T16:00:00.000Z", threadBindingId]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          client.query(
            `insert into pulso_iris.outbox_events (
               tenant_id, event_type, event_version, aggregate_type, aggregate_id,
               source_stream_id, source_stream_sequence, payload, occurred_at
             ) values (
               $1, 'pulso.message.received.v1', 1, 'message', $2,
               $3, 999, $4::jsonb, $5
             )`,
            [
              tenantId,
              messageId,
              threadBindingId,
              JSON.stringify({
                inboundEventId,
                threadBindingId,
                patientId: randomUUID(),
                conversationId,
                messageId,
                occurredAt: "2026-07-13T16:00:00.000Z"
              }),
              "2026-07-13T16:00:00.000Z"
            ]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          client.query(
            `insert into pulso_iris.inbox_events (
               event_id, tenant_id, source_service, event_type, event_version,
               payload_hash, occurred_at, stream_id, stream_sequence
             ) values (
               $1, $2, 'whatsapp-channel-service', 'channel.inbound.received.v1', 1,
               $3, now(), $4, 999
             )`,
            [randomUUID(), tenantId, "d".repeat(64), threadBindingId]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          client.query(
            `insert into pulso_iris.outbox_events (
               tenant_id, event_type, event_version, aggregate_type, aggregate_id,
               source_stream_id, source_stream_sequence, payload, occurred_at
             ) values (
               $1, 'pulso.message.received.v1', 1, 'message', $2,
               $3, 999, $4::jsonb, $5
             )`,
            [
              tenantId,
              randomUUID(),
              threadBindingId,
              JSON.stringify({
                inboundEventId: randomUUID(),
                threadBindingId,
                patientId: randomUUID(),
                conversationId,
                messageId: randomUUID(),
                occurredAt: "2026-07-13T16:00:00.000Z"
              }),
              "2026-07-13T16:00:00.000Z"
            ]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("reset role");

        await client.query("set role hyperion_sofia");
        await expect(
          client.query(
            `insert into agent_runtime.inbox_events (
               event_id, tenant_id, source_service, event_type, event_version,
               payload_hash, occurred_at, stream_id, stream_sequence,
               source_stream_id, source_stream_sequence
             ) values (
               $1, $2, 'pulso-core', 'pulso.message.received.v1', 1,
               $3, $4, $5, 999, $6, 999
             )`,
            [pulsoEventId, tenantId, "e".repeat(64), "2026-07-13T16:00:00.000Z", conversationId, threadBindingId]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await expect(
          client.query(
            `insert into agent_runtime.inbox_events (
               event_id, tenant_id, source_service, event_type, event_version,
               payload_hash, occurred_at, stream_id, stream_sequence,
               source_stream_id, source_stream_sequence
             ) values (
               $1, $2, 'pulso-core', 'pulso.message.received.v1', 1,
               $3, now(), $4, 999, $5, 999
             )`,
            [randomUUID(), tenantId, "e".repeat(64), conversationId, threadBindingId]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("reset role");

        await client.query(
          `update channel_runtime.outbox_events
              set event_type = 'channel.inbound.received.v2', event_version = 2
            where id = $1`,
          [collidingChannelEvent.id]
        );
        await client.query("set role hyperion_pulso");
        await expect(
          client.query(
            `insert into pulso_iris.inbox_events (
               event_id, tenant_id, source_service, event_type, event_version,
               payload_hash, occurred_at
             ) values (
               $1, $2, 'whatsapp-channel-service', 'channel.inbound.received.v1', 1,
               $3, $4
             )`,
            [collidingChannelEvent.id, tenantId, "f".repeat(64), "2026-07-13T16:00:00.000Z"]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("reset role");

        await client.query(
          `update pulso_iris.outbox_events
              set event_type = 'pulso.message.received.v2', event_version = 2
            where id = $1`,
          [pulsoEventId]
        );
        await client.query("set role hyperion_sofia");
        await expect(
          client.query(
            `insert into agent_runtime.inbox_events (
               event_id, tenant_id, source_service, event_type, event_version,
               payload_hash, occurred_at
             ) values (
               $1, $2, 'pulso-core', 'pulso.message.received.v1', 1,
               $3, $4
             )`,
            [pulsoEventId, tenantId, "f".repeat(64), "2026-07-13T16:00:00.000Z"]
          )
        ).rejects.toMatchObject({ code: "23514" });
        await client.query("reset role");

        await expect(
          client.query(
            `insert into pulso_iris.outbox_events (
               tenant_id, event_type, event_version, aggregate_type, aggregate_id,
               stream_id, stream_sequence, source_stream_id, source_stream_sequence,
               payload, occurred_at
             ) values (
               $1, 'pulso.message.received.v2', 1, 'message', $2,
               $3, 2, $4, 2, $5::jsonb, now()
             )`,
            [
              tenantId,
              randomUUID(),
              conversationId,
              threadBindingId,
              JSON.stringify({
                inboundEventId: randomUUID(),
                threadBindingId,
                patientId: randomUUID(),
                conversationId,
                messageId: randomUUID(),
                occurredAt: new Date().toISOString(),
                sourceStreamId: threadBindingId,
                sourceStreamSequence: 2
              })
            ]
          )
        ).rejects.toMatchObject({ code: "23514", constraint: "ck_pulso_message_outbox_contract_version" });
      } finally {
        await client.end();
      }
    });
  }, 180_000);
});

interface UpgradeContext {
  databaseUrl: string;
  addThrough(name: string): Promise<string>;
}

async function withUpgradeDatabase(prefix: string, operation: (context: UpgradeContext) => Promise<void>) {
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  const databaseName = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
  const scopeDir = await mkdtemp(path.join(tmpdir(), `${prefix}-`));
  const copied = new Set<string>();
  let databaseCreated = false;
  await admin.connect();
  try {
    await admin.query(`create database "${databaseName}"`);
    databaseCreated = true;
    const migrationFiles = await listMigrationFiles(sqlDir);
    await operation({
      databaseUrl,
      async addThrough(name) {
        const lastIndex = migrationFiles.indexOf(name);
        if (lastIndex < 0) throw new Error(`Migration ${name} is missing`);
        for (const file of migrationFiles.slice(0, lastIndex + 1)) {
          if (copied.has(file)) continue;
          await copyFile(path.join(sqlDir, file), path.join(scopeDir, file));
          copied.add(file);
        }
        return scopeDir;
      }
    });
  } finally {
    if (databaseCreated) await admin.query(`drop database if exists "${databaseName}" with (force)`);
    await admin.end();
    await rm(scopeDir, { recursive: true, force: true });
  }
}

async function insertTenant(client: InstanceType<typeof Client>, label: string): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into platform.tenants (slug, display_name)
     values ($1, 'Ordering upgrade test') returning id`,
    [`${label}-${randomUUID()}`]
  );
  return result.rows[0]!.id;
}

async function insertLegacyPulsoStream(
  client: InstanceType<typeof Client>,
  tenantId: string,
  statuses: Array<"queued" | "published">
): Promise<{
  outboxIds: string[];
  messageIds: string[];
  conversationId: string;
  threadBindingId: string;
}> {
  const conversationId = randomUUID();
  const threadBindingId = randomUUID();
  const outboxIds: string[] = [];
  const messageIds: string[] = [];
  for (const [index, status] of statuses.entries()) {
    const sourceEnvelopeId = randomUUID();
    const inboundEventId = randomUUID();
    const messageId = randomUUID();
    const occurredAt = `2026-07-13T12:00:0${index}.000Z`;
    await client.query(
      `insert into pulso_iris.inbox_events (
         event_id, tenant_id, source_service, event_type, event_version,
         payload_hash, occurred_at, processed_at, result, stream_id, stream_sequence
       ) values (
         $1, $2, 'whatsapp-channel-service', 'channel.inbound.received.v1', 1,
         $3, $4, $4, $5::jsonb, $6, $7
       )`,
      [
        sourceEnvelopeId,
        tenantId,
        `${index + 1}`.repeat(64).slice(0, 64),
        occurredAt,
        JSON.stringify({ messageId, conversationId }),
        threadBindingId,
        index + 1
      ]
    );
    const outbox = await client.query<{ id: string }>(
      `insert into pulso_iris.outbox_events (
         tenant_id, event_type, event_version, aggregate_type, aggregate_id,
         payload, status, occurred_at, published_at, created_at
       ) values (
         $1, 'pulso.message.received.v1', 1, 'message', $2, $3::jsonb,
         $4, $5::timestamptz, case when $4 = 'published' then $5::timestamptz end,
         $5::timestamptz
       ) returning id`,
      [
        tenantId,
        messageId,
        JSON.stringify({
          inboundEventId,
          threadBindingId,
          patientId: randomUUID(),
          conversationId,
          messageId,
          occurredAt
        }),
        status,
        occurredAt
      ]
    );
    outboxIds.push(outbox.rows[0]!.id);
    messageIds.push(messageId);
  }
  return { outboxIds, messageIds, conversationId, threadBindingId };
}

async function insertLegacySofiaInbox(
  client: InstanceType<typeof Client>,
  options: {
    eventId: string;
    tenantId: string;
    processed: boolean;
    position?: {
      streamId: string;
      streamSequence: number;
      sourceStreamId: string;
      sourceStreamSequence: number;
    };
  }
): Promise<void> {
  if (!options.position) {
    await client.query(
      `insert into agent_runtime.inbox_events (
         event_id, tenant_id, source_service, event_type, event_version,
         payload_hash, occurred_at, processed_at, result
       ) values (
         $1, $2, 'pulso-iris-service', 'pulso.message.received.v1', 1,
         $3, '2026-07-13T12:00:00.000Z',
         case when $4 then '2026-07-13T12:00:00.000Z'::timestamptz end, '{}'::jsonb
       )`,
      [options.eventId, options.tenantId, "a".repeat(64), options.processed]
    );
    return;
  }

  await client.query(
    `insert into agent_runtime.inbox_events (
       event_id, tenant_id, source_service, event_type, event_version,
       payload_hash, occurred_at, processed_at, result,
       stream_id, stream_sequence, source_stream_id, source_stream_sequence
     ) values (
       $1, $2, 'pulso-iris-service', 'pulso.message.received.v1', 1,
       $3, '2026-07-13T12:00:00.000Z',
       case when $4 then '2026-07-13T12:00:00.000Z'::timestamptz end, '{}'::jsonb,
       $5, $6, $7, $8
     )`,
    [
      options.eventId,
      options.tenantId,
      "a".repeat(64),
      options.processed,
      options.position.streamId,
      options.position.streamSequence,
      options.position.sourceStreamId,
      options.position.sourceStreamSequence
    ]
  );
}

async function insertLegacyJob(
  client: InstanceType<typeof Client>,
  options: {
    tenantId: string;
    conversationId: string;
    status: "queued" | "completed";
    createdAt: string;
  }
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `insert into agent_runtime.jobs (
       tenant_id, conversation_id, inbound_event_id, idempotency_key,
       status, input, completed_at, created_at, updated_at
     ) values (
       $1, $2, $3, $4, $5, '{}'::jsonb,
       case when $5 = 'completed' then $6::timestamptz end,
       $6::timestamptz, $6::timestamptz
     ) returning id`,
    [
      options.tenantId,
      options.conversationId,
      randomUUID(),
      `legacy-${randomUUID()}`,
      options.status,
      options.createdAt
    ]
  );
  return result.rows[0]!.id;
}

function withDatabase(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}
