import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { assertNovaProviderSqlUsesAllowedSchemas } from "./sql-policy.js";
import { NOVA_PROVIDER_LEDGER } from "./schema-manifest.js";

const { Client } = pg;
const MIGRATION_LOCK = "nova:cell-migrations";

export interface NovaMigrationClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface NovaMigrationResult {
  applied: string[];
  adopted: string[];
  skipped: string[];
}

const LEGACY_PROVIDER_SCHEMAS: Readonly<Record<string, readonly string[]>> = {
  "047-nova-autonomy.sql": ["nova", "voice", "liwa", "documents"],
  "048-nova-correlation-and-domain.sql": ["nova", "voice", "liwa", "documents"],
  "049-nova-ui-meta-contactos.sql": ["nova"],
  "050-nova-lead-product-line.sql": ["nova"],
  "051-liwa-accepted-pending.sql": ["liwa"],
  "052-nova-conversation-messages.sql": ["nova"]
};

export async function runNovaMigrations(databaseUrl: string, sqlDirectory: string): Promise<NovaMigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await runNovaMigrationsWithClient(client, sqlDirectory);
  } finally {
    await client.end();
  }
}

export async function runNovaMigrationsWithClient(
  client: NovaMigrationClient,
  sqlDirectory: string
): Promise<NovaMigrationResult> {
  await client.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK]);
  try {
    await client.query("create schema if not exists nova");
    await client.query(`
      create table if not exists nova.migration_ledger (
        name text primary key,
        checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz not null default now()
      )
    `);
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const existing = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from nova.migration_ledger"
    );
    const expectedManifestNames = new Set<string>(NOVA_PROVIDER_LEDGER.map(({ name }) => name));
    const expectedChecksums = new Map<string, string>(
      NOVA_PROVIDER_LEDGER.map(({ name, checksum }) => [name, checksum])
    );
    if (
      files.length !== NOVA_PROVIDER_LEDGER.length ||
      files.some((file, index) => file !== NOVA_PROVIDER_LEDGER[index]?.name) ||
      existing.rows.some(({ name }) => !expectedManifestNames.has(name))
    ) {
      throw new Error("NOVA migration inventory does not match the provider manifest");
    }
    const appliedChecksums = new Map(existing.rows.map((row) => [row.name, row.checksum]));
    const legacyApplied = await findLegacyProviderMigrations(client, files);
    const result: NovaMigrationResult = { applied: [], adopted: [], skipped: [] };

    for (const file of files) {
      const sql = await readFile(path.join(sqlDirectory, file), "utf8");
      assertNovaProviderSqlUsesAllowedSchemas(file, sql);
      const checksum = computeNovaMigrationChecksum(sql);
      if (checksum !== expectedChecksums.get(file)) {
        throw new Error(`NOVA migration ${file} does not match the provider manifest checksum`);
      }
      const previousChecksum = appliedChecksums.get(file);
      if (previousChecksum !== undefined) {
        if (previousChecksum !== checksum) throw new Error(`NOVA migration ${file} checksum mismatch`);
        result.skipped.push(file);
        continue;
      }

      if (legacyApplied.has(file)) {
        await client.query("insert into nova.migration_ledger(name, checksum) values ($1, $2)", [file, checksum]);
        result.adopted.push(file);
        result.skipped.push(file);
        continue;
      }

      await client.query("begin");
      try {
        await client.query("select set_config('lock_timeout', '10s', true)");
        await client.query("select set_config('statement_timeout', '300s', true)");
        await client.query(sql);
        await client.query("insert into nova.migration_ledger(name, checksum) values ($1, $2)", [file, checksum]);
        await client.query("commit");
        result.applied.push(file);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]);
  }
}

async function findLegacyProviderMigrations(
  client: NovaMigrationClient,
  migrationFiles: string[]
): Promise<Set<string>> {
  const namesBySchema = new Map<string, Set<string>>();
  for (const schema of ["nova", "voice", "liwa", "documents"] as const) {
    const table = `${schema}.service_migrations`;
    const existing = await client.query<{ table_name: string | null }>("select to_regclass($1) as table_name", [table]);
    if (!existing.rows[0]?.table_name) continue;
    const names = await client.query<{ name: string }>(
      `select name from ${schema}.service_migrations where name = any($1::text[])`,
      [migrationFiles]
    );
    namesBySchema.set(schema, new Set(names.rows.map((row) => row.name)));
  }

  return new Set(
    Object.entries(LEGACY_PROVIDER_SCHEMAS)
      .filter(([file, schemas]) => schemas.every((schema) => namesBySchema.get(schema)?.has(file)))
      .map(([file]) => file)
  );
}

export function computeNovaMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
}
