import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCESS_FK_CONTRACT_MIGRATIONS,
  ACCESS_FK_PRODUCT_REFERENCE,
  CONSUMER_OPERATIONAL_TABLES,
  assertAccessFkContractParity,
  emptyAccessFkConsumerParity,
  isAccessFkContractMigration,
  sealAccessFkContractReceipt,
  type AccessFkContractReceipt
} from "./access-fk-contract-gate.js";
import type { PulsoSchemaClient } from "./schema-manifest.js";

function clientWithCounts(options: {
  snapshotCounts?: Record<string, number>;
  referenced?: number;
  missing?: number;
  databaseNow?: string;
}): PulsoSchemaClient {
  const snapshotCounts = options.snapshotCounts ?? {};
  return {
    async query<T>(sql: string) {
      if (sql.includes("tenant_snapshots") && sql.includes("count(*)") && !sql.includes("referenced")) {
        const schema = [
          "channel_runtime",
          "pulso_iris",
          "agent_runtime",
          "integration_runtime",
          "knowledge_runtime"
        ].find((name) => sql.includes(`${name}.tenant_snapshots`));
        return { rows: [{ count: snapshotCounts[schema ?? ""] ?? 0 }] as T[] };
      }
      if (sql.includes("with referenced as")) {
        return {
          rows: [{ referenced: options.referenced ?? 0, missing: options.missing ?? 0 }] as T[]
        };
      }
      if (sql.includes("source.product_id")) {
        return { rows: [{ referenced: 0, missing: 0 }] as T[] };
      }
      if (sql.includes("current_database() as database_name")) {
        return {
          rows: [
            {
              database_name: "hyperion_pulso",
              database_now: options.databaseNow ?? "2026-07-20T12:10:00.000Z",
              current_version: 15,
              migration_name: "015-revoke-sofia-pulso-iris-control-plane-grants.sql"
            }
          ] as T[]
        };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }
  };
}

describe("access FK contract gate", () => {
  it("recognizes only 009-013 contract migrations", () => {
    expect(isAccessFkContractMigration(ACCESS_FK_CONTRACT_MIGRATIONS[0])).toBe(true);
    expect(isAccessFkContractMigration("008-access-knowledge-tenant-projection.sql")).toBe(false);
  });

  it("catalogs every tenant and product FK dropped by 009-013", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const sources = await Promise.all(
      ACCESS_FK_CONTRACT_MIGRATIONS.map((name) => readFile(`${sqlDirectory}${name}`, "utf8"))
    );
    const droppedTenantTables = new Set<string>();
    let droppedProductTable: string | undefined;
    for (const source of sources) {
      const statements = source.matchAll(
        /ALTER TABLE\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s+DROP CONSTRAINT IF EXISTS\s+([a-z_][a-z0-9_]*);/gi
      );
      for (const [, table, constraint] of statements) {
        if (constraint?.endsWith("_tenant_id_fkey")) droppedTenantTables.add(table!);
        if (constraint?.endsWith("_product_id_fkey")) droppedProductTable = table;
      }
    }
    const catalogedTenantTables = CONSUMER_OPERATIONAL_TABLES.flatMap((entry) => entry.operationalTables).sort();
    expect(catalogedTenantTables).toEqual([...droppedTenantTables].sort());
    expect(catalogedTenantTables).toHaveLength(36);
    expect(droppedProductTable).toBe(ACCESS_FK_PRODUCT_REFERENCE.sourceTable);
  });

  it("allows greenfield cutover without a receipt", async () => {
    await expect(
      assertAccessFkContractParity(clientWithCounts({}), {
        migrationName: ACCESS_FK_CONTRACT_MIGRATIONS[0]
      })
    ).resolves.toEqual({ mode: "greenfield" });
  });

  it("refuses orphan operational tenant ids", async () => {
    await expect(
      assertAccessFkContractParity(clientWithCounts({ referenced: 2, missing: 1 }), {
        migrationName: ACCESS_FK_CONTRACT_MIGRATIONS[0]
      })
    ).rejects.toThrow(/lack a local Access snapshot/);
  });

  it("refuses operational data without a receipt env", async () => {
    await expect(
      assertAccessFkContractParity(clientWithCounts({ snapshotCounts: { channel_runtime: 3 } }), {
        migrationName: ACCESS_FK_CONTRACT_MIGRATIONS[0],
        env: {}
      })
    ).rejects.toThrow(/PULSO_ACCESS_FK_CONTRACT_RECEIPT is unset/);
  });

  it("seals a receipt with stable canonical SHA-256", () => {
    const unsigned: Omit<AccessFkContractReceipt, "receiptSha256"> = {
      kind: "access-fk-contract-parity",
      schemaVersion: 2,
      status: "verified",
      capturedAt: "2026-07-20T00:00:00.000Z",
      deploymentId: "pulso-production-20260720",
      environment: "production",
      pulsoDatabase: "hyperion_pulso",
      accessDatabase: "hyperion_access",
      sourceRevision: "a".repeat(40),
      migrationSetSha256: "b".repeat(64),
      observedSchemaVersion: 15,
      observedMigration: "015-revoke-sofia-pulso-iris-control-plane-grants.sql",
      targetVersion: 16,
      targetMigration: "016-attest-access-fk-contract.sql",
      contracts: ACCESS_FK_CONTRACT_MIGRATIONS,
      consumers: {
        channel: emptyAccessFkConsumerParity(3),
        iris: emptyAccessFkConsumerParity(3),
        sofia: emptyAccessFkConsumerParity(3),
        integration: emptyAccessFkConsumerParity(3),
        knowledge: emptyAccessFkConsumerParity(3)
      }
    };
    const sealed = sealAccessFkContractReceipt(unsigned);
    expect(sealed.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sealAccessFkContractReceipt(unsigned).receiptSha256).toBe(sealed.receiptSha256);
  });

  it("accepts only a fresh receipt bound to the exact deployment, databases, revision and migration set", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pulso-access-fk-receipt-"));
    try {
      const receipt = sealAccessFkContractReceipt({
        kind: "access-fk-contract-parity",
        schemaVersion: 2,
        status: "verified",
        capturedAt: "2026-07-20T12:00:00.000Z",
        deploymentId: "pulso-staging-20260720",
        environment: "staging",
        pulsoDatabase: "hyperion_pulso",
        accessDatabase: "hyperion_access",
        sourceRevision: "a".repeat(40),
        migrationSetSha256: "b".repeat(64),
        observedSchemaVersion: 15,
        observedMigration: "015-revoke-sofia-pulso-iris-control-plane-grants.sql",
        targetVersion: 16,
        targetMigration: "016-attest-access-fk-contract.sql",
        contracts: ACCESS_FK_CONTRACT_MIGRATIONS,
        consumers: {
          channel: emptyAccessFkConsumerParity(3),
          iris: emptyAccessFkConsumerParity(3),
          sofia: emptyAccessFkConsumerParity(3),
          integration: emptyAccessFkConsumerParity(3),
          knowledge: emptyAccessFkConsumerParity(3)
        }
      });
      const receiptPath = path.join(directory, "receipt.json");
      await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
      const env = {
        PULSO_ACCESS_FK_CONTRACT_RECEIPT: receiptPath,
        PULSO_ACCESS_FK_CONTRACT_RECEIPT_SHA256: receipt.receiptSha256,
        PULSO_ACCESS_FK_CONTRACT_DEPLOYMENT_ID: receipt.deploymentId,
        PULSO_ACCESS_FK_CONTRACT_ACCESS_DATABASE: receipt.accessDatabase,
        PULSO_RELEASE_SOURCE_REVISION: receipt.sourceRevision,
        HYPERION_ENVIRONMENT: receipt.environment
      };
      const context = {
        migrationName: ACCESS_FK_CONTRACT_MIGRATIONS[0],
        migrationSetSha256: receipt.migrationSetSha256,
        targetMigration: receipt.targetMigration,
        targetVersion: receipt.targetVersion,
        env
      };
      await expect(
        assertAccessFkContractParity(clientWithCounts({ snapshotCounts: { channel_runtime: 3 } }), context)
      ).resolves.toEqual({ mode: "receipt", receipt });
      await expect(
        assertAccessFkContractParity(
          clientWithCounts({
            snapshotCounts: { channel_runtime: 3 },
            databaseNow: "2026-07-20T12:31:00.001Z"
          }),
          context
        )
      ).rejects.toThrow(/stale/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
