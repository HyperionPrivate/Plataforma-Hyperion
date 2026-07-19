import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  acquireLumenMigrationLock,
  assertLumenProviderSqlPreservesTimeouts,
  configureLumenMigrationSessionTimeouts,
  configureLumenMigrationTimeouts
} from "./sql-policy.js";
import {
  assertLumenMigratorDatabaseSecurity,
  assertLumenSchemaCompatible,
  inspectLumenSchema,
  LUMEN_BASELINE_MIGRATION,
  LUMEN_CURRENT_MIGRATION,
  LUMEN_CURRENT_SCHEMA_VERSION,
  LUMEN_LEGACY_SCHEMA_VERSION,
  LUMEN_SCHEMA_MANIFEST,
  type LumenSchemaClient,
  type LumenSchemaInspection,
  type LumenSchemaManifestSet,
  type LumenSchemaState
} from "./schema-manifest.js";

const { Client } = pg;
const MIGRATION_LOCK = "lumen:cell-migrations";
const SCHEMA_VERSION_BY_MIGRATION = new Map<string, number>([
  [LUMEN_BASELINE_MIGRATION, LUMEN_LEGACY_SCHEMA_VERSION],
  [LUMEN_CURRENT_MIGRATION, LUMEN_CURRENT_SCHEMA_VERSION]
]);
const MIGRATION_LEDGER_DDL = `
create table lumen.migration_ledger (
  name text primary key,
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now()
)
`;

export type LumenMigrationClient = LumenSchemaClient;

export interface LumenMigrationResult {
  applied: string[];
  adopted: string[];
  skipped: string[];
}

interface LumenMigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function runLumenMigrations(databaseUrl: string, sqlDirectory: string): Promise<LumenMigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await runLumenMigrationsWithClient(client, sqlDirectory);
  } finally {
    await client.end();
  }
}

export async function runLumenMigrationsWithClient(
  client: LumenMigrationClient,
  sqlDirectory: string,
  manifests: LumenSchemaManifestSet = LUMEN_SCHEMA_MANIFEST
): Promise<LumenMigrationResult> {
  const migrations = await readLumenMigrationFiles(sqlDirectory);
  validateProviderOwnedMigrationSet(migrations);
  const baseline = migrations.find((migration) => migration.name === LUMEN_BASELINE_MIGRATION);
  if (!baseline) throw new Error(`Missing required LUMEN baseline ${LUMEN_BASELINE_MIGRATION}`);
  await configureLumenMigrationSessionTimeouts(client);
  await assertLumenMigratorDatabaseSecurity(client);
  await acquireLumenMigrationLock(client, MIGRATION_LOCK);
  try {
    const initialInspection = await inspectLumenSchema(client, "migrator", manifests);
    assertLumenSchemaCompatible(initialInspection);
    const result: LumenMigrationResult = { applied: [], adopted: [], skipped: [] };
    let checksums = new Map(initialInspection.ledgerEntries.map((row) => [row.name, row.checksum]));

    if (initialInspection.state === "managed") {
      validateManagedMigrationState(initialInspection, migrations);
    }

    if (initialInspection.state === "fresh") {
      await initializeFreshSchema(client, baseline, manifests);
      result.applied.push(baseline.name);
      checksums = new Map([[baseline.name, baseline.checksum]]);
    } else if (initialInspection.state === "legacy") {
      await adoptLegacySchema(client, baseline, manifests);
      result.adopted.push(baseline.name);
      result.skipped.push(baseline.name);
      checksums = new Map([[baseline.name, baseline.checksum]]);
    } else if (initialInspection.state === "managed") {
      const priorBaseline = checksums.get(baseline.name);
      if (priorBaseline !== baseline.checksum) {
        throw new Error(`LUMEN migration ${baseline.name} checksum mismatch`);
      }
      result.skipped.push(baseline.name);
    } else {
      throw new Error("LUMEN schema adoption refused");
    }

    const knownFiles = new Set(migrations.map((migration) => migration.name));
    const unknownLedgerEntry = [...checksums.keys()].find((name) => !knownFiles.has(name));
    if (unknownLedgerEntry) throw new Error(`Unknown LUMEN migration ledger entry ${unknownLedgerEntry}`);

    for (const migration of migrations) {
      if (migration.name === baseline.name) continue;
      const prior = checksums.get(migration.name);
      if (prior !== undefined) {
        if (prior !== migration.checksum) throw new Error(`LUMEN migration ${migration.name} checksum mismatch`);
        result.skipped.push(migration.name);
        continue;
      }
      await applyMigration(client, migration);
      checksums.set(migration.name, migration.checksum);
      result.applied.push(migration.name);
    }

    const finalInspection = await inspectLumenSchema(client, "migrator", manifests);
    assertLumenSchemaCompatible(finalInspection);
    if (
      finalInspection.state !== "managed" ||
      finalInspection.currentVersion !== LUMEN_CURRENT_SCHEMA_VERSION ||
      finalInspection.migrationName !== LUMEN_CURRENT_MIGRATION
    ) {
      throw new Error(
        `LUMEN migrations ended in an unexpected schema state ${finalInspection.state}@${String(finalInspection.currentVersion)}:${String(finalInspection.migrationName)}`
      );
    }
    validateManagedMigrationState(finalInspection, migrations);
    if (finalInspection.ledgerEntries.length !== migrations.length) {
      throw new Error("LUMEN migrations ended with an incomplete provider-owned ledger");
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]);
  }
}

