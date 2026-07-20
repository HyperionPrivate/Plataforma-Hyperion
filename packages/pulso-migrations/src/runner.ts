import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import {
  acquirePulsoMigrationLock,
  assertPulsoProviderSqlPreservesTimeouts,
  configurePulsoMigrationSessionTimeouts,
  configurePulsoMigrationTimeouts
} from "./sql-policy.js";
import {
  createDefaultAccessFkContractGate,
  isAccessFkContractMigration,
  type AccessFkContractGate
} from "./access-fk-contract-gate.js";
import {
  assertPulsoMigratorDatabaseSecurity,
  assertPulsoSchemaCompatible,
  inspectPulsoSchema,
  PULSO_BASELINE_MIGRATION,
  PULSO_CHANNEL_CONTRACT_MIGRATION,
  PULSO_CHANNEL_PROJECTION_MIGRATION,
  PULSO_CURRENT_MIGRATION,
  PULSO_CURRENT_SCHEMA_VERSION,
  PULSO_INTEGRATION_CONTRACT_MIGRATION,
  PULSO_INTEGRATION_PROJECTION_MIGRATION,
  PULSO_IRIS_CONTRACT_MIGRATION,
  PULSO_IRIS_PROJECTION_MIGRATION,
  PULSO_KNOWLEDGE_CONTRACT_MIGRATION,
  PULSO_KNOWLEDGE_PROJECTION_MIGRATION,
  PULSO_LEGACY_SCHEMA_VERSION,
  PULSO_N_MINUS_ONE_DROP_MIGRATION,
  PULSO_RUNTIME_ROLES_MIGRATION,
  PULSO_SCHEMA_MANIFEST,
  PULSO_SOFIA_CONTRACT_MIGRATION,
  PULSO_SOFIA_PROJECTION_MIGRATION,
  SOFIA_READINESS_MIGRATION,
  type PulsoSchemaClient,
  type PulsoSchemaInspection,
  type PulsoSchemaManifestSet,
  type PulsoSchemaState
} from "./schema-manifest.js";

const { Client } = pg;
const MIGRATION_LOCK = "pulso:cell-migrations";
const SCHEMA_VERSION_BY_MIGRATION = new Map<string, number>([
  [PULSO_BASELINE_MIGRATION, PULSO_LEGACY_SCHEMA_VERSION],
  [PULSO_RUNTIME_ROLES_MIGRATION, 2],
  [SOFIA_READINESS_MIGRATION, 3],
  [PULSO_CHANNEL_PROJECTION_MIGRATION, 4],
  [PULSO_IRIS_PROJECTION_MIGRATION, 5],
  [PULSO_SOFIA_PROJECTION_MIGRATION, 6],
  [PULSO_INTEGRATION_PROJECTION_MIGRATION, 7],
  [PULSO_KNOWLEDGE_PROJECTION_MIGRATION, 8],
  [PULSO_CHANNEL_CONTRACT_MIGRATION, 9],
  [PULSO_INTEGRATION_CONTRACT_MIGRATION, 10],
  [PULSO_SOFIA_CONTRACT_MIGRATION, 11],
  [PULSO_IRIS_CONTRACT_MIGRATION, 12],
  [PULSO_KNOWLEDGE_CONTRACT_MIGRATION, 13],
  [PULSO_N_MINUS_ONE_DROP_MIGRATION, 14],
  [PULSO_CURRENT_MIGRATION, PULSO_CURRENT_SCHEMA_VERSION]
]);
const CONTROL_TABLES_DDL = `
create table if not exists pulso_iris.schema_version (
  service_name text primary key,
  current_version integer not null check (current_version > 0),
  migration_name text not null,
  updated_at timestamptz not null default now(),
  constraint schema_version_service_name_check check (service_name = 'pulso')
);
create table if not exists pulso_iris.service_migrations (
  version integer primary key check (version > 0),
  name text not null unique check (length(btrim(name)) between 3 and 160),
  applied_at timestamptz not null default now()
);
create table if not exists pulso_iris.migration_ledger (
  name text primary key,
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now()
)
`;

export type PulsoMigrationClient = PulsoSchemaClient;

export interface PulsoMigrationResult {
  applied: string[];
  adopted: string[];
  skipped: string[];
}

