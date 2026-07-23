/**
 * Preflight gate for Access→PULSO FK contract migrations (009–013).
 *
 * Append-only contract SQL still DROPs foreign keys; this gate refuses that
 * cutover when operational tenant data exists without a verified parity receipt.
 * Greenfield (empty operational tables + empty snapshots) is allowed.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  PULSO_CHANNEL_CONTRACT_MIGRATION,
  PULSO_INTEGRATION_CONTRACT_MIGRATION,
  PULSO_IRIS_CONTRACT_MIGRATION,
  PULSO_KNOWLEDGE_CONTRACT_MIGRATION,
  PULSO_SOFIA_CONTRACT_MIGRATION,
  type PulsoSchemaClient
} from "./schema-manifest.js";

export const ACCESS_FK_CONTRACT_MIGRATIONS = Object.freeze([
  PULSO_CHANNEL_CONTRACT_MIGRATION,
  PULSO_INTEGRATION_CONTRACT_MIGRATION,
  PULSO_SOFIA_CONTRACT_MIGRATION,
  PULSO_IRIS_CONTRACT_MIGRATION,
  PULSO_KNOWLEDGE_CONTRACT_MIGRATION
] as const);

export type AccessFkContractMigrationName = (typeof ACCESS_FK_CONTRACT_MIGRATIONS)[number];

export const ACCESS_FK_CONTRACT_CONSUMERS = Object.freeze([
  "channel",
  "iris",
  "sofia",
  "integration",
  "knowledge"
] as const);

export type AccessFkContractConsumer = (typeof ACCESS_FK_CONTRACT_CONSUMERS)[number];

export interface ConsumerOperationalTables {
  readonly consumer: AccessFkContractConsumer;
  readonly snapshotSchema: string;
  readonly operationalTables: readonly string[];
}

export const CONSUMER_OPERATIONAL_TABLES: readonly ConsumerOperationalTables[] = Object.freeze([
  {
    consumer: "channel",
    snapshotSchema: "channel_runtime",
    operationalTables: Object.freeze([
      "channel_runtime.connections",
      "channel_runtime.delivery_receipts",
      "channel_runtime.inbound_events",
      "channel_runtime.outbound_messages",
      "channel_runtime.thread_bindings"
    ])
  },
  {
    consumer: "iris",
    snapshotSchema: "pulso_iris",
    operationalTables: Object.freeze([
      "pulso_iris.administrative_patients",
      "pulso_iris.agenda_blocks",
      "pulso_iris.agenda_settings",
      "pulso_iris.appointment_holds",
      "pulso_iris.appointment_status_history",
      "pulso_iris.appointment_types",
      "pulso_iris.appointments",
      "pulso_iris.availability_rules",
      "pulso_iris.campaign_contacts",
      "pulso_iris.campaigns",
      "pulso_iris.configuration_imports",
      "pulso_iris.conversations",
      "pulso_iris.handoffs",
      "pulso_iris.holidays",
      "pulso_iris.operational_kpi_snapshots",
      "pulso_iris.payers",
      "pulso_iris.professional_appointment_types",
      "pulso_iris.professional_payer_exclusions",
      "pulso_iris.professional_sites",
      "pulso_iris.professionals",
      "pulso_iris.rpa_actions",
      "pulso_iris.rpa_events",
      "pulso_iris.rpa_workers",
      "pulso_iris.sites",
      "pulso_iris.waitlist"
    ])
  },
  {
    consumer: "sofia",
    snapshotSchema: "agent_runtime",
    operationalTables: Object.freeze([
      "platform.agents",
      "platform.prompt_flows",
      "agent_runtime.executions",
      "agent_runtime.jobs"
    ])
  },
  {
    consumer: "integration",
    snapshotSchema: "integration_runtime",
    operationalTables: Object.freeze(["platform.integrations"])
  },
  {
    consumer: "knowledge",
    snapshotSchema: "knowledge_runtime",
    operationalTables: Object.freeze(["platform.knowledge_sources"])
  }
]);

export const ACCESS_FK_PRODUCT_REFERENCE = Object.freeze({
  sourceTable: "platform.agents",
  sourceColumn: "product_id",
  targetTable: "platform.products",
  targetColumn: "id"
});

export interface AccessFkConsumerParity {
  readonly expectedTenants: number;
  readonly destinationTenants: number;
  readonly matchedTenants: number;
  readonly coverageBasisPoints: number;
  readonly missingTenants: number;
  readonly extraTenants: number;
  readonly statusMismatches: number;
  readonly sourceVersionMismatches: number;
  readonly currentEventIdMismatches: number;
  readonly referencedTenantIdsMissingSnapshot: number;
  readonly pendingOrDeadLetterEvents: number;
  readonly sourceVersionConflicts: number;
}

export interface AccessFkContractReceipt {
  readonly kind: "access-fk-contract-parity";
  readonly schemaVersion: 2;
  readonly status: "verified";
  readonly capturedAt: string;
  readonly deploymentId: string;
  readonly environment: string;
  readonly pulsoDatabase: string;
  readonly accessDatabase: string;
  readonly sourceRevision: string;
  readonly migrationSetSha256: string;
  readonly observedSchemaVersion: number;
  readonly observedMigration: string;
  readonly targetVersion: 16;
  readonly targetMigration: string;
  readonly contracts: readonly string[];
  readonly consumers: Readonly<Record<AccessFkContractConsumer, AccessFkConsumerParity>>;
  readonly receiptSha256?: string;
}

export interface AccessFkContractGateContext {
  readonly migrationName: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly migrationSetSha256?: string;
  readonly targetMigration?: string;
  readonly targetVersion?: number;
}

export type AccessFkContractGateResult =
  Readonly<{ mode: "greenfield" }> | Readonly<{ mode: "receipt"; receipt: AccessFkContractReceipt }>;

export type AccessFkContractGate = (
  client: PulsoSchemaClient,
  context: AccessFkContractGateContext
) => Promise<AccessFkContractGateResult | void>;

export const ACCESS_FK_RECEIPT_MAX_AGE_MS = 30 * 60 * 1_000;
const ACCESS_FK_RECEIPT_MAX_FUTURE_SKEW_MS = 2 * 60 * 1_000;
const SAFE_DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const SAFE_DATABASE_NAME = /^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/;
const FULL_GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const ZERO_PARITY: AccessFkConsumerParity = Object.freeze({
  expectedTenants: 0,
  destinationTenants: 0,
  matchedTenants: 0,
  coverageBasisPoints: 10_000,
  missingTenants: 0,
  extraTenants: 0,
  statusMismatches: 0,
  sourceVersionMismatches: 0,
  currentEventIdMismatches: 0,
  referencedTenantIdsMissingSnapshot: 0,
  pendingOrDeadLetterEvents: 0,
  sourceVersionConflicts: 0
});

export function isAccessFkContractMigration(name: string): name is AccessFkContractMigrationName {
  return (ACCESS_FK_CONTRACT_MIGRATIONS as readonly string[]).includes(name);
}

export function createSkipAccessFkContractGate(): AccessFkContractGate {
  return async () => ({ mode: "greenfield" });
}

export function createDefaultAccessFkContractGate(): AccessFkContractGate {
  return async (client, context) => assertAccessFkContractParity(client, context);
}

export async function assertAccessFkContractParity(
  client: PulsoSchemaClient,
  context: AccessFkContractGateContext
): Promise<AccessFkContractGateResult> {
  if (!isAccessFkContractMigration(context.migrationName) && context.migrationName !== context.targetMigration) {
    return { mode: "greenfield" };
  }

  const local = await inspectLocalOperationalParity(client);
  if (local.orphanTenantIds > 0 || local.orphanProductIds > 0) {
    throw new Error(
      `Access FK contract ${context.migrationName} refused: ${local.orphanTenantIds} tenant_id reference(s) lack a local Access snapshot; ${local.orphanProductIds} product_id reference(s) lack platform.products`
    );
  }

  if (local.hasOperationalData) {
    const receipt = await loadAndVerifyAccessFkContractReceipt(context.env ?? process.env);
    await assertReceiptBinding(client, receipt, context);
    assertReceiptCoversAllConsumers(receipt);
    return { mode: "receipt", receipt };
  }

  // Greenfield: empty operational tables and empty snapshots — allow cutover.
  return { mode: "greenfield" };
}

export interface LocalParityInspection {
  readonly hasOperationalData: boolean;
  readonly orphanTenantIds: number;
  readonly orphanProductIds: number;
}

export async function inspectLocalOperationalParity(client: PulsoSchemaClient): Promise<LocalParityInspection> {
  let hasOperationalData = false;
  let orphanTenantIds = 0;

  for (const consumer of CONSUMER_OPERATIONAL_TABLES) {
    const snapshotCount = await countRows(
      client,
      `select count(*)::int as count from ${consumer.snapshotSchema}.tenant_snapshots`
    );
    if (snapshotCount > 0) hasOperationalData = true;

    if (consumer.operationalTables.length === 0) continue;

    const unionSql = consumer.operationalTables.map((table) => `select tenant_id from ${table}`).join("\n union\n ");
    const result = await client.query<{ referenced: number; missing: number }>(
      `with referenced as (
         ${unionSql}
       )
       select count(*)::int as referenced,
              count(*) filter (where snapshot.tenant_id is null)::int as missing
         from referenced
         left join ${consumer.snapshotSchema}.tenant_snapshots snapshot using (tenant_id)`
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Access FK local parity query returned no row for ${consumer.consumer}`);
    const referenced = Number(row.referenced);
    const missing = Number(row.missing);
    if (!Number.isSafeInteger(referenced) || referenced < 0 || !Number.isSafeInteger(missing) || missing < 0) {
      throw new Error(`Access FK local parity query returned invalid counts for ${consumer.consumer}`);
    }
    if (referenced > 0) hasOperationalData = true;
    orphanTenantIds += missing;
  }

  const productResult = await client.query<{ referenced: number; missing: number }>(
    `select count(*) filter (where source.product_id is not null)::int as referenced,
            count(*) filter (where source.product_id is not null and target.id is null)::int as missing
       from ${ACCESS_FK_PRODUCT_REFERENCE.sourceTable} source
       left join ${ACCESS_FK_PRODUCT_REFERENCE.targetTable} target
         on target.${ACCESS_FK_PRODUCT_REFERENCE.targetColumn} = source.${ACCESS_FK_PRODUCT_REFERENCE.sourceColumn}`
  );
  const productRow = productResult.rows[0];
  const referencedProducts = Number(productRow?.referenced);
  const orphanProductIds = Number(productRow?.missing);
  if (
    !Number.isSafeInteger(referencedProducts) ||
    referencedProducts < 0 ||
    !Number.isSafeInteger(orphanProductIds) ||
    orphanProductIds < 0
  ) {
    throw new Error("Access FK local product parity query returned invalid counts");
  }
  if (referencedProducts > 0) hasOperationalData = true;

  return { hasOperationalData, orphanTenantIds, orphanProductIds };
}

async function countRows(client: PulsoSchemaClient, sql: string): Promise<number> {
  const result = await client.query<{ count: number | string }>(sql);
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Access FK local parity count is invalid");
  }
  return count;
}

export async function loadAndVerifyAccessFkContractReceipt(env: NodeJS.ProcessEnv): Promise<AccessFkContractReceipt> {
  const receiptPath = env.PULSO_ACCESS_FK_CONTRACT_RECEIPT?.trim();
  const expectedSha = env.PULSO_ACCESS_FK_CONTRACT_RECEIPT_SHA256?.trim()?.toLowerCase();
  if (!receiptPath) {
    throw new Error(
      "Access FK contract refused: operational data exists but PULSO_ACCESS_FK_CONTRACT_RECEIPT is unset"
    );
  }
  if (!expectedSha || !SHA256.test(expectedSha)) {
    throw new Error("Access FK contract refused: PULSO_ACCESS_FK_CONTRACT_RECEIPT_SHA256 must be a 64-char hex digest");
  }

  const raw = await readFile(receiptPath, "utf8");
  const parsed = JSON.parse(raw) as AccessFkContractReceipt;
  const { receiptSha256: _ignored, ...unsigned } = parsed;
  const digest = sha256CanonicalJson(unsigned);
  if (digest !== expectedSha) {
    throw new Error(`Access FK contract receipt SHA-256 mismatch: expected ${expectedSha}, got ${digest}`);
  }
  if (!parsed.receiptSha256 || parsed.receiptSha256 !== digest) {
    throw new Error("Access FK contract receipt embeds a divergent receiptSha256");
  }
  assertReceiptShape(parsed);
  return parsed;
}

function assertReceiptShape(receipt: AccessFkContractReceipt): void {
  assertExactKeys(
    receipt as unknown as Record<string, unknown>,
    [
      "accessDatabase",
      "capturedAt",
      "consumers",
      "contracts",
      "deploymentId",
      "environment",
      "kind",
      "migrationSetSha256",
      "observedMigration",
      "observedSchemaVersion",
      "pulsoDatabase",
      "receiptSha256",
      "schemaVersion",
      "sourceRevision",
      "status",
      "targetMigration",
      "targetVersion"
    ],
    "receipt"
  );
  if (receipt.kind !== "access-fk-contract-parity") {
    throw new Error("Access FK contract receipt kind must be access-fk-contract-parity");
  }
  if (receipt.schemaVersion !== 2) {
    throw new Error("Access FK contract receipt schemaVersion must be 2");
  }
  if (receipt.status !== "verified") {
    throw new Error("Access FK contract receipt status must be verified");
  }
  if (!SAFE_DEPLOYMENT_ID.test(receipt.deploymentId)) {
    throw new Error("Access FK contract receipt deploymentId is invalid");
  }
  if (!SAFE_DEPLOYMENT_ID.test(receipt.environment)) {
    throw new Error("Access FK contract receipt environment is invalid");
  }
  if (!SAFE_DATABASE_NAME.test(receipt.pulsoDatabase) || !SAFE_DATABASE_NAME.test(receipt.accessDatabase)) {
    throw new Error("Access FK contract receipt database identity is invalid");
  }
  if (!FULL_GIT_SHA.test(receipt.sourceRevision) || /^0+$/.test(receipt.sourceRevision)) {
    throw new Error("Access FK contract receipt sourceRevision must be a nonzero full Git SHA");
  }
  if (!SHA256.test(receipt.migrationSetSha256)) {
    throw new Error("Access FK contract receipt migrationSetSha256 is invalid");
  }
  if (
    !Number.isSafeInteger(receipt.observedSchemaVersion) ||
    receipt.observedSchemaVersion < 8 ||
    receipt.observedSchemaVersion > 15
  ) {
    throw new Error("Access FK contract receipt observedSchemaVersion must be between 8 and 15");
  }
  if (!receipt.observedMigration || receipt.observedMigration.length > 160) {
    throw new Error("Access FK contract receipt observedMigration is invalid");
  }
  if (receipt.targetVersion !== 16) {
    throw new Error("Access FK contract receipt targetVersion must be 16");
  }
  if (!receipt.targetMigration || receipt.targetMigration.length > 160) {
    throw new Error("Access FK contract receipt targetMigration is invalid");
  }
  const capturedAt = Date.parse(receipt.capturedAt);
  if (!Number.isFinite(capturedAt)) {
    throw new Error("Access FK contract receipt capturedAt must be an ISO timestamp");
  }
  if (!Array.isArray(receipt.contracts)) {
    throw new Error("Access FK contract receipt contracts must be an array");
  }
  const expected = [...ACCESS_FK_CONTRACT_MIGRATIONS];
  if (
    receipt.contracts.length !== expected.length ||
    receipt.contracts.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `Access FK contract receipt contracts mismatch: expected ${expected.join(", ")}, got ${receipt.contracts.join(", ")}`
    );
  }
}

async function assertReceiptBinding(
  client: PulsoSchemaClient,
  receipt: AccessFkContractReceipt,
  context: AccessFkContractGateContext
): Promise<void> {
  const env = context.env ?? process.env;
  const deploymentId = requiredBinding(env, "PULSO_ACCESS_FK_CONTRACT_DEPLOYMENT_ID", SAFE_DEPLOYMENT_ID);
  const accessDatabase = requiredBinding(env, "PULSO_ACCESS_FK_CONTRACT_ACCESS_DATABASE", SAFE_DATABASE_NAME);
  const sourceRevision = requiredBinding(env, "PULSO_RELEASE_SOURCE_REVISION", FULL_GIT_SHA).toLowerCase();
  if (/^0+$/.test(sourceRevision)) throw new Error("PULSO_RELEASE_SOURCE_REVISION must be nonzero");
  const environment = (env.HYPERION_ENVIRONMENT ?? env.HYPERION_ENV ?? env.NODE_ENV ?? "development")
    .trim()
    .toLowerCase();
  const migrationSetSha256 = context.migrationSetSha256?.toLowerCase();
  if (!migrationSetSha256 || !SHA256.test(migrationSetSha256)) {
    throw new Error("Access FK contract gate requires the exact migrationSetSha256");
  }
  if (context.targetVersion !== 16 || !context.targetMigration) {
    throw new Error("Access FK contract gate requires the exact version 16 target migration");
  }

  const identity = await client.query<{
    database_name: string;
    database_now: string | Date;
    current_version: number | string;
    migration_name: string;
  }>(
    `select current_database() as database_name,
            clock_timestamp() as database_now,
            current_version,
            migration_name
       from pulso_iris.schema_version
      where service_name = 'pulso'`
  );
  const row = identity.rows[0];
  if (!row || identity.rows.length !== 1) {
    throw new Error("Access FK contract gate could not resolve the PULSO database identity and schema marker");
  }
  const databaseNow = new Date(row.database_now).getTime();
  const capturedAt = Date.parse(receipt.capturedAt);
  const age = databaseNow - capturedAt;
  if (
    !Number.isFinite(databaseNow) ||
    age > ACCESS_FK_RECEIPT_MAX_AGE_MS ||
    age < -ACCESS_FK_RECEIPT_MAX_FUTURE_SKEW_MS
  ) {
    throw new Error("Access FK contract receipt is stale or implausibly future-dated");
  }

  const expectedPairs: ReadonlyArray<readonly [string, string | number]> = [
    ["deploymentId", deploymentId],
    ["environment", environment],
    ["pulsoDatabase", row.database_name],
    ["accessDatabase", accessDatabase],
    ["sourceRevision", sourceRevision],
    ["migrationSetSha256", migrationSetSha256],
    ["observedSchemaVersion", Number(row.current_version)],
    ["observedMigration", row.migration_name],
    ["targetVersion", context.targetVersion],
    ["targetMigration", context.targetMigration]
  ];
  for (const [key, expected] of expectedPairs) {
    const actual = receipt[key as keyof AccessFkContractReceipt];
    if (actual !== expected) {
      throw new Error(`Access FK contract receipt ${key} binding mismatch`);
    }
  }
}

function requiredBinding(env: NodeJS.ProcessEnv, name: string, pattern: RegExp): string {
  const value = env[name]?.trim();
  if (!value || !pattern.test(value)) throw new Error(`${name} is required and invalid`);
  return value;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Access FK contract receipt ${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length !== normalizedExpected.length || actual.some((key, index) => key !== normalizedExpected[index])) {
    throw new Error(`Access FK contract receipt ${label} has unexpected or missing keys`);
  }
}

function assertReceiptCoversAllConsumers(receipt: AccessFkContractReceipt): void {
  assertExactKeys(receipt.consumers as unknown as Record<string, unknown>, ACCESS_FK_CONTRACT_CONSUMERS, "consumers");
  for (const consumer of ACCESS_FK_CONTRACT_CONSUMERS) {
    const parity = receipt.consumers?.[consumer];
    if (!parity) {
      throw new Error(`Access FK contract receipt missing consumer parity for ${consumer}`);
    }
    assertParityIsComplete(consumer, parity);
  }
}

function assertParityIsComplete(consumer: AccessFkContractConsumer, parity: AccessFkConsumerParity): void {
  assertExactKeys(
    parity as unknown as Record<string, unknown>,
    [
      "coverageBasisPoints",
      "currentEventIdMismatches",
      "destinationTenants",
      "expectedTenants",
      "extraTenants",
      "matchedTenants",
      "missingTenants",
      "pendingOrDeadLetterEvents",
      "referencedTenantIdsMissingSnapshot",
      "sourceVersionConflicts",
      "sourceVersionMismatches",
      "statusMismatches"
    ],
    `consumers.${consumer}`
  );
  for (const [key, value] of Object.entries(parity)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Access FK contract receipt ${consumer}.${key} must be a non-negative safe integer`);
    }
  }
  const requiredZeroKeys: Array<keyof AccessFkConsumerParity> = [
    "missingTenants",
    "extraTenants",
    "statusMismatches",
    "sourceVersionMismatches",
    "currentEventIdMismatches",
    "referencedTenantIdsMissingSnapshot",
    "pendingOrDeadLetterEvents",
    "sourceVersionConflicts"
  ];
  for (const key of requiredZeroKeys) {
    if (parity[key] !== 0) {
      throw new Error(`Access FK contract receipt ${consumer}.${key} must be 0, got ${String(parity[key])}`);
    }
  }
  if (parity.coverageBasisPoints !== 10_000) {
    throw new Error(
      `Access FK contract receipt ${consumer}.coverageBasisPoints must be 10000, got ${parity.coverageBasisPoints}`
    );
  }
  if (parity.expectedTenants < 1) {
    throw new Error(`Access FK contract receipt ${consumer}.expectedTenants must be >= 1 when operational data exists`);
  }
  if (parity.matchedTenants !== parity.expectedTenants || parity.destinationTenants !== parity.expectedTenants) {
    throw new Error(`Access FK contract receipt ${consumer} tenant counts are not fully matched`);
  }
}

export function sealAccessFkContractReceipt(
  receipt: Omit<AccessFkContractReceipt, "receiptSha256">
): AccessFkContractReceipt {
  const digest = sha256CanonicalJson(receipt);
  return Object.freeze({ ...receipt, receiptSha256: digest });
}

export function emptyAccessFkConsumerParity(expectedTenants = 0): AccessFkConsumerParity {
  if (expectedTenants === 0) return ZERO_PARITY;
  return Object.freeze({
    ...ZERO_PARITY,
    expectedTenants,
    destinationTenants: expectedTenants,
    matchedTenants: expectedTenants,
    coverageBasisPoints: 10_000
  });
}

function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}
