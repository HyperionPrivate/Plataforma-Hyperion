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

interface ConsumerOperationalTables {
  readonly consumer: AccessFkContractConsumer;
  readonly snapshotSchema: string;
  readonly operationalTables: readonly string[];
}

const CONSUMER_OPERATIONAL_TABLES: readonly ConsumerOperationalTables[] = Object.freeze([
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
      "pulso_iris.appointments",
      "pulso_iris.conversations",
      "pulso_iris.sites",
      "pulso_iris.professionals"
    ])
  },
  {
    consumer: "sofia",
    snapshotSchema: "agent_runtime",
    operationalTables: Object.freeze([
      "agent_runtime.executions",
      "agent_runtime.jobs",
      "agent_runtime.inbox_events",
      "agent_runtime.outbox_events"
    ])
  },
  {
    consumer: "integration",
    snapshotSchema: "integration_runtime",
    // Integration has no pre-projection operational tenant tables beyond the
    // snapshot itself; count snapshot rows as the local data signal.
    operationalTables: Object.freeze([])
  },
  {
    consumer: "knowledge",
    snapshotSchema: "knowledge_runtime",
    operationalTables: Object.freeze([])
  }
]);

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
  readonly schemaVersion: 1;
  readonly tipVersion: 15;
  readonly tipMigration: string;
  readonly contracts: readonly string[];
  readonly consumers: Readonly<Record<AccessFkContractConsumer, AccessFkConsumerParity>>;
  readonly receiptSha256?: string;
  readonly capturedAt?: string;
  readonly status?: string;
}

export interface AccessFkContractGateContext {
  readonly migrationName: string;
  readonly env?: NodeJS.ProcessEnv;
}

export type AccessFkContractGate = (client: PulsoSchemaClient, context: AccessFkContractGateContext) => Promise<void>;

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
  return async () => undefined;
}

export function createDefaultAccessFkContractGate(): AccessFkContractGate {
  return async (client, context) => assertAccessFkContractParity(client, context);
}

export async function assertAccessFkContractParity(
  client: PulsoSchemaClient,
  context: AccessFkContractGateContext
): Promise<void> {
  if (!isAccessFkContractMigration(context.migrationName)) return;

  const local = await inspectLocalOperationalParity(client);
  if (local.orphanTenantIds > 0) {
    throw new Error(
      `Access FK contract ${context.migrationName} refused: ${local.orphanTenantIds} operational tenant_id(s) lack a local Access snapshot`
    );
  }

  if (local.hasOperationalData) {
    const receipt = await loadAndVerifyAccessFkContractReceipt(context.env ?? process.env);
    assertReceiptCoversAllConsumers(receipt);
    return;
  }

  // Greenfield: empty operational tables and empty snapshots — allow cutover.
}

interface LocalParityInspection {
  readonly hasOperationalData: boolean;
  readonly orphanTenantIds: number;
}

async function inspectLocalOperationalParity(client: PulsoSchemaClient): Promise<LocalParityInspection> {
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

  return { hasOperationalData, orphanTenantIds };
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
  if (!expectedSha || !/^[a-f0-9]{64}$/.test(expectedSha)) {
    throw new Error("Access FK contract refused: PULSO_ACCESS_FK_CONTRACT_RECEIPT_SHA256 must be a 64-char hex digest");
  }

  const raw = await readFile(receiptPath, "utf8");
  const parsed = JSON.parse(raw) as AccessFkContractReceipt;
  const { receiptSha256: _ignored, ...unsigned } = parsed;
  const digest = sha256CanonicalJson(unsigned);
  if (digest !== expectedSha) {
    throw new Error(`Access FK contract receipt SHA-256 mismatch: expected ${expectedSha}, got ${digest}`);
  }
  if (parsed.receiptSha256 && parsed.receiptSha256 !== digest) {
    throw new Error("Access FK contract receipt embeds a divergent receiptSha256");
  }
  assertReceiptShape(parsed);
  return parsed;
}

function assertReceiptShape(receipt: AccessFkContractReceipt): void {
  if (receipt.kind !== "access-fk-contract-parity") {
    throw new Error("Access FK contract receipt kind must be access-fk-contract-parity");
  }
  if (receipt.schemaVersion !== 1) {
    throw new Error("Access FK contract receipt schemaVersion must be 1");
  }
  if (receipt.tipVersion !== 15) {
    throw new Error("Access FK contract receipt tipVersion must be 15");
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

function assertReceiptCoversAllConsumers(receipt: AccessFkContractReceipt): void {
  for (const consumer of ACCESS_FK_CONTRACT_CONSUMERS) {
    const parity = receipt.consumers?.[consumer];
    if (!parity) {
      throw new Error(`Access FK contract receipt missing consumer parity for ${consumer}`);
    }
    assertParityIsComplete(consumer, parity);
  }
}

function assertParityIsComplete(consumer: AccessFkContractConsumer, parity: AccessFkConsumerParity): void {
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
