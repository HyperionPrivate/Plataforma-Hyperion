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
  ACCESS_FK_CONTRACT_MIGRATIONS,
  createDefaultAccessFkContractGate,
  isAccessFkContractMigration,
  inspectLocalOperationalParity,
  type AccessFkContractGate,
  type AccessFkContractGateResult,
  type AccessFkContractReceipt
} from "./access-fk-contract-gate.js";
import {
  assertPulsoMigratorDatabaseSecurity,
  assertPulsoSchemaCompatible,
  inspectPulsoSchema,
  PULSO_BASELINE_MIGRATION,
  PULSO_CHANNEL_CONTRACT_MIGRATION,
  PULSO_CHANNEL_PROJECTION_MIGRATION,
  PULSO_CONTROL_PLANE_REVOKE_MIGRATION,
  PULSO_CURRENT_MIGRATION,
  PULSO_CURRENT_SCHEMA_VERSION,
  PULSO_EXPAND_SCHEMA_VERSION,
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
  [PULSO_CONTROL_PLANE_REVOKE_MIGRATION, 15],
  [PULSO_CURRENT_MIGRATION, PULSO_CURRENT_SCHEMA_VERSION]
]);
export const PULSO_ACCESS_FK_PARTIAL_RECOVERY_CONFIRMATION = "RESUME PARTIAL ACCESS FK CONTRACT";
export type PulsoMigrationPhase = "expand" | "contract";
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
  const phase = readPulsoMigrationPhase(env);
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
      if (phase === "expand" && (initialInspection.currentVersion ?? 0) > PULSO_EXPAND_SCHEMA_VERSION) {
        throw new Error("PULSO expand phase refused: schema has already entered the forward-only contract phase");
      }
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

    const appliedContractCount = ACCESS_FK_CONTRACT_MIGRATIONS.filter((name) => checksums.has(name)).length;
    assertAccessFkPartialRecovery(phase, appliedContractCount, env);

    const migrationSetSha256 = computeAccessFkMigrationSetSha256(migrations);
    let contractGateResult: AccessFkContractGateResult | undefined;

    for (const migration of migrations) {
      if (phase === "expand" && SCHEMA_VERSION_BY_MIGRATION.get(migration.name)! > PULSO_EXPAND_SCHEMA_VERSION) break;
      if (migration.name === baseline.name) continue;
      const prior = checksums.get(migration.name);
      if (prior !== undefined) {
        if (prior !== migration.checksum) throw new Error(`PULSO migration ${migration.name} checksum mismatch`);
        result.skipped.push(migration.name);
        continue;
      }
      if (
        phase === "contract" &&
        contractGateResult === undefined &&
        (isAccessFkContractMigration(migration.name) || migration.name === PULSO_CURRENT_MIGRATION)
      ) {
        contractGateResult = (await accessFkContractGate(client, {
          migrationName: migration.name,
          env,
          migrationSetSha256,
          targetMigration: PULSO_CURRENT_MIGRATION,
          targetVersion: PULSO_CURRENT_SCHEMA_VERSION
        })) ?? { mode: "greenfield" };
      }
      await applyMigration(
        client,
        migration,
        migration.name === PULSO_CURRENT_MIGRATION ? contractGateResult : undefined,
        migrationSetSha256
      );
      checksums.set(migration.name, migration.checksum);
      result.applied.push(migration.name);
    }

    const finalInspection = await inspectPulsoSchema(client, "migrator", manifests);
    assertPulsoSchemaCompatible(finalInspection);
    const expectedVersion = phase === "expand" ? PULSO_EXPAND_SCHEMA_VERSION : PULSO_CURRENT_SCHEMA_VERSION;
    const expectedMigration = [...SCHEMA_VERSION_BY_MIGRATION.entries()].find(
      ([, version]) => version === expectedVersion
    )?.[0];
    if (
      finalInspection.state !== "managed" ||
      finalInspection.currentVersion !== expectedVersion ||
      finalInspection.migrationName !== expectedMigration
    ) {
      throw new Error(
        `PULSO migrations ended in an unexpected schema state ${finalInspection.state}@${String(finalInspection.currentVersion)}:${String(finalInspection.migrationName)}`
      );
    }
    validateManagedMigrationState(finalInspection, migrations);
    const expectedLedgerLength = [...SCHEMA_VERSION_BY_MIGRATION.values()].filter(
      (version) => version <= expectedVersion
    ).length;
    if (finalInspection.ledgerEntries.length !== expectedLedgerLength) {
      throw new Error("PULSO migrations ended with an incomplete provider-owned ledger");
    }
    if (phase === "contract") await assertPersistedAccessFkAttestation(client, migrationSetSha256);
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

