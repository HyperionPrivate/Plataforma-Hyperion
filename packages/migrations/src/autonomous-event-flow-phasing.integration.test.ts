import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { computeChecksum, listMigrationFiles, readNonTransactionalStatements, runMigrations } from "./runner.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;
const sqlDir = fileURLToPath(new URL("../sql", import.meta.url));
const migrationName = "021-autonomous-event-flow.sql";
const legacyChecksum = "8453d1ffd7f2e40a8ed5899d15c1609b0380d30faad12e3b57fa7e18c1e7942f";

describeIntegration("phased autonomous event-flow migration", () => {
  it("installs 021 through autocommit phases and replays without changing durable state", async () => {
    await withTestDatabase("hyperion_021_fresh", async (databaseUrl) => {
      await migrateThrough020(databaseUrl);
      await with021Scope(async (scopeDir, migration) => {
        const first = await runMigrations(databaseUrl, scopeDir);
        expect(first).toEqual({ applied: [migrationName], skipped: [] });

        const verification = new Client({ connectionString: databaseUrl });
        await verification.connect();
        try {
          const indexes = await verification.query<{
            definition: string;
            ready: boolean;
            valid: boolean;
          }>(`
            select pg_get_indexdef(index_info.indexrelid) as definition,
                   index_info.indisready as ready,
                   index_info.indisvalid as valid
              from pg_catalog.pg_index index_info
              join pg_catalog.pg_class index_class on index_class.oid = index_info.indexrelid
             where index_class.relname in (
               'ix_channel_outbox_claim',
               'ix_pulso_inbox_tenant_received',
               'ix_pulso_channel_threads_conversation',
               'ix_pulso_outbox_claim',
               'ix_agent_inbox_tenant_received',
               'ix_agent_outbox_claim',
               'ix_audit_inbox_tenant_received',
               'uq_audit_events_source_event'
             )
             order by definition
          `);
          expect(indexes.rows).toHaveLength(8);
          expect(indexes.rows.every((index) => index.ready && index.valid)).toBe(true);
          expect(indexes.rows.every((index) => index.definition.includes("USING btree"))).toBe(true);

          const ledger = await verification.query<{ checksum: string }>(
            "select checksum from platform.schema_migrations where name = $1",
            [migrationName]
          );
          expect(ledger.rows[0]?.checksum).toBe(computeChecksum(migration));
        } finally {
          await verification.end();
        }

        const replay = await runMigrations(databaseUrl, scopeDir);
        expect(replay).toEqual({ applied: [], skipped: [migrationName] });
      });
    });
  }, 120_000);

  it("recovers an invalid concurrent index left by a partially completed 021", async () => {
    await withTestDatabase("hyperion_021_partial", async (databaseUrl) => {
      await migrateThrough020(databaseUrl);
      await with021Scope(async (scopeDir, migration) => {
        const statements = readNonTransactionalStatements(migration);
        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        const duplicatedSourceEventId = randomUUID();
        try {
          for (const statement of statements) {
            if (/^create unique index concurrently uq_audit_events_source_event/i.test(statement)) {
              await client.query(
                `insert into platform.audit_events (event_type, entity_type, source_event_id)
                 values ('migration.test', 'migration', $1), ('migration.test', 'migration', $1)`,
                [duplicatedSourceEventId]
              );
              await expect(client.query(statement)).rejects.toMatchObject({ code: "23505" });
              break;
            }
            await client.query(statement);
          }

          const invalid = await client.query<{ ready: boolean; valid: boolean }>(`
            select indisready as ready, indisvalid as valid
              from pg_catalog.pg_index
             where indexrelid = 'platform.uq_audit_events_source_event'::regclass
          `);
          expect(invalid.rows[0]).toEqual({ ready: false, valid: false });
          await client.query(
            `delete from platform.audit_events
              where source_event_id = $1
                and id <> (
                  select id
                    from platform.audit_events
                   where source_event_id = $1
                   order by id::text
                   limit 1
                )`,
            [duplicatedSourceEventId]
          );
        } finally {
          await client.end();
        }

        const recovered = await runMigrations(databaseUrl, scopeDir);
        expect(recovered).toEqual({ applied: [migrationName], skipped: [] });

        const verification = new Client({ connectionString: databaseUrl });
        await verification.connect();
        try {
          const repaired = await verification.query<{ ready: boolean; valid: boolean }>(`
            select indisready as ready, indisvalid as valid
              from pg_catalog.pg_index
             where indexrelid = 'platform.uq_audit_events_source_event'::regclass
          `);
          expect(repaired.rows[0]).toEqual({ ready: true, valid: true });
        } finally {
          await verification.end();
        }
      });
    });
  }, 120_000);

  it("accepts only the exact c549 ledger digest after validating the complete legacy catalog", async () => {
    await withTestDatabase("hyperion_021_legacy", async (databaseUrl) => {
      await migrateThrough020(databaseUrl);
      await with021Scope(async (scopeDir, migration) => {
        await runMigrations(databaseUrl, scopeDir);

        const client = new Client({ connectionString: databaseUrl });
        await client.connect();
        try {
          await client.query("update platform.schema_migrations set checksum = $1 where name = $2", [
            legacyChecksum,
            migrationName
          ]);
          // Rehearsal databases can already contain 026, which intentionally
          // removes this original default while leaving the 021 contract valid.
          await client.query("alter table audit_runtime.inbox_events alter column source_service drop default");
          await client.query(
            `insert into platform.schema_migrations (name, checksum)
             values ('026-audit-source-provenance.sql', $1)`,
            ["8fd9c9105633c4dbc2ffab66588fcd878733cb585eb3e05811e7c72d581277b7"]
          );
          await client.query("drop index concurrently audit_runtime.ix_audit_inbox_tenant_received");
        } finally {
          await client.end();
        }

        await expect(runMigrations(databaseUrl, scopeDir)).rejects.toThrow("021 index contract is incomplete");

        const afterRejectedTransition = new Client({ connectionString: databaseUrl });
        await afterRejectedTransition.connect();
        try {
          const ledger = await afterRejectedTransition.query<{ checksum: string }>(
            "select checksum from platform.schema_migrations where name = $1",
            [migrationName]
          );
          expect(ledger.rows[0]?.checksum).toBe(legacyChecksum);
          await afterRejectedTransition.query(`
            create index concurrently ix_audit_inbox_tenant_received
              on audit_runtime.inbox_events(tenant_id, received_at desc)
          `);
        } finally {
          await afterRejectedTransition.end();
        }

        const transitioned = await runMigrations(databaseUrl, scopeDir);
        expect(transitioned).toEqual({ applied: [], skipped: [migrationName] });

        const arbitraryDigest = "0".repeat(64);
        const tamper = new Client({ connectionString: databaseUrl });
        await tamper.connect();
        try {
          await tamper.query("update platform.schema_migrations set checksum = $1 where name = $2", [
            arbitraryDigest,
            migrationName
          ]);
        } finally {
          await tamper.end();
        }
        await expect(runMigrations(databaseUrl, scopeDir)).rejects.toThrow(
          `Migration ${migrationName} was modified after being applied (checksum mismatch)`
        );

        const restore = new Client({ connectionString: databaseUrl });
        await restore.connect();
        try {
          await restore.query("update platform.schema_migrations set checksum = $1 where name = $2", [
            computeChecksum(migration),
            migrationName
          ]);
        } finally {
          await restore.end();
        }
      });
    });
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

async function with021Scope(operation: (scopeDir: string, migration: string) => Promise<void>): Promise<void> {
  const scopeDir = await mkdtemp(path.join(tmpdir(), "hyperion-021-"));
  const source = path.join(sqlDir, migrationName);
  try {
    await copyFile(source, path.join(scopeDir, migrationName));
    await operation(scopeDir, await readFile(source, "utf8"));
  } finally {
    await rm(scopeDir, { recursive: true, force: true });
  }
}

async function withTestDatabase(prefix: string, operation: (databaseUrl: string) => Promise<void>): Promise<void> {
  const admin = new Client({ connectionString: TEST_DATABASE_URL });
  const databaseName = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
  let databaseCreated = false;
  await admin.connect();
  try {
    await admin.query(`create database "${databaseName}"`);
    databaseCreated = true;
    await operation(databaseUrl);
  } finally {
    if (databaseCreated) {
      await admin.query(`drop database if exists "${databaseName}" with (force)`);
    }
    await admin.end();
  }
}

function withDatabase(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}
