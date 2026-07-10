import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;

describeIntegration("WhatsApp channel durability migration", () => {
  const validSchema = `channel_durability_valid_${randomUUID().replaceAll("-", "")}`;
  const duplicateSchema = `channel_durability_duplicate_${randomUUID().replaceAll("-", "")}`;
  let client: pg.Client;
  let migration: string;

  beforeAll(async () => {
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    migration = await readFile(
      fileURLToPath(new URL("../sql/017-whatsapp-channel-durability.sql", import.meta.url)),
      "utf8"
    );
  });

  afterAll(async () => {
    await client.query(`drop schema if exists ${validSchema} cascade`);
    await client.query(`drop schema if exists ${duplicateSchema} cascade`);
    await client.end();
  });

  it("creates the exact unique source-message index for valid evidence", async () => {
    await createOutboundFixture(client, validSchema, false);

    await client.query(scopedMigration(validSchema));

    const index = await client.query<{ indexDefinition: string }>(
      `select indexdef as "indexDefinition"
       from pg_indexes
       where schemaname = $1 and indexname = 'uq_channel_runtime_outbound_source_message'`,
      [validSchema]
    );
    expect(index.rows[0]?.indexDefinition).toContain("UNIQUE INDEX");
    expect(index.rows[0]?.indexDefinition).toContain("(tenant_id, provider, message_id)");

    const receiptTable = await client.query<{ relation: string | null; bodyColumns: number }>(
      `select to_regclass($1) as relation,
              (select count(*)::int
               from information_schema.columns
               where table_schema = $2 and table_name = 'delivery_receipts' and column_name = 'body')
                as "bodyColumns"`,
      [`${validSchema}.delivery_receipts`, validSchema]
    );
    expect(receiptTable.rows[0]).toEqual({
      relation: `${validSchema}.delivery_receipts`,
      bodyColumns: 0
    });
  });

  it("rolls back on duplicates and leaves every conflicting row intact", async () => {
    await createOutboundFixture(client, duplicateSchema, true);
    await client.query("begin");
    try {
      await expect(client.query(scopedMigration(duplicateSchema))).rejects.toMatchObject({
        code: "23505"
      });
    } finally {
      await client.query("rollback");
    }

    const evidence = await client.query<{ count: number }>(
      `select count(*)::int as count from ${duplicateSchema}.outbound_messages`
    );
    expect(evidence.rows[0]?.count).toBe(2);
  });

  function scopedMigration(schema: string): string {
    return migration
      .replaceAll("channel_runtime.outbound_messages", `${schema}.outbound_messages`)
      .replaceAll("channel_runtime.delivery_receipts", `${schema}.delivery_receipts`);
  }
});

async function createOutboundFixture(client: pg.Client, schema: string, duplicate: boolean): Promise<void> {
  await client.query(`create schema ${schema}`);
  await client.query(
    `create table ${schema}.outbound_messages (
       tenant_id uuid not null,
       provider text not null,
       message_id uuid not null
     )`
  );
  const tenantId = randomUUID();
  const messageId = randomUUID();
  await client.query(
    `insert into ${schema}.outbound_messages (tenant_id, provider, message_id)
     values ($1, 'whatsapp_web_test', $2)`,
    [tenantId, messageId]
  );
  if (duplicate) {
    await client.query(
      `insert into ${schema}.outbound_messages (tenant_id, provider, message_id)
       values ($1, 'whatsapp_web_test', $2)`,
      [tenantId, messageId]
    );
  }
}
