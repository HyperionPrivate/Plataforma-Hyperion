import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeNovaMigrationChecksum, runNovaMigrationsWithClient } from "./runner.js";
import { NOVA_PROVIDER_LEDGER, NOVA_PROVIDER_TABLES } from "./schema-manifest.js";

describe("NOVA-owned migration set", () => {
  it("contains only NOVA-cell schemas and no platform product write", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const contents = await Promise.all(
      files.map((file) => readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"))
    );
    const sql = contents.join("\n").toLowerCase();

    expect(files).toEqual([
      "047-nova-autonomy.sql",
      "048-nova-correlation-and-domain.sql",
      "049-nova-ui-meta-contactos.sql",
      "050-nova-lead-product-line.sql",
      "051-liwa-accepted-pending.sql",
      "052-nova-conversation-messages.sql",
      "053-nova-tenant-owned-routing.sql",
      "054-nova-voice-orchestration-policy.sql",
      "055-nova-voice-policy-approval-and-exclusions.sql",
      "056-nova-legacy-audit-outbox-envelope.sql",
      "057-nova-agency-scoped-analytics.sql"
    ]);
    expect(sql).not.toContain("platform.products");
    expect(contents.every((content) => /^[a-f0-9]{64}$/.test(computeNovaMigrationChecksum(content)))).toBe(true);
    expect(files.map((name, index) => ({ name, checksum: computeNovaMigrationChecksum(contents[index]!) }))).toEqual(
      NOVA_PROVIDER_LEDGER
    );
  });

  it("adds agency analytics without mutating the tenant-wide read model contract", async () => {
    const sql = await readFile(new URL("../sql/057-nova-agency-scoped-analytics.sql", import.meta.url), "utf8");
    const normalized = sql.toLowerCase();

    expect(normalized).toContain("create table if not exists nova.analytics_daily_by_agency");
    expect(normalized).toContain("create table if not exists nova.analytics_agency_coverage");
    expect(normalized).toContain("'__unattributed__'");
    expect(normalized).toContain("__unattributed__ is reserved for non-assignable analytics history");
    expect(normalized).toContain("agencies_reserved_analytics_bucket_check");
    expect(normalized).toContain("operator_grants_reserved_analytics_bucket_check");
    expect(normalized).toContain("create or replace function nova.backfill_agency_analytics_unattributed");
    expect(normalized).toContain("select nova.backfill_agency_analytics_unattributed(null)");
    expect(normalized).toContain("insert into nova.service_migrations(version, name)");
    expect(normalized).toContain("values (10, '057-nova-agency-scoped-analytics.sql')");
    expect(normalized).toContain("set current_version = 10");
    expect(normalized).not.toContain("alter table nova.analytics_daily");
    expect(normalized).not.toContain("drop table");
    expect(NOVA_PROVIDER_TABLES).toContain("nova.analytics_daily");
    expect(NOVA_PROVIDER_TABLES).toContain("nova.analytics_daily_by_agency");
    expect(NOVA_PROVIDER_TABLES).toContain("nova.analytics_agency_coverage");
  });

  it("adopts provider ledgers from an already-applied global deployment", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const historical = [
      "047-nova-autonomy.sql",
      "048-nova-correlation-and-domain.sql",
      "049-nova-ui-meta-contactos.sql",
      "050-nova-lead-product-line.sql",
      "051-liwa-accepted-pending.sql",
      "052-nova-conversation-messages.sql"
    ];
    const query = async (sql: string, values?: unknown[]) => {
      if (sql === "select name, checksum from nova.migration_ledger") return { rows: [] };
      if (sql === "select to_regclass($1) as table_name") return { rows: [{ table_name: values?.[0] }] };
      if (/select name from (nova|voice|liwa|documents)\.service_migrations/.test(sql)) {
        return { rows: historical.map((name) => ({ name })) };
      }
      return { rows: [] };
    };

    const result = await runNovaMigrationsWithClient({ query } as never, sqlDirectory);

    expect(result.adopted).toEqual(historical);
    expect(result.applied).toEqual([
      "053-nova-tenant-owned-routing.sql",
      "054-nova-voice-orchestration-policy.sql",
      "055-nova-voice-policy-approval-and-exclusions.sql",
      "056-nova-legacy-audit-outbox-envelope.sql",
      "057-nova-agency-scoped-analytics.sql"
    ]);
  });

  it("rejects an unmanifested migration before opening a transaction", async () => {
    const sqlDirectory = await mkdtemp(path.join(tmpdir(), "nova-migrations-policy-"));
    const statements: string[] = [];
    const unsafeSql = "create table platform.nova_escape(id uuid);";
    await writeFile(path.join(sqlDirectory, "999-cross-cell.sql"), unsafeSql, "utf8");

    try {
      const query = async (sql: string) => {
        statements.push(sql);
        if (sql === "select name, checksum from nova.migration_ledger") return { rows: [] };
        if (sql === "select to_regclass($1) as table_name") return { rows: [{ table_name: null }] };
        return { rows: [] };
      };

      await expect(runNovaMigrationsWithClient({ query } as never, sqlDirectory)).rejects.toThrow(
        "NOVA migration inventory does not match the provider manifest"
      );
      expect(statements).not.toContain("begin");
      expect(statements).not.toContain(unsafeSql);
    } finally {
      await rm(sqlDirectory, { recursive: true, force: true });
    }
  });
});
