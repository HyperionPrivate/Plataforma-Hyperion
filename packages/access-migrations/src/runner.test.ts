import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { computeAccessMigrationChecksum, runAccessMigrationsWithClient } from "./runner.js";

const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));

describe("provider-owned Access migration set", () => {
  it("is a fresh baseline containing only tables Identity and Tenant execute against", async () => {
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const contents = await Promise.all(
      files.map((file) => readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"))
    );
    const sql = contents.join("\n").toLowerCase();
    const executableIdentifiers = sql.replace(/--[^\n]*/g, "").replace(/'(?:''|[^'])*'/g, "''");
    const createdTables = [...sql.matchAll(/create table\s+([a-z_]+\.[a-z_]+)/g)].map((match) => match[1]);

    expect(files).toEqual([
      "001-access-fresh-baseline.sql",
      "002-access-runtime-role-boundary.sql",
      "003-access-tenant-projection.sql",
      "004-access-tenant-lifecycle-integrity.sql"
    ]);
    expect(createdTables).toEqual([
      "platform.tenants",
      "platform.operators",
      "platform.operator_sessions",
      "platform.operator_tenants",
      "access_runtime.product_grants",
      "access_runtime.bootstrap_tenants",
      "access_runtime.lumen_projection_state",
      "access_runtime.lumen_projection_outbox",
      "access_runtime.tenant_projection_state",
      "access_runtime.tenant_projection_outbox"
    ]);
    expect(sql).not.toMatch(/platform\.(products|agents|prompt_flows|knowledge_sources|integrations|audit_events)/);
    expect(executableIdentifiers).not.toMatch(/\b(?:nova|lumen|pulso_iris|audit_runtime|agent_runtime)\s*\./);
    expect(sql).not.toContain("platform.schema_migrations");
    expect(sql).toContain('"owner":"access-migrations"');
    expect(sql).toContain("grant select on table platform.tenants to hyperion_identity, hyperion_tenant");
    expect(sql).toContain("grant select, insert, delete on table platform.operator_tenants to hyperion_identity");
    expect(sql).toContain(
      "grant select on table access_runtime.migration_ledger to hyperion_identity, hyperion_tenant"
    );
    expect(sql).toContain(
      "grant select, insert, update on table\n  access_runtime.tenant_projection_state,\n  access_runtime.tenant_projection_outbox\nto hyperion_identity"
    );
    expect(sql).not.toContain("grant create on database");
    expect(contents.every((content) => /^[a-f0-9]{64}$/.test(computeAccessMigrationChecksum(content)))).toBe(true);
  });

  it("owns tenant source watermarks and fails closed before a v1 hard delete can cascade", async () => {
    const lifecycleSql = (
      await readFile(new URL("../sql/004-access-tenant-lifecycle-integrity.sql", import.meta.url), "utf8")
    ).toLowerCase();

    expect(lifecycleSql).toContain("create function access_runtime.enforce_tenant_lifecycle_v1()");
    expect(lifecycleSql).toContain("set search_path = pg_catalog");
    expect(lifecycleSql).toContain("before insert or update or delete on platform.tenants");
    expect(lifecycleSql).toContain("alter table platform.tenants enable always trigger trg_access_tenant_lifecycle_v1");
    expect(lifecycleSql).toContain("new.updated_at := clock_timestamp()");
    expect(lifecycleSql).toContain("old.updated_at + interval '1 microsecond'");
    expect(lifecycleSql).toContain("if tg_op = 'delete'");
    expect(lifecycleSql).toContain("errcode = '55000'");
    expect(lifecycleSql).toContain("access.tenant.snapshot.v1 has no tombstone");
    expect(lifecycleSql).toContain(
      "revoke execute on function access_runtime.enforce_tenant_lifecycle_v1()\n  from public, hyperion_identity, hyperion_tenant"
    );
    expect(lifecycleSql).not.toMatch(/channel_runtime|pulso_iris|005-/);
  });

  it("applies every file transactionally and is checksum-idempotent", async () => {
    const ledger = new Map<string, string>();
    const executed: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        executed.push(sql.trim());
        if (sql.includes("session_user as session_role")) {
          return {
            rows: [
              {
                current_role: "hyperion_access_migrator",
                session_role: "hyperion_access_migrator",
                current_database: "hyperion_access",
                database_owner: "hyperion_access_migrator"
              }
            ]
          };
        }
        if (sql.includes("set_config('search_path'")) return { rows: [{ search_path: "pg_catalog" }] };
        if (sql.includes("select name, checksum")) {
          return { rows: [...ledger].map(([name, checksum]) => ({ name, checksum })) };
        }
        if (sql.includes("insert into access_runtime.migration_ledger")) {
          ledger.set(String(values?.[0]), String(values?.[1]));
        }
        return { rows: [] };
      })
    };

    const first = await runAccessMigrationsWithClient(client as never, sqlDirectory, "hyperion_access");
    const second = await runAccessMigrationsWithClient(client as never, sqlDirectory, "hyperion_access");
    expect(first).toEqual({
      applied: [
        "001-access-fresh-baseline.sql",
        "002-access-runtime-role-boundary.sql",
        "003-access-tenant-projection.sql",
        "004-access-tenant-lifecycle-integrity.sql"
      ],
      skipped: []
    });
    expect(second).toEqual({
      applied: [],
      skipped: [
        "001-access-fresh-baseline.sql",
        "002-access-runtime-role-boundary.sql",
        "003-access-tenant-projection.sql",
        "004-access-tenant-lifecycle-integrity.sql"
      ]
    });
    expect(executed.filter((sql) => sql === "begin")).toHaveLength(4);
    expect(executed.filter((sql) => sql === "commit")).toHaveLength(4);
    expect(executed.filter((sql) => sql.includes("set_config('search_path', 'pg_catalog'"))).toHaveLength(2);
  });

  it("fails before DDL when the connected session is not the database-owning migrator", async () => {
    const client = {
      query: vi.fn(async (sql: string) =>
        sql.includes("set_config('search_path'")
          ? { rows: [{ search_path: "pg_catalog" }] }
          : {
              rows: [
                {
                  current_role: "postgres",
                  session_role: "postgres",
                  current_database: "hyperion_access",
                  database_owner: "hyperion_access_migrator"
                }
              ]
            }
      )
    };
    await expect(runAccessMigrationsWithClient(client as never, sqlDirectory, "hyperion_access")).rejects.toThrow(
      "session identity"
    );
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the hardened search_path cannot be pinned", async () => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ search_path: "public" }] }))
    };
    await expect(runAccessMigrationsWithClient(client as never, sqlDirectory, "hyperion_access")).rejects.toThrow(
      "pin its session search_path"
    );
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it("rejects an elevated migrator and a mixed provider ledger before migration DDL", async () => {
    const elevated = {
      query: vi.fn(async (sql: string) =>
        sql.includes("set_config('search_path'")
          ? { rows: [{ search_path: "pg_catalog" }] }
          : {
              rows: [
                {
                  current_role: "hyperion_access_migrator",
                  session_role: "hyperion_access_migrator",
                  current_database: "hyperion_access",
                  database_owner: "hyperion_access_migrator",
                  unsafe_capabilities: true,
                  has_memberships: false,
                  owns_other_database: false,
                  has_out_of_scope_authority: false
                }
              ]
            }
      )
    };
    await expect(runAccessMigrationsWithClient(elevated as never, sqlDirectory, "hyperion_access")).rejects.toThrow(
      "authority closure"
    );
    expect(elevated.query).toHaveBeenCalledTimes(2);

    const mixed = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("session_user as session_role")) {
          return {
            rows: [
              {
                current_role: "hyperion_access_migrator",
                session_role: "hyperion_access_migrator",
                current_database: "hyperion_access",
                database_owner: "hyperion_access_migrator"
              }
            ]
          };
        }
        if (sql.includes("set_config('search_path'")) return { rows: [{ search_path: "pg_catalog" }] };
        if (sql.includes("select name, checksum")) {
          return { rows: [{ name: "006-access-runtime-readiness-ledger.sql", checksum: "f".repeat(64) }] };
        }
        return { rows: [] };
      })
    };
    await expect(runAccessMigrationsWithClient(mixed as never, sqlDirectory, "hyperion_access")).rejects.toThrow(
      "mixed or foreign rows"
    );
    expect(mixed.query.mock.calls.some(([sql]) => sql.trim() === "begin")).toBe(false);
  });
});
