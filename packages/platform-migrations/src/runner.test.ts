import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computePlatformMigrationChecksum } from "./runner.js";

describe("platform-owned migration set", () => {
  it("owns Access grants without importing product schemas or the legacy global ledger", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const contents = await Promise.all(
      files.map((file) => readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"))
    );
    const sql = contents.join("\n").toLowerCase();
    const executableIdentifiers = sql.replace(/--[^\n]*/g, "").replace(/'(?:''|[^'])*'/g, "''");

    expect(files).toEqual([
      "001-access-product-grants.sql",
      "002-platform-control-bootstrap.sql",
      "003-admin-product-capabilities.sql",
      "004-access-lumen-projection-outbox.sql",
      "005-remove-pulso-agenda-trigger.sql",
      "006-access-runtime-readiness-ledger.sql"
    ]);
    expect(sql).toContain("access_runtime.product_grants");
    expect(sql).toContain("from platform.operator_tenants membership");
    expect(sql).toContain("product.code in ('nova', 'lumen', 'pulso_iris')");
    expect(sql).toContain("array['manage:platform']");
    expect(sql).toContain("array['nova:read', 'nova:write', 'nova:admin']");
    expect(sql).toContain("array['lumen:admin']");
    expect(sql).toContain("array['pulso:admin']");
    expect(sql).toContain("admin grant capability convergence failed");
    expect(sql).toContain("access_runtime.bootstrap_tenants");
    expect(sql).toContain("00000000-0000-4000-8000-000000000001");
    expect(sql).toContain("'purpose', 'platform-control'");
    expect(sql).toContain("registry.tenant_id");
    expect(sql).toContain("grant select on access_runtime.bootstrap_tenants to hyperion_access");
    expect(sql).toContain("grant select on access_runtime.migration_ledger to hyperion_access");
    expect(sql).toContain("backfill left an active membership unresolved");
    expect(sql).toContain("access_runtime.lumen_projection_state");
    expect(sql).toContain("access_runtime.lumen_projection_outbox");
    expect(sql).toContain("unique (projection_kind, tenant_id, aggregate_id, source_version)");
    expect(contents[0]).not.toContain("'PLATFORM'");
    expect(contents[1]).toContain("tenant_id <> '00000000-0000-4000-8000-000000000001'::uuid");
    expect(contents[1]?.toLowerCase()).toContain("active platform grant exists outside the reserved control tenant");
    expect(sql).not.toContain("tenant.slug");
    expect(executableIdentifiers).not.toMatch(/\b(?:nova|lumen|pulso_iris|agent_runtime)\s*\./);
    expect(sql).not.toContain("platform.schema_migrations");
    expect(contents[4]?.toLowerCase()).toContain(
      "drop trigger if exists trg_initialize_agenda_settings on platform.tenants"
    );
    expect(contents[4]?.toLowerCase()).not.toMatch(/create\s+trigger|execute\s+(?:function|procedure)|pulso_iris\./);
    expect(contents.every((content) => /^[a-f0-9]{64}$/.test(computePlatformMigrationChecksum(content)))).toBe(true);
  });
});