async function applyMigration(
  client: PulsoMigrationClient,
  migration: PulsoMigrationFile,
  attestation: AccessFkContractGateResult | undefined,
  migrationSetSha256: string
): Promise<void> {
  await client.query("begin");
  try {
    await setMigrationTimeouts(client);
    await client.query(migration.sql);
    if (migration.name === PULSO_CURRENT_MIGRATION) {
      await insertAccessFkAttestation(client, attestation ?? { mode: "greenfield" }, migrationSetSha256);
    }
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

export function computeAccessFkMigrationSetSha256(migrations: readonly PulsoMigrationFile[]): string {
  const entries = ACCESS_FK_CONTRACT_MIGRATIONS.map((name) => {
    const migration = migrations.find((candidate) => candidate.name === name);
    if (!migration) throw new Error(`Missing Access FK contract migration ${name}`);
    return { name, checksum: migration.checksum };
  });
  return createHash("sha256").update(canonicalJson(entries)).digest("hex");
}

export function readPulsoMigrationPhase(env: NodeJS.ProcessEnv): PulsoMigrationPhase {
  const value = env.PULSO_MIGRATION_PHASE?.trim().toLowerCase();
  if (value === "expand" || value === "contract") return value;
  const environment = (env.HYPERION_ENVIRONMENT ?? env.HYPERION_ENV ?? env.NODE_ENV ?? "development")
    .trim()
    .toLowerCase();
  if (environment === "production" || environment === "staging") {
    throw new Error("PULSO_MIGRATION_PHASE must be explicitly set to expand or contract in staging/production");
  }
  return "contract";
}

export function assertAccessFkPartialRecovery(
  phase: PulsoMigrationPhase,
  appliedContractCount: number,
  env: NodeJS.ProcessEnv
): void {
  if (
    !Number.isSafeInteger(appliedContractCount) ||
    appliedContractCount < 0 ||
    appliedContractCount > ACCESS_FK_CONTRACT_MIGRATIONS.length
  ) {
    throw new Error("Access FK applied contract count is invalid");
  }
  if (
    phase === "contract" &&
    appliedContractCount > 0 &&
    appliedContractCount < ACCESS_FK_CONTRACT_MIGRATIONS.length &&
    env.PULSO_ACCESS_FK_PARTIAL_RECOVERY_CONFIRM?.trim() !== PULSO_ACCESS_FK_PARTIAL_RECOVERY_CONFIRMATION
  ) {
    throw new Error(
      `Partial Access FK contract state (${appliedContractCount}/${ACCESS_FK_CONTRACT_MIGRATIONS.length}) requires PULSO_ACCESS_FK_PARTIAL_RECOVERY_CONFIRM=${PULSO_ACCESS_FK_PARTIAL_RECOVERY_CONFIRMATION}`
    );
  }
}

async function insertAccessFkAttestation(
  client: PulsoMigrationClient,
  attestation: AccessFkContractGateResult,
  migrationSetSha256: string
): Promise<void> {
  if (attestation.mode === "receipt") {
    const receipt = attestation.receipt;
    const receiptSha256 = receipt.receiptSha256 ?? digestReceipt(receipt);
    await client.query(
      `insert into pulso_iris.access_fk_contract_attestations(
         receipt_sha256, attestation_mode, deployment_id, environment,
         pulso_database, access_database, source_revision, migration_set_sha256,
         observed_schema_version, observed_migration, target_schema_version,
         target_migration, captured_at, receipt
       ) values ($1, 'receipt', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
      [
        receiptSha256,
        receipt.deploymentId,
        receipt.environment,
        receipt.pulsoDatabase,
        receipt.accessDatabase,
        receipt.sourceRevision,
        receipt.migrationSetSha256,
        receipt.observedSchemaVersion,
        receipt.observedMigration,
        receipt.targetVersion,
        receipt.targetMigration,
        receipt.capturedAt,
        JSON.stringify(receipt)
      ]
    );
    return;
  }
  const receipt = {
    kind: "access-fk-contract-greenfield",
    schemaVersion: 1,
    migrationSetSha256,
    targetVersion: PULSO_CURRENT_SCHEMA_VERSION,
    targetMigration: PULSO_CURRENT_MIGRATION
  } as const;
  const receiptSha256 = createHash("sha256").update(canonicalJson(receipt)).digest("hex");
  await client.query(
    `insert into pulso_iris.access_fk_contract_attestations(
       receipt_sha256, attestation_mode, migration_set_sha256,
       observed_schema_version, observed_migration, target_schema_version,
       target_migration, captured_at, receipt
     ) values ($1, 'greenfield', $2, 15, $3, $4, $5, clock_timestamp(), $6::jsonb)`,
    [
      receiptSha256,
      migrationSetSha256,
      PULSO_CONTROL_PLANE_REVOKE_MIGRATION,
      PULSO_CURRENT_SCHEMA_VERSION,
      PULSO_CURRENT_MIGRATION,
      JSON.stringify(receipt)
    ]
  );
}

async function assertPersistedAccessFkAttestation(
  client: PulsoMigrationClient,
  migrationSetSha256: string
): Promise<void> {
  const local = await inspectLocalOperationalParity(client);
  if (local.orphanTenantIds > 0 || local.orphanProductIds > 0) {
    throw new Error("Persisted Access FK contract attestation failed the current local orphan audit");
  }
  const result = await client.query<{
    receipt_sha256: string;
    attestation_mode: string;
    migration_set_sha256: string;
    target_schema_version: number | string;
    target_migration: string;
    receipt: unknown;
  }>(
    `select receipt_sha256, attestation_mode, migration_set_sha256,
            target_schema_version, target_migration, receipt
       from pulso_iris.access_fk_contract_attestations`
  );
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) throw new Error("PULSO requires exactly one Access FK contract attestation");
  if (
    row.migration_set_sha256 !== migrationSetSha256 ||
    Number(row.target_schema_version) !== PULSO_CURRENT_SCHEMA_VERSION ||
    row.target_migration !== PULSO_CURRENT_MIGRATION ||
    !["receipt", "greenfield"].includes(row.attestation_mode)
  ) {
    throw new Error("Persisted Access FK contract attestation binding mismatch");
  }
  const embedded = row.receipt as AccessFkContractReceipt & { receiptSha256?: string };
  const expectedDigest =
    row.attestation_mode === "receipt"
      ? digestReceipt(embedded)
      : createHash("sha256").update(canonicalJson(embedded)).digest("hex");
  if (row.receipt_sha256 !== expectedDigest) {
    throw new Error("Persisted Access FK contract attestation receipt digest mismatch");
  }
}

function digestReceipt(receipt: AccessFkContractReceipt): string {
  const { receiptSha256: _ignored, ...unsigned } = receipt;
  return createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
