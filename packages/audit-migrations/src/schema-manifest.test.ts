import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AUDIT_PROVIDER_LEDGER,
  AUDIT_PROVIDER_MIGRATIONS,
  AUDIT_RUNTIME_MIGRATION_REQUIREMENT,
  AUDIT_SOURCE_CONTRACTS
} from "./schema-manifest.js";

describe("Audit provider manifest", () => {
  it("pins readiness to the provider-owned audit_runtime ledger", () => {
    expect(AUDIT_RUNTIME_MIGRATION_REQUIREMENT).toEqual({
      schema: "audit_runtime",
      migrationNames: AUDIT_PROVIDER_MIGRATIONS,
      exactMigrationLedger: AUDIT_PROVIDER_LEDGER
    });
  });

  it("pins the exact provider ledger used by backup and restore verification", async () => {
    const sql = await readFile(new URL("../sql/001-audit-autonomous-baseline.sql", import.meta.url), "utf8");
    const { createHash } = await import("node:crypto");
    const checksum = createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");

    expect(AUDIT_PROVIDER_LEDGER).toEqual([{ name: "001-audit-autonomous-baseline.sql", checksum }]);
  });

  it("keeps every accepted source contract, including NOVA, in the baseline", async () => {
    const sql = await readFile(new URL("../sql/001-audit-autonomous-baseline.sql", import.meta.url), "utf8");

    for (const contract of AUDIT_SOURCE_CONTRACTS) {
      expect(sql).toContain(`source_service = '${contract.sourceService}'`);
      expect(sql).toContain(`event_type = '${contract.eventType}'`);
    }
    expect(sql).toContain("source_service = 'nova-core-service' AND event_type = 'nova.audit.event.record.v1'");
    expect(sql).not.toMatch(/REFERENCES\s+(?:platform\.tenants|nova\.|lumen\.|pulso_iris\.)/i);
  });
});
