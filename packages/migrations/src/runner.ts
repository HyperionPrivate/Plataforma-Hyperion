import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@hyperion/logger";
import pg from "pg";

const { Client } = pg;

const logger = createLogger("migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Checksum over LF-normalized content so Windows and Linux checkouts agree. */
export function computeChecksum(content: string): string {
  return createHash("sha256").update(content.replaceAll("\r\n", "\n")).digest("hex");
}

export async function listMigrationFiles(sqlDir: string): Promise<string[]> {
  const entries = await readdir(sqlDir);
  return entries.filter((entry) => entry.endsWith(".sql")).sort();
}

export async function runMigrations(databaseUrl: string, sqlDir: string): Promise<MigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

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
    const existing = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from platform.schema_migrations"
    );
    const alreadyApplied = new Map(existing.rows.map((row) => [row.name, row.checksum]));

    for (const file of files) {
      const content = await readFile(path.join(sqlDir, file), "utf8");
      const checksum = computeChecksum(content);
      const appliedChecksum = alreadyApplied.get(file);

      if (appliedChecksum !== undefined) {
        if (appliedChecksum !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        }
        skipped.push(file);
        continue;
      }

      await client.query("begin");
      try {
        await client.query(content);
        await client.query("insert into platform.schema_migrations (name, checksum) values ($1, $2)", [file, checksum]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }

      applied.push(file);
      logger.info("migration applied", { file });
    }

    return { applied, skipped };
  } finally {
    await client.end();
  }
}
