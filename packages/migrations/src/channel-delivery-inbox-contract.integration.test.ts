import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

const sourceService = "whatsapp-channel-service";
const deliveryEventType = "channel.delivery.updated.v1";
const constraintName = "ck_pulso_channel_delivery_inbox_stream_position";
const indexName = "uq_pulso_channel_delivery_inbox_stream_sequence";

describeIntegration("durable Channel delivery inbox migration contract", () => {
  it("validates the catalog contract and rejects missing, non-positive, or duplicate delivery positions", async () => {
    const client = new Client({ connectionString: TEST_DATABASE_URL });
    const tenantId = randomUUID();
    const streamId = randomUUID();
    await client.connect();

    try {
      const columns = await client.query<{ columnName: string; udtName: string }>(
        `select column_name as "columnName", udt_name as "udtName"
           from information_schema.columns
          where table_schema = 'pulso_iris'
            and table_name = 'inbox_events'
            and column_name in ('stream_id', 'stream_sequence')
          order by column_name`
      );
      expect(columns.rows).toEqual([
        { columnName: "stream_id", udtName: "uuid" },
        { columnName: "stream_sequence", udtName: "int8" }
      ]);

      const constraint = await client.query<{ definition: string; validated: boolean }>(
        `select pg_catalog.pg_get_constraintdef(constraint_info.oid) as definition,
                constraint_info.convalidated as validated
           from pg_catalog.pg_constraint constraint_info
          where constraint_info.conrelid = 'pulso_iris.inbox_events'::regclass
            and constraint_info.conname = $1`,
        [constraintName]
      );
      expect(constraint.rows).toHaveLength(1);
      expect(constraint.rows[0]?.validated).toBe(true);
      expect(constraint.rows[0]?.definition).toContain(deliveryEventType);
      expect(constraint.rows[0]?.definition).toContain("stream_id IS NOT NULL");
      expect(constraint.rows[0]?.definition).toContain("stream_sequence > 0");

      const index = await client.query<{
        definition: string;
        ready: boolean;
        unique: boolean;
        valid: boolean;
      }>(
        `select pg_catalog.pg_get_indexdef(index_info.indexrelid) as definition,
                index_info.indisready as ready,
                index_info.indisunique as unique,
                index_info.indisvalid as valid
           from pg_catalog.pg_index index_info
           join pg_catalog.pg_class index_class on index_class.oid = index_info.indexrelid
           join pg_catalog.pg_namespace index_namespace on index_namespace.oid = index_class.relnamespace
          where index_namespace.nspname = 'pulso_iris'
            and index_class.relname = $1`,
        [indexName]
      );
      expect(index.rows).toHaveLength(1);
      expect(index.rows[0]).toMatchObject({ ready: true, unique: true, valid: true });
      expect(index.rows[0]?.definition).toContain("(tenant_id, source_service, stream_id, stream_sequence)");
      expect(index.rows[0]?.definition).toContain(deliveryEventType);

      const ledger = await client.query<{ name: string }>(
        `select name
           from platform.schema_migrations
          where name in (
            '044-pulso-channel-delivery-inbox.sql',
            '045-pulso-channel-delivery-inbox-index.sql',
            '046-pulso-channel-delivery-inbox-contract.sql'
          )
          order by name`
      );
      expect(ledger.rows.map((row) => row.name)).toEqual([
        "044-pulso-channel-delivery-inbox.sql",
        "045-pulso-channel-delivery-inbox-index.sql",
        "046-pulso-channel-delivery-inbox-contract.sql"
      ]);

      await expect(
        insertInbox(client, {
          eventId: randomUUID(),
          tenantId,
          eventType: deliveryEventType,
          streamId: null,
          streamSequence: null
        })
      ).rejects.toMatchObject({ code: "23514", constraint: constraintName });

      await expect(
        insertInbox(client, {
          eventId: randomUUID(),
          tenantId,
          eventType: deliveryEventType,
          streamId,
          streamSequence: 0
        })
      ).rejects.toMatchObject({ code: "23514", constraint: constraintName });

      await insertInbox(client, {
        eventId: randomUUID(),
        tenantId,
        eventType: deliveryEventType,
        streamId,
        streamSequence: 1
      });
      await expect(
        insertInbox(client, {
          eventId: randomUUID(),
          tenantId,
          eventType: deliveryEventType,
          streamId,
          streamSequence: 1
        })
      ).rejects.toMatchObject({ code: "23505", constraint: indexName });

      // The index is deliberately partial: another event contract may reuse
      // the same stream position without being mistaken for a delivery replay.
      await insertInbox(client, {
        eventId: randomUUID(),
        tenantId,
        eventType: "migration.delivery.control.v1",
        streamId,
        streamSequence: 1
      });
    } finally {
      await client.query("delete from pulso_iris.inbox_events where tenant_id = $1", [tenantId]);
      await client.end();
    }
  });
});

async function insertInbox(
  client: InstanceType<typeof Client>,
  input: {
    eventId: string;
    tenantId: string;
    eventType: string;
    streamId: string | null;
    streamSequence: number | null;
  }
): Promise<void> {
  await client.query(
    `insert into pulso_iris.inbox_events (
       event_id, tenant_id, source_service, event_type, event_version,
       payload_hash, occurred_at, stream_id, stream_sequence
     ) values ($1::uuid, $2::uuid, $3, $4, 1, $5, now(), $6::uuid, $7::bigint)`,
    [
      input.eventId,
      input.tenantId,
      sourceService,
      input.eventType,
      "a".repeat(64),
      input.streamId,
      input.streamSequence
    ]
  );
}
