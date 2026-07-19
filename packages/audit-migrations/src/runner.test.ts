import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertAuditProviderMigrationNames,
  computeAuditMigrationChecksum,
  runAuditMigrationsWithClient
} from "./runner.js";
import { AUDIT_BASELINE_MIGRATION, AUDIT_SOURCE_CONTRACTS } from "./schema-manifest.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
const SOURCE_CONTRACT_DEFINITION = AUDIT_SOURCE_CONTRACTS.map(
  ({ sourceService, eventType }) => `${sourceService}:${eventType}`
).join(" ");

function createClient(initialState: "fresh" | "managed" | "drift") {
  let state = initialState;
  let checksum = "";
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("to_regclass('audit_runtime.migration_ledger')")) {
      return {
        rows: [
          {
            ledger_present: state === "managed",
            audit_events_present: state !== "fresh",
            inbox_present: state !== "fresh"
          }
        ]
      };
    }
    if (sql.includes("ck_audit_inbox_source_contract")) {
      return { rows: [{ definition: SOURCE_CONTRACT_DEFINITION, validated: true }] };
    }
    if (sql.startsWith("insert into audit_runtime.migration_ledger")) {
      checksum = String(values?.[1]);
      return { rows: [] };
    }
    if (sql === "commit" && initialState === "fresh") state = "managed";
    if (sql === "select name, checksum from audit_runtime.migration_ledger order by name") {
      if (!checksum) {
        const baseline = await readFile(new URL("../sql/001-audit-autonomous-baseline.sql", import.meta.url), "utf8");
        checksum = computeAuditMigrationChecksum(baseline);
      }
      return { rows: [{ name: AUDIT_BASELINE_MIGRATION, checksum }] };
    }
    return { rows: [] };
  });
  return { client: { query } as never, query };
}

describe("Audit provider-owned migration runner", () => {
  it("creates a fresh provider schema and records its checksum", async () => {
    const { client, query } = createClient("fresh");

    const result = await runAuditMigrationsWithClient(client, sqlDirectory);

    expect(result).toEqual({ applied: [AUDIT_BASELINE_MIGRATION], skipped: [] });
    expect(query).toHaveBeenCalledWith("insert into audit_runtime.migration_ledger(name, checksum) values ($1, $2)", [
      AUDIT_BASELINE_MIGRATION,
      expect.stringMatching(/^[a-f0-9]{64}$/)
    ]);
  });

  it("replays only when the exact provider ledger and source contract match", async () => {
    const { client } = createClient("managed");

    await expect(runAuditMigrationsWithClient(client, sqlDirectory)).resolves.toEqual({
      applied: [],
      skipped: [AUDIT_BASELINE_MIGRATION]
    });
  });

  it("refuses provider tables without a provider ledger", async () => {
    const { client, query } = createClient("drift");

    await expect(runAuditMigrationsWithClient(client, sqlDirectory)).rejects.toThrow(
      "provider objects without audit_runtime.migration_ledger"
    );
    expect(query.mock.calls.some(([sql]) => sql === "begin")).toBe(false);
  });

  it("pins the provider migration set", () => {
    expect(() => assertAuditProviderMigrationNames([AUDIT_BASELINE_MIGRATION])).not.toThrow();
    expect(() => assertAuditProviderMigrationNames([AUDIT_BASELINE_MIGRATION, "002-foreign.sql"])).toThrow(
      "migration set mismatch"
    );
  });
});
