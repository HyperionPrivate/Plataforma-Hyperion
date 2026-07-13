import { createHash, randomUUID } from "node:crypto";
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

describeIntegration("025 -> 026 Audit source provenance upgrade", () => {
  it("attributes durable rows by outbox evidence and marks uncorrelated legacy rows unknown", async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    const databaseName = `hyperion_audit_provenance_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
    let databaseCreated = false;

    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
      databaseCreated = true;
      await migrateThrough025(databaseUrl);

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      const tenantId = randomUUID();
      const payloadHash = "a".repeat(64);
      let sofiaEventId = "";
      let lumenEventId = "";
      const unknownEventId = randomUUID();
      try {
        sofiaEventId = (
          await client.query<{ id: string }>(
            `insert into agent_runtime.outbox_events (
               tenant_id, event_type, event_version, aggregate_type, aggregate_id, payload, occurred_at
             ) values ($1, 'audit.event.record.v1', 1, 'agent_job', $2, '{}'::jsonb, $3)
             returning id`,
            [tenantId, randomUUID(), "2026-07-12T10:00:00.000Z"]
          )
        ).rows[0]!.id;
        lumenEventId = (
          await client.query<{ id: string }>(
            `insert into lumen.outbox_events (
               tenant_id, event_type, event_version, aggregate_type, aggregate_id,
               dedupe_key, payload, occurred_at
             ) values ($1, 'audit.event.record.v1', 1, 'lumen_clinical_record', $2,
                       $3, '{}'::jsonb, $4)
             returning id`,
            [tenantId, randomUUID(), `provenance-upgrade:${randomUUID()}`, "2026-07-12T10:01:00.000Z"]
          )
        ).rows[0]!.id;

        for (const [eventId, occurredAt] of [
          [sofiaEventId, "2026-07-12T10:00:00.000Z"],
          [lumenEventId, "2026-07-12T10:01:00.000Z"],
          [unknownEventId, "2026-07-12T10:02:00.000Z"]
        ]) {
          await client.query(
            `insert into audit_runtime.inbox_events (
               event_id, tenant_id, event_type, event_version, payload_hash, occurred_at
             ) values ($1, $2, 'audit.event.record.v1', 1, $3, $4)`,
            [eventId, tenantId, payloadHash, occurredAt]
          );
        }
      } finally {
        await client.end();
      }

      const upgraded = await runMigrations(databaseUrl, sqlDir);
      expect(upgraded.applied).toEqual(["026-audit-source-provenance.sql"]);

      const verification = new Client({ connectionString: databaseUrl });
      await verification.connect();
      try {
        const inbox = await verification.query<{
          eventId: string;
          sourceService: string;
          eventType: string;
          contractHash: string;
        }>(
          `select event_id as "eventId", source_service as "sourceService",
                  event_type as "eventType", contract_hash as "contractHash"
             from audit_runtime.inbox_events
            where event_id = any($1::uuid[])
            order by event_id`,
          [[sofiaEventId, lumenEventId, unknownEventId]]
        );
        const byId = new Map(inbox.rows.map((row) => [row.eventId, row]));

        expect(byId.get(sofiaEventId)).toMatchObject({
          sourceService: "sofia-automation",
          eventType: "sofia.audit.event.record.v1",
          contractHash: contractHash("sofia-automation", "sofia.audit.event.record.v1", tenantId, payloadHash)
        });
        expect(byId.get(lumenEventId)).toMatchObject({
          sourceService: "lumen-service",
          eventType: "lumen.audit.event.record.v1",
          contractHash: contractHash("lumen-service", "lumen.audit.event.record.v1", tenantId, payloadHash)
        });
        expect(byId.get(unknownEventId)).toMatchObject({
          sourceService: "legacy-unknown",
          eventType: "legacy.audit.event.record.v1",
          contractHash: contractHash("legacy-unknown", "legacy.audit.event.record.v1", tenantId, payloadHash)
        });

        const outboxes = await verification.query<{ source: string; eventType: string }>(
          `select 'sofia' as source, event_type as "eventType"
             from agent_runtime.outbox_events where id = $1
           union all
           select 'lumen' as source, event_type as "eventType"
             from lumen.outbox_events where id = $2
           order by source`,
          [sofiaEventId, lumenEventId]
        );
        expect(outboxes.rows).toEqual([
          { source: "lumen", eventType: "lumen.audit.event.record.v1" },
          { source: "sofia", eventType: "sofia.audit.event.record.v1" }
        ]);

        const defaultValue = await verification.query<{ columnDefault: string | null }>(
          `select column_default as "columnDefault"
             from information_schema.columns
            where table_schema = 'audit_runtime'
              and table_name = 'inbox_events'
              and column_name = 'source_service'`
        );
        expect(defaultValue.rows[0]?.columnDefault).toBeNull();

        const triggerDefinition = await verification.query<{ definition: string }>(
          `select pg_get_functiondef('lumen.finalize_clinical_record_approval()'::regprocedure) as definition`
        );
        expect(triggerDefinition.rows[0]?.definition).toContain("lumen.audit.event.record.v1");

        await expect(
          verification.query(
            `insert into audit_runtime.inbox_events (
               event_id, tenant_id, source_service, event_type, event_version,
               payload_hash, contract_hash, occurred_at
             ) values ($1, $2, 'lumen-service', 'sofia.audit.event.record.v1', 1, $3, $3, now())`,
            [randomUUID(), tenantId, payloadHash]
          )
        ).rejects.toMatchObject({ code: "23514" });
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

async function migrateThrough025(databaseUrl: string): Promise<void> {
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
    const lastIndex = files.indexOf("025-audit-ledger-autonomy.sql");
    if (lastIndex < 0) throw new Error("025 migration is missing");

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

function contractHash(source: string, eventType: string, tenantId: string, payloadHash: string): string {
  return createHash("sha256")
    .update([source, eventType, "1", tenantId.toLowerCase(), payloadHash].join("\u001f"))
    .digest("hex");
}

function withDatabase(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}
