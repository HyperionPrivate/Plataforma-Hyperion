import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const MIGRATION_LOCK = "platform:access-migrations";

export interface PlatformMigrationClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PlatformMigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runPlatformMigrations(
  databaseUrl: string,
  sqlDirectory: string
): Promise<PlatformMigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await runPlatformMigrationsWithClient(client, sqlDirectory);
  } finally {
    await client.end();
  }
}

export async function runPlatformMigrationsWithClient(
  client: PlatformMigrationClient,
  sqlDirectory: string
): Promise<PlatformMigrationResult> {
  await client.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK]);
  try {
    await client.query("create schema if not exists access_runtime");
    await client.query(`
      create table if not exists access_runtime.migration_ledger (
        name text primary key,
        checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz not null default now()
      )
    `);
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const existing = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from access_runtime.migration_ledger"
    );
    const appliedChecksums = new Map(existing.rows.map((row) => [row.name, row.checksum]));
    const result: PlatformMigrationResult = { applied: [], skipped: [] };

    for (const file of files) {
      const sql = await readFile(path.join(sqlDirectory, file), "utf8");
      const checksum = computePlatformMigrationChecksum(sql);
      const previous = appliedChecksums.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`Platform migration ${file} checksum mismatch`);
        result.skipped.push(file);
        continue;
      }

      await client.query("begin");
      try {
        await client.query("select set_config('lock_timeout', '10s', true)");
        await client.query("select set_config('statement_timeout', '300s', true)");
        await client.query(sql);
        await client.query("insert into access_runtime.migration_ledger(name, checksum) values ($1, $2)", [
          file,
          checksum
        ]);
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

export function computePlatformMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
}
