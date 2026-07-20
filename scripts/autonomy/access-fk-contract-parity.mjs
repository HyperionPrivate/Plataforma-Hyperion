#!/usr/bin/env node
/**
 * Multi-consumer Access FK contract parity helpers (DEBT-005).
 *
 * Opt-in Docker acceptance that fans out Access tenant snapshots to Channel,
 * Iris, SOFIA, Integration and Knowledge and seals a receipt suitable for
 * PULSO_ACCESS_FK_CONTRACT_RECEIPT + PULSO_ACCESS_FK_CONTRACT_RECEIPT_SHA256.
 *
 * Usage (opt-in):
 *   RUN_ACCESS_FK_CONTRACT_ACCEPTANCE=1 node scripts/autonomy/access-fk-contract-parity.mjs \
 *     --receipt docs/evidence/access-fk-contract-parity-live.json
 *
 * Until that harness is run against disposable Docker, the checked-in stub at
 * docs/evidence/access-fk-contract-parity-20260720.json remains provisional and
 * must not be used as a cutover receipt.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ACCESS_FK_CONTRACT_MIGRATIONS = Object.freeze([
  "009-contract-channel-access-tenant-fks.sql",
  "010-contract-integration-access-tenant-fks.sql",
  "011-contract-sofia-access-tenant-fks.sql",
  "012-contract-iris-access-tenant-fks.sql",
  "013-contract-knowledge-access-tenant-fks.sql"
]);

export const ACCESS_FK_CONTRACT_CONSUMERS = Object.freeze([
  {
    id: "channel",
    snapshotSchema: "channel_runtime",
    inboxTable: "channel_runtime.access_projection_inbox",
    operationalTables: [
      "channel_runtime.connections",
      "channel_runtime.delivery_receipts",
      "channel_runtime.inbound_events",
      "channel_runtime.outbound_messages",
      "channel_runtime.thread_bindings"
    ],
    serviceHost: "whatsapp-channel-service",
    tokenEnv: "ACCESS_TO_CHANNEL_TOKEN"
  },
  {
    id: "iris",
    snapshotSchema: "pulso_iris",
    inboxTable: "pulso_iris.access_projection_inbox",
    operationalTables: [
      "pulso_iris.administrative_patients",
      "pulso_iris.appointments",
      "pulso_iris.conversations",
      "pulso_iris.sites",
      "pulso_iris.professionals"
    ],
    serviceHost: "pulso-iris-service",
    tokenEnv: "ACCESS_TO_PULSO_TOKEN"
  },
  {
    id: "sofia",
    snapshotSchema: "agent_runtime",
    inboxTable: "agent_runtime.access_projection_inbox",
    operationalTables: [
      "agent_runtime.executions",
      "agent_runtime.jobs",
      "agent_runtime.inbox_events",
      "agent_runtime.outbox_events"
    ],
    serviceHost: "agent-service",
    tokenEnv: "ACCESS_TO_SOFIA_TOKEN"
  },
  {
    id: "integration",
    snapshotSchema: "integration_runtime",
    inboxTable: "integration_runtime.access_projection_inbox",
    operationalTables: [],
    serviceHost: "integration-service",
    tokenEnv: "ACCESS_TO_INTEGRATION_TOKEN"
  },
  {
    id: "knowledge",
    snapshotSchema: "knowledge_runtime",
    inboxTable: "knowledge_runtime.access_projection_inbox",
    operationalTables: [],
    serviceHost: "knowledge-service",
    tokenEnv: "ACCESS_TO_KNOWLEDGE_TOKEN"
  }
]);

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function sealAccessFkContractReceipt(receipt) {
  const { receiptSha256: _ignored, ...unsigned } = receipt;
  const receiptSha256 = createHash("sha256").update(canonicalJson(unsigned)).digest("hex");
  return Object.freeze({ ...unsigned, receiptSha256 });
}

/**
 * Measure Access→consumer parity using the same basis-point rules as the
 * Channel acceptance harness (coverageBasisPoints = matched * 10000 / expected).
 */