async function initializeFreshSchema(
  client: LumenMigrationClient,
  baseline: LumenMigrationFile,
  manifests: LumenSchemaManifestSet
): Promise<void> {
  await client.query("begin");
  try {
    await assertStableState(client, "fresh", manifests);
    await setMigrationTimeouts(client);
    await client.query(baseline.sql);
    await client.query(MIGRATION_LEDGER_DDL);
    await client.query("insert into lumen.migration_ledger(name, checksum) values ($1, $2)", [
      baseline.name,
      baseline.checksum
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function adoptLegacySchema(
  client: LumenMigrationClient,
  baseline: LumenMigrationFile,
  manifests: LumenSchemaManifestSet
): Promise<void> {
  await client.query("begin");
  try {
    await assertStableState(client, "legacy", manifests);
    await setMigrationTimeouts(client);
    await client.query(MIGRATION_LEDGER_DDL);
    await client.query(
      `insert into lumen.service_migrations(version, name)
       values ($1, $2)
       on conflict (version) do update set name = excluded.name`,
      [LUMEN_LEGACY_SCHEMA_VERSION, baseline.name]
    );
    await client.query(
      `insert into lumen.schema_version(service_name, current_version, migration_name)
       values ('lumen', $1, $2)
       on conflict (service_name) do update set
         current_version = excluded.current_version,
         migration_name = excluded.migration_name,
         updated_at = now()`,
      [LUMEN_LEGACY_SCHEMA_VERSION, baseline.name]
    );
    await client.query("insert into lumen.migration_ledger(name, checksum) values ($1, $2)", [
      baseline.name,
      baseline.checksum
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function assertStableState(
  client: LumenMigrationClient,
  expected: LumenSchemaState,
  manifests: LumenSchemaManifestSet
): Promise<void> {
  const inspection = await inspectLumenSchema(client, "migrator", manifests);
  assertLumenSchemaCompatible(inspection);
  if (inspection.state !== expected) {
    throw new Error(
      `LUMEN schema changed during migration initialization: expected ${expected}, got ${inspection.state}`
    );
  }
}

function validateManagedMigrationState(inspection: LumenSchemaInspection, migrations: LumenMigrationFile[]): void {
  const entries = inspection.ledgerEntries;
  if (entries.length > migrations.length) {
    throw new Error("LUMEN migration ledger contains entries unknown to this release");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expected = migrations[index];
    if (!entry || !expected || entry.name !== expected.name) {
      throw new Error("LUMEN migration ledger must be an exact prefix of the provider-owned migration set");
    }
    if (entry.checksum !== expected.checksum) {
      throw new Error(`LUMEN migration ${entry.name} checksum mismatch`);
    }
  }
  const lastEntry = entries.at(-1);
  const expectedVersion = lastEntry ? SCHEMA_VERSION_BY_MIGRATION.get(lastEntry.name) : undefined;
  if (expectedVersion === undefined) {
    throw new Error("LUMEN migration ledger has no recognized terminal schema version");
  }
  if (inspection.currentVersion !== expectedVersion) {
    throw new Error(
      `LUMEN schema_version is inconsistent with the ledger: expected ${expectedVersion}, got ${String(inspection.currentVersion)}`
    );
  }
  if (inspection.migrationName !== lastEntry?.name) {
    throw new Error(
      `LUMEN schema migration_name is inconsistent with the ledger: expected ${String(lastEntry?.name)}, got ${String(inspection.migrationName)}`
    );
  }
}

async function applyMigration(client: LumenMigrationClient, migration: LumenMigrationFile): Promise<void> {
  await client.query("begin");
  try {
    await setMigrationTimeouts(client);
    await client.query(migration.sql);
    await client.query("insert into lumen.migration_ledger(name, checksum) values ($1, $2)", [
      migration.name,
      migration.checksum
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function setMigrationTimeouts(client: LumenMigrationClient): Promise<void> {
  await configureLumenMigrationTimeouts(client);
}

async function readLumenMigrationFiles(sqlDirectory: string): Promise<LumenMigrationFile[]> {
  const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(sqlDirectory, name), "utf8");
      assertLumenProviderSqlPreservesTimeouts(name, sql);
      return { name, sql, checksum: computeLumenMigrationChecksum(sql) };
    })
  );
}

function validateProviderOwnedMigrationSet(migrations: LumenMigrationFile[]): void {
  assertLumenProviderMigrationNames(migrations.map((migration) => migration.name));
}

export function assertLumenProviderMigrationNames(actualNames: string[]): void {
  const expectedNames = [...SCHEMA_VERSION_BY_MIGRATION.keys()];
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error(
      `LUMEN provider-owned migration set mismatch: expected ${expectedNames.join(", ")}, got ${actualNames.join(", ")}`
    );
  }
}

export function computeLumenMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
}
