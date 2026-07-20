import { describe, expect, it } from "vitest";
import {
  ACCESS_FK_CONTRACT_MIGRATIONS,
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
      throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`);
    }
  };
}

describe("access FK contract gate", () => {
  it("recognizes only 009-013 contract migrations", () => {
    expect(isAccessFkContractMigration(ACCESS_FK_CONTRACT_MIGRATIONS[0])).toBe(true);
    expect(isAccessFkContractMigration("008-access-knowledge-tenant-projection.sql")).toBe(false);
  });

  it("allows greenfield cutover without a receipt", async () => {
    await expect(
      assertAccessFkContractParity(clientWithCounts({}), {
        migrationName: ACCESS_FK_CONTRACT_MIGRATIONS[0]
      })
    ).resolves.toBeUndefined();
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
      schemaVersion: 1,
      tipVersion: 15,
      tipMigration: "015-revoke-sofia-pulso-iris-control-plane-grants.sql",
      contracts: ACCESS_FK_CONTRACT_MIGRATIONS,
      consumers: {
        channel: emptyAccessFkConsumerParity(3),
        iris: emptyAccessFkConsumerParity(3),
        sofia: emptyAccessFkConsumerParity(3),
        integration: emptyAccessFkConsumerParity(3),
        knowledge: emptyAccessFkConsumerParity(3)
      },
      capturedAt: "2026-07-20T00:00:00.000Z",
      status: "provisional-until-harness"
    };
    const sealed = sealAccessFkContractReceipt(unsigned);
    expect(sealed.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sealAccessFkContractReceipt(unsigned).receiptSha256).toBe(sealed.receiptSha256);
  });
});