interface PulsoMigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface PulsoMigrationRunnerOptions {
  readonly manifests?: PulsoSchemaManifestSet;
  readonly accessFkContractGate?: AccessFkContractGate;
  readonly env?: NodeJS.ProcessEnv;
}

export async function runPulsoMigrations(databaseUrl: string, sqlDirectory: string): Promise<PulsoMigrationResult> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await runPulsoMigrationsWithClient(client, sqlDirectory);
  } finally {
    await client.end();
  }
}

export async function runPulsoMigrationsWithClient(
  client: PulsoMigrationClient,
  sqlDirectory: string,
  manifestsOrOptions: PulsoSchemaManifestSet | PulsoMigrationRunnerOptions = PULSO_SCHEMA_MANIFEST
): Promise<PulsoMigrationResult> {
  const options: PulsoMigrationRunnerOptions =
    manifestsOrOptions && "managed" in manifestsOrOptions
      ? { manifests: manifestsOrOptions }
      : (manifestsOrOptions as PulsoMigrationRunnerOptions);
  const manifests = options.manifests ?? PULSO_SCHEMA_MANIFEST;
  const accessFkContractGate = options.accessFkContractGate ?? createDefaultAccessFkContractGate();
  const env = options.env ?? process.env;
  const migrations = await readPulsoMigrationFiles(sqlDirectory);
  validateProviderOwnedMigrationSet(migrations);
  const baseline = migrations.find((migration) => migration.name === PULSO_BASELINE_MIGRATION);
  if (!baseline) throw new Error(`Missing required PULSO baseline ${PULSO_BASELINE_MIGRATION}`);
  await configurePulsoMigrationSessionTimeouts(client);
  await assertPulsoMigratorDatabaseSecurity(client);
  await acquirePulsoMigrationLock(client, MIGRATION_LOCK);
  try {
    const initialInspection = await inspectPulsoSchema(client, "migrator", manifests);
    assertPulsoSchemaCompatible(initialInspection);
    const result: PulsoMigrationResult = { applied: [], adopted: [], skipped: [] };
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
        throw new Error(`PULSO migration ${baseline.name} checksum mismatch`);
      }
      result.skipped.push(baseline.name);
    } else {
      throw new Error("PULSO schema adoption refused");
    }

    const knownFiles = new Set(migrations.map((migration) => migration.name));
    const unknownLedgerEntry = [...checksums.keys()].find((name) => !knownFiles.has(name));
    if (unknownLedgerEntry) throw new Error(`Unknown PULSO migration ledger entry ${unknownLedgerEntry}`);

    for (const migration of migrations) {
      if (migration.name === baseline.name) continue;
      const prior = checksums.get(migration.name);
      if (prior !== undefined) {
        if (prior !== migration.checksum) throw new Error(`PULSO migration ${migration.name} checksum mismatch`);
        result.skipped.push(migration.name);
        continue;
      }
      if (isAccessFkContractMigration(migration.name)) {
        await accessFkContractGate(client, { migrationName: migration.name, env });
      }
      await applyMigration(client, migration);
      checksums.set(migration.name, migration.checksum);
      result.applied.push(migration.name);
    }

    const finalInspection = await inspectPulsoSchema(client, "migrator", manifests);
    assertPulsoSchemaCompatible(finalInspection);
    if (
      finalInspection.state !== "managed" ||
      finalInspection.currentVersion !== PULSO_CURRENT_SCHEMA_VERSION ||
      finalInspection.migrationName !== PULSO_CURRENT_MIGRATION
    ) {
      throw new Error(
        `PULSO migrations ended in an unexpected schema state ${finalInspection.state}@${String(finalInspection.currentVersion)}:${String(finalInspection.migrationName)}`
      );
    }
    validateManagedMigrationState(finalInspection, migrations);
    if (finalInspection.ledgerEntries.length !== migrations.length) {
      throw new Error("PULSO migrations ended with an incomplete provider-owned ledger");
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]);
  }
}

