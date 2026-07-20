import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertPulsoProviderMigrationNames, computePulsoMigrationChecksum } from "./runner.js";

describe("PULSO provider-owned migration set", () => {
  it("contains exactly the terminal PULSO closure and no sibling product schema", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const contents = await Promise.all(
      files.map((file) => readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"))
    );
    const baseline = contents[0]!.toLowerCase();

    expect(files).toEqual([
      "001-pulso-autonomous-baseline.sql",
      "002-pulso-runtime-roles.sql",
      "003-sofia-readiness-marker.sql",
      "004-access-channel-tenant-projection.sql",
      "005-access-iris-tenant-projection.sql",
      "006-access-sofia-tenant-projection.sql",
      "007-access-integration-tenant-projection.sql"
    ]);
    expect(baseline.match(/^create schema /gm) ?? []).toHaveLength(4);
    expect(baseline.match(/^create table /gm) ?? []).toHaveLength(53);
    expect(baseline.match(/^create function /gm) ?? []).toHaveLength(19);
    expect(baseline).toContain("create schema if not exists pulso_iris");
    expect(baseline).toContain("create schema if not exists agent_runtime");
    expect(baseline).toContain("create schema if not exists channel_runtime");
    expect(baseline).not.toMatch(/create schema (?:nova|voice|liwa|documents|lumen|audit_runtime|identity)/);
    expect(baseline).not.toMatch(
      /create table platform\.(?:operators|operator_sessions|operator_tenants|audit_events|schema_migrations)/
    );
    expect(baseline).not.toMatch(/clinical_records|dictations|audio_cleanup|lumen\./);
    expect(contents.every((content) => /^[a-f0-9]{64}$/.test(computePulsoMigrationChecksum(content)))).toBe(true);
  });

  it("grants readiness to every runtime while keeping provider ledgers admin-only", async () => {
    const sql = await readFile(new URL("../sql/002-pulso-runtime-roles.sql", import.meta.url), "utf8");
    for (const role of [
      "hyperion_pulso",
      "hyperion_sofia",
      "hyperion_knowledge",
      "hyperion_integration",
      "hyperion_channel"
    ]) {
      expect(sql).toContain(role);
    }
    expect(sql).toMatch(/grant select on table pulso_iris\.schema_version to[\s\S]*hyperion_channel/i);
    expect(sql).toMatch(/revoke all privileges on table[\s\S]*pulso_iris\.migration_ledger[\s\S]*from hyperion_pulso/i);
    expect(sql).not.toMatch(/grant (?:insert|update|delete)[^;]*pulso_iris\.schema_version/i);
  });

  it("adds an owner-local SOFIA readiness marker without revoking the N-1 global marker", async () => {
    const sql = await readFile(new URL("../sql/003-sofia-readiness-marker.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/create table agent_runtime\.schema_version/i);
    expect(sql).not.toMatch(/create table if not exists agent_runtime\.schema_version/i);
    expect(sql).toMatch(/grant select on table agent_runtime\.schema_version to hyperion_sofia/i);
    expect(sql).not.toMatch(/grant (?:insert|update|delete)[^;]*agent_runtime\.schema_version/i);
    expect(sql).not.toMatch(/revoke[^;]*pulso_iris\.schema_version[^;]*hyperion_sofia/i);
  });

  it("adds a Channel-owned tenant projection without a foreign key to Access", async () => {
    const sql = await readFile(new URL("../sql/004-access-channel-tenant-projection.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/create table channel_runtime\.tenant_snapshots/i);
    expect(sql).toMatch(/create table channel_runtime\.access_projection_inbox/i);
    expect(sql).not.toMatch(/references\s+platform\.tenants/i);
    expect(sql).toMatch(/grant select, insert, update on table[\s\S]*to hyperion_channel/i);
    expect(sql).not.toMatch(/grant delete[^;]*(?:tenant_snapshots|access_projection_inbox)/i);
  });

  it("adds an Iris-owned tenant projection without a foreign key to Access", async () => {
    const sql = await readFile(new URL("../sql/005-access-iris-tenant-projection.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/create table pulso_iris\.tenant_snapshots/i);
    expect(sql).toMatch(/create table pulso_iris\.access_projection_inbox/i);
    expect(sql).not.toMatch(/references\s+platform\.tenants/i);
    expect(sql).toMatch(/grant select, insert, update on table[\s\S]*to hyperion_pulso/i);
    expect(sql).not.toMatch(/grant delete[^;]*(?:tenant_snapshots|access_projection_inbox)/i);
  });

  it("adds a SOFIA-owned tenant projection without a foreign key to Access", async () => {
    const sql = await readFile(new URL("../sql/006-access-sofia-tenant-projection.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/create table agent_runtime\.tenant_snapshots/i);
    expect(sql).toMatch(/create table agent_runtime\.access_projection_inbox/i);
    expect(sql).not.toMatch(/references\s+platform\.tenants/i);
    expect(sql).toMatch(/grant select, insert, update on table[\s\S]*to hyperion_sofia/i);
    expect(sql).not.toMatch(/grant delete[^;]*(?:tenant_snapshots|access_projection_inbox)/i);
  });

  it("adds an Integration-owned tenant projection without a foreign key to Access", async () => {
    const sql = await readFile(new URL("../sql/007-access-integration-tenant-projection.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/create schema if not exists integration_runtime/i);
    expect(sql).toMatch(/create table integration_runtime\.tenant_snapshots/i);
    expect(sql).toMatch(/create table integration_runtime\.access_projection_inbox/i);
    expect(sql).not.toMatch(/references\s+platform\.tenants/i);
    expect(sql).toMatch(/grant select, insert, update on table[\s\S]*to hyperion_integration/i);
    expect(sql).not.toMatch(/grant delete[^;]*(?:tenant_snapshots|access_projection_inbox)/i);
  });

  it("rejects missing, renamed, reordered or foreign migration files", () => {
    const exact = [
      "001-pulso-autonomous-baseline.sql",
      "002-pulso-runtime-roles.sql",
      "003-sofia-readiness-marker.sql",
      "004-access-channel-tenant-projection.sql",
      "005-access-iris-tenant-projection.sql",
      "006-access-sofia-tenant-projection.sql",
      "007-access-integration-tenant-projection.sql"
    ];
    expect(() => assertPulsoProviderMigrationNames(exact)).not.toThrow();
    expect(() => assertPulsoProviderMigrationNames(exact.slice(0, 1))).toThrow("migration set mismatch");
    expect(() => assertPulsoProviderMigrationNames([...exact].reverse())).toThrow("migration set mismatch");
    expect(() => assertPulsoProviderMigrationNames([...exact, "003-foreign.sql"])).toThrow("migration set mismatch");
  });
});