export async function measureConsumerParity(accessDb, consumerDb, consumer) {
  const access = await accessDb.query(
    `select tenant.id as "tenantId", tenant.status,
            state.source_version::text as "sourceVersion",
            outbox.id as "eventId"
       from platform.tenants tenant
       join access_runtime.tenant_projection_state state on state.tenant_id = tenant.id
       join access_runtime.tenant_projection_outbox outbox
         on outbox.tenant_id = tenant.id and outbox.source_version = state.source_version
      where not exists (
              select 1 from access_runtime.bootstrap_tenants bootstrap
               where bootstrap.tenant_id = tenant.id
            )
      order by tenant.id`
  );
  const destination = await consumerDb.query(
    `select snapshot.tenant_id as "tenantId", snapshot.status,
            snapshot.source_version::text as "sourceVersion",
            snapshot.source_event_id as "eventId"
       from ${consumer.snapshotSchema}.tenant_snapshots snapshot
      order by snapshot.tenant_id`
  );

  const destinationById = new Map(destination.rows.map((row) => [row.tenantId, row]));
  let matchedTenants = 0;
  let statusMismatches = 0;
  let sourceVersionMismatches = 0;
  let currentEventIdMismatches = 0;
  const missingTenants = [];
  for (const row of access.rows) {
    const peer = destinationById.get(row.tenantId);
    if (!peer) {
      missingTenants.push(row.tenantId);
      continue;
    }
    matchedTenants += 1;
    if (peer.status !== row.status) statusMismatches += 1;
    if (String(peer.sourceVersion) !== String(row.sourceVersion)) sourceVersionMismatches += 1;
    if (peer.eventId !== row.eventId) currentEventIdMismatches += 1;
  }
  const accessIds = new Set(access.rows.map((row) => row.tenantId));
  const extraTenants = destination.rows.filter((row) => !accessIds.has(row.tenantId)).map((row) => row.tenantId);

  let referencedTenantIds = 0;
  let referencedTenantIdsMissingSnapshot = 0;
  if (consumer.operationalTables.length > 0) {
    const unionSql = consumer.operationalTables.map((table) => `select tenant_id from ${table}`).join("\n union\n ");
    const references = await consumerDb.query(
      `with referenced as (
         ${unionSql}
       )
       select count(*)::int as "referencedTenantIds",
              count(*) filter (where snapshot.tenant_id is null)::int as "missing"
         from referenced
         left join ${consumer.snapshotSchema}.tenant_snapshots snapshot using (tenant_id)`
    );
    referencedTenantIds = references.rows[0].referencedTenantIds;
    referencedTenantIdsMissingSnapshot = references.rows[0].missing;
  }

  const pending = await accessDb.query(
    "select count(*)::int as count from access_runtime.tenant_projection_outbox where status <> 'published'"
  );
  const conflicts = await consumerDb.query(
    `select count(*)::int as count
       from ${consumer.inboxTable}
      where result->>'status' = 'conflict' and result->>'reason' = 'source_version'`
  );

  return {
    expectedTenants: access.rows.length,
    destinationTenants: destination.rows.length,
    matchedTenants,
    coverageBasisPoints: access.rows.length === 0 ? 0 : Math.floor((matchedTenants * 10_000) / access.rows.length),
    missingTenants: missingTenants.length,
    extraTenants: extraTenants.length,
    statusMismatches,
    sourceVersionMismatches,
    currentEventIdMismatches,
    referencedTenantIds,
    referencedTenantIdsMissingSnapshot,
    pendingOrDeadLetterEvents: pending.rows[0].count,
    sourceVersionConflicts: conflicts.rows[0].count
  };
}

export function assertConsumerParityComplete(consumerId, parity) {
  const zeroKeys = [
    "missingTenants",
    "extraTenants",
    "statusMismatches",
    "sourceVersionMismatches",
    "currentEventIdMismatches",
    "referencedTenantIdsMissingSnapshot",
    "pendingOrDeadLetterEvents",
    "sourceVersionConflicts"
  ];
  for (const key of zeroKeys) {
    if (parity[key] !== 0) {
      throw new Error(`${consumerId}.${key} must be 0, got ${parity[key]}`);
    }
  }
  if (parity.coverageBasisPoints !== 10_000) {
    throw new Error(`${consumerId}.coverageBasisPoints must be 10000, got ${parity.coverageBasisPoints}`);
  }
  if (parity.expectedTenants < 1) {
    throw new Error(`${consumerId}.expectedTenants must be >= 1`);
  }
  if (parity.matchedTenants !== parity.expectedTenants || parity.destinationTenants !== parity.expectedTenants) {
    throw new Error(`${consumerId} tenant counts are not fully matched`);
  }
}

export function buildAccessFkContractReceipt(consumersParity, options = {}) {
  return sealAccessFkContractReceipt({
    kind: "access-fk-contract-parity",
    schemaVersion: 1,
    tipVersion: 15,
    tipMigration: "015-revoke-sofia-pulso-iris-control-plane-grants.sql",
    contracts: [...ACCESS_FK_CONTRACT_MIGRATIONS],
    consumers: consumersParity,
    status: options.status ?? "verified",
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    related: "docs/evidence/access-channel-projection-parity-20260719.json"
  });
}

async function main(argv = process.argv.slice(2)) {
  if (process.env.RUN_ACCESS_FK_CONTRACT_ACCEPTANCE !== "1") {
    throw new Error(
      "Set RUN_ACCESS_FK_CONTRACT_ACCEPTANCE=1 to run the disposable multi-consumer Access FK acceptance. " +
        "Until then use scripts/autonomy/access-fk-contract-parity.test.mjs for the provisional stub shape."
    );
  }

  // Full Docker orchestration reuses the Channel acceptance stack pattern.
  // Operators should extend access-channel-projection.e2e.mjs fan-out to all five
  // consumers, call measureConsumerParity per consumer, then seal via
  // buildAccessFkContractReceipt. This entrypoint refuses silent success.
  const receiptIndex = argv.indexOf("--receipt");
  const receiptPath =
    receiptIndex >= 0
      ? path.resolve(argv[receiptIndex + 1] ?? "")
      : path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../docs/evidence/access-fk-contract-parity-live.json"
        );

  throw new Error(
    `Multi-consumer Docker acceptance is wired for measure/seal helpers but must be driven from an extended Channel harness. ` +
      `Helpers are ready (measureConsumerParity / buildAccessFkContractReceipt). Target receipt path: ${receiptPath}`
  );
}

const invokedAsCli =
  Boolean(process.argv[1]) && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (invokedAsCli) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
