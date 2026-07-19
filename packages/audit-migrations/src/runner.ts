import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  assertAuditSchemaReady,
  AUDIT_BASELINE_MIGRATION,
  AUDIT_PROVIDER_LEDGER,
  AUDIT_PROVIDER_MIGRATIONS,
  inspectAuditSchema,
  type AuditSchemaClient
} from "./schema-manifest.js";

const { Client } = pg;
const MIGRATION_LOCK = "audit:provider-migrations";

export type AuditMigrationClient = AuditSchemaClient;

export interface AuditMigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runAuditMigrations(databaseUrl: string, sqlDirectory: string): Promise<AuditMigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await runAuditMigrationsWithClient(client, sqlDirectory);
  } finally {
    await client.end();
  }
}

export async function runAuditMigrationsWithClient(
  client: AuditMigrationClient,
  sqlDirectory: string
): Promise<AuditMigrationResult> {
  const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
  assertAuditProviderMigrationNames(files);
  const sql = await readFile(path.join(sqlDirectory, AUDIT_BASELINE_MIGRATION), "utf8");
  const checksum = computeAuditMigrationChecksum(sql);
  if (checksum !== AUDIT_PROVIDER_LEDGER[0].checksum) {
    throw new Error("Audit baseline checksum differs from the provider recovery manifest");
  }

  await client.query("select set_config('lock_timeout', '10s', false)");
  await client.query("select set_config('statement_timeout', '300s', false)");
  await client.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK]);
  try {
    const initial = await inspectAuditSchema(client);
    if (!initial.ledgerPresent) {
      if (initial.auditEventsPresent || initial.inboxPresent) {
        throw new Error("Audit migration refused provider objects without audit_runtime.migration_ledger");
      }
      await client.query("begin");
      try {
        await client.query("select set_config('lock_timeout', '10s', true)");
        await client.query("select set_config('statement_timeout', '300s', true)");
        await client.query(sql);
        await client.query("insert into audit_runtime.migration_ledger(name, checksum) values ($1, $2)", [
          AUDIT_BASELINE_MIGRATION,
          checksum
        ]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
      assertAuditSchemaReady(await inspectAuditSchema(client));
      return { applied: [AUDIT_BASELINE_MIGRATION], skipped: [] };
    }

    assertAuditSchemaReady(initial);
    const ledger = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from audit_runtime.migration_ledger order by name"
    );
    if (
      ledger.rows.length !== 1 ||
      ledger.rows[0]?.name !== AUDIT_BASELINE_MIGRATION ||
      ledger.rows[0]?.checksum !== checksum
    ) {
      throw new Error("Audit provider migration ledger does not match this release");
    }
    return { applied: [], skipped: [AUDIT_BASELINE_MIGRATION] };
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]);
  }
}

export function assertAuditProviderMigrationNames(actualNames: string[]): void {
  const expected = [...AUDIT_PROVIDER_MIGRATIONS];
  if (actualNames.length !== expected.length || actualNames.some((name, index) => name !== expected[index])) {
    throw new Error(
      `Audit provider-owned migration set mismatch: expected ${expected.join(", ")}, got ${actualNames.join(", ")}`
    );
  }
}

export function computeAuditMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
}