async function initializeFreshSchema(
  client: PulsoMigrationClient,
  baseline: PulsoMigrationFile,
  manifests: PulsoSchemaManifestSet
): Promise<void> {
  await client.query("begin");
  try {
    await assertStableState(client, "fresh", manifests);
    await setMigrationTimeouts(client);
    await client.query(baseline.sql);
    await client.query(CONTROL_TABLES_DDL);
    await client.query("insert into pulso_iris.migration_ledger(name, checksum) values ($1, $2)", [
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
  client: PulsoMigrationClient,
  baseline: PulsoMigrationFile,
  manifests: PulsoSchemaManifestSet
): Promise<void> {
  await client.query("begin");
  try {
    await assertStableState(client, "legacy", manifests);
    await setMigrationTimeouts(client);
    await client.query(CONTROL_TABLES_DDL);
    await client.query(
      `insert into pulso_iris.service_migrations(version, name)
       values ($1, $2)
       on conflict (version) do update set name = excluded.name`,
      [PULSO_LEGACY_SCHEMA_VERSION, baseline.name]
    );
    await client.query(
      `insert into pulso_iris.schema_version(service_name, current_version, migration_name)
       values ('pulso', $1, $2)
       on conflict (service_name) do update set
         current_version = excluded.current_version,
         migration_name = excluded.migration_name,
         updated_at = now()`,
      [PULSO_LEGACY_SCHEMA_VERSION, baseline.name]
    );
    await client.query("insert into pulso_iris.migration_ledger(name, checksum) values ($1, $2)", [
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
  client: PulsoMigrationClient,
  expected: PulsoSchemaState,
  manifests: PulsoSchemaManifestSet
): Promise<void> {
  const inspection = await inspectPulsoSchema(client, "migrator", manifests);
  assertPulsoSchemaCompatible(inspection);
  if (inspection.state !== expected) {
    throw new Error(
      `PULSO schema changed during migration initialization: expected ${expected}, got ${inspection.state}`
    );
  }
}

function validateManagedMigrationState(inspection: PulsoSchemaInspection, migrations: PulsoMigrationFile[]): void {
  const entries = inspection.ledgerEntries;
  if (entries.length > migrations.length) {
    throw new Error("PULSO migration ledger contains entries unknown to this release");
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expected = migrations[index];
    if (!entry || !expected || entry.name !== expected.name) {
      throw new Error("PULSO migration ledger must be an exact prefix of the provider-owned migration set");
    }
    if (entry.checksum !== expected.checksum) {
      throw new Error(`PULSO migration ${entry.name} checksum mismatch`);
    }
  }
  const lastEntry = entries.at(-1);
  const expectedVersion = lastEntry ? SCHEMA_VERSION_BY_MIGRATION.get(lastEntry.name) : undefined;
  if (expectedVersion === undefined) {
    throw new Error("PULSO migration ledger has no recognized terminal schema version");
  }
  if (inspection.currentVersion !== expectedVersion) {
    throw new Error(
      `PULSO schema_version is inconsistent with the ledger: expected ${expectedVersion}, got ${String(inspection.currentVersion)}`
    );
  }
  if (inspection.migrationName !== lastEntry?.name) {
    throw new Error(
      `PULSO schema migration_name is inconsistent with the ledger: expected ${String(lastEntry?.name)}, got ${String(inspection.migrationName)}`
    );
  }
}

async function applyMigration(client: PulsoMigrationClient, migration: PulsoMigrationFile): Promise<void> {
  await client.query("begin");
  try {
    await setMigrationTimeouts(client);
    await client.query(migration.sql);
    await client.query("insert into pulso_iris.migration_ledger(name, checksum) values ($1, $2)", [
      migration.name,
      migration.checksum
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function setMigrationTimeouts(client: PulsoMigrationClient): Promise<void> {
  await configurePulsoMigrationTimeouts(client);
}

async function readPulsoMigrationFiles(sqlDirectory: string): Promise<PulsoMigrationFile[]> {
  const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
  return Promise.all(
    files.map(async (name) => {
      const sql = await readFile(path.join(sqlDirectory, name), "utf8");
      assertPulsoProviderSqlPreservesTimeouts(name, sql);
      return { name, sql, checksum: computePulsoMigrationChecksum(sql) };
    })
  );
}

function validateProviderOwnedMigrationSet(migrations: PulsoMigrationFile[]): void {
  assertPulsoProviderMigrationNames(migrations.map((migration) => migration.name));
}

export function assertPulsoProviderMigrationNames(actualNames: string[]): void {
  const expectedNames = [...SCHEMA_VERSION_BY_MIGRATION.keys()];
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error(
      `PULSO provider-owned migration set mismatch: expected ${expectedNames.join(", ")}, got ${actualNames.join(", ")}`
    );
  }
}

export function computePulsoMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
}
