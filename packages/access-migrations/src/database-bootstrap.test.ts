import { describe, expect, it, vi } from "vitest";
import { ACCESS_MIGRATOR_ROLE, ACCESS_RUNTIME_DATABASE_ROLES } from "./config.js";
import { applyAccessLogicalDatabase } from "./database-bootstrap.js";

interface ExistingRoleState {
  has_memberships: boolean;
  has_out_of_scope_acl: boolean;
  owns_out_of_scope_objects: boolean;
  rolname: string;
  unsafe_capabilities: boolean;
}

const CLEAN_ROLES: ExistingRoleState[] = [
  ACCESS_MIGRATOR_ROLE,
  ...ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role)
].map((rolname) => ({
  has_memberships: false,
  has_out_of_scope_acl: false,
  owns_out_of_scope_objects: false,
  rolname,
  unsafe_capabilities: false
}));

function createClient(
  options: {
    administrator?: {
      current_role: string;
      session_role: string;
      is_superuser: boolean;
      can_create_database: boolean;
      can_create_role: boolean;
    };
    databaseOwner?: string;
    failOnDatabaseRevoke?: boolean;
    roles?: ExistingRoleState[];
  } = {}
) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("set_config('search_path'")) return { rows: [{ search_path: "pg_catalog" }] };
    if (sql.includes("where role.rolname = current_user")) {
      return {
        rows: [
          options.administrator ?? {
            current_role: "postgres",
            session_role: "postgres",
            is_superuser: true,
            can_create_database: true,
            can_create_role: true
          }
        ]
      };
    }
    if (sql.includes("select pg_get_userbyid(datdba)")) {
      return {
        rows: options.databaseOwner ? [{ owner: options.databaseOwner, allow_connections: true }] : []
      };
    }
    if (sql.includes("from pg_roles runtime_role")) {
      const expected = new Set((values?.[0] as string[]) ?? []);
      return { rows: (options.roles ?? []).filter(({ rolname }) => expected.has(rolname)) };
    }
    if (sql.includes("from pg_roles role")) return { rows: options.roles ?? [] };
    if (options.failOnDatabaseRevoke && sql.includes("revoke all on database")) {
      throw new Error("simulated ACL failure");
    }
    if (sql.startsWith("select format(")) return { rows: [{ statement: `prepared:${String(values?.join(":"))}` }] };
    return { rows: [] };
  });
  return { client: { query } as never, query, statements };
}

describe("Access logical database bootstrap", () => {
  it("creates only the migrator, Identity, Tenant and provider-owned database", async () => {
    const { client, query, statements } = createClient();
    await applyAccessLogicalDatabase(client, "hyperion_access", "access-migrator-password-0001");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("create database"), [
      "hyperion_access",
      ACCESS_MIGRATOR_ROLE
    ]);
    expect(statements.join("\n")).toContain("hyperion_identity");
    expect(statements.join("\n")).toContain("hyperion_tenant");
    expect(statements.join("\n")).not.toMatch(/hyperion_(audit|nova|lumen|pulso|sofia|channel)/);
    expect(statements.join("\n")).toContain("template template0 allow_connections false");
    expect(statements.join("\n")).toContain("alter database %I allow_connections true");
  });

  it("is idempotent for an exact pre-existing authority matrix", async () => {
    const { client, query } = createClient({ databaseOwner: ACCESS_MIGRATOR_ROLE, roles: CLEAN_ROLES });
    await applyAccessLogicalDatabase(client, "hyperion_access", "access-migrator-password-0001");

    expect(query.mock.calls.some(([sql]) => String(sql).includes("create database %I owner %I"))).toBe(false);
    expect(
      query.mock.calls.filter(([sql]) => String(sql).startsWith("select format('alter role %I with"))
    ).toHaveLength(5);
  });

  it("rejects a foreign database owner after fail-closing existing runtime roles", async () => {
    const { client, query } = createClient({ databaseOwner: "foreign_owner", roles: CLEAN_ROLES });
    await expect(
      applyAccessLogicalDatabase(client, "hyperion_access", "access-migrator-password-0001")
    ).rejects.toThrow(`must be owned by ${ACCESS_MIGRATOR_ROLE}`);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("alter role %I with nologin"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("where role.rolname = any"))).toBe(false);
  });

  it("rejects unsafe pre-existing role authority", async () => {
    const roles = CLEAN_ROLES.map((role) =>
      role.rolname === "hyperion_tenant" ? { ...role, has_memberships: true } : role
    );
    const { client, query } = createClient({ databaseOwner: ACCESS_MIGRATOR_ROLE, roles });
    await expect(
      applyAccessLogicalDatabase(client, "hyperion_access", "access-migrator-password-0001")
    ).rejects.toThrow("refused pre-existing authority drift");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("alter role %I with nologin"))).toBe(true);
    expect(query).toHaveBeenLastCalledWith("select pg_advisory_unlock(hashtext($1))", [
      "access:logical-database-bootstrap"
    ]);

    const foreignAcl = CLEAN_ROLES.map((role) =>
      role.rolname === "hyperion_identity" ? { ...role, has_out_of_scope_acl: true } : role
    );
    await expect(
      applyAccessLogicalDatabase(
        createClient({ databaseOwner: ACCESS_MIGRATOR_ROLE, roles: foreignAcl }).client,
        "hyperion_access",
        "access-migrator-password-0001"
      )
    ).rejects.toThrow("refused pre-existing authority drift");
  });

  it("leaves a newly created database sealed when ACL setup fails", async () => {
    const { client, statements } = createClient({ failOnDatabaseRevoke: true });
    await expect(
      applyAccessLogicalDatabase(client, "hyperion_access", "access-migrator-password-0001")
    ).rejects.toThrow("simulated ACL failure");
    expect(statements.join("\n")).toContain("template template0 allow_connections false");
    expect(statements.join("\n")).not.toContain("alter database %I allow_connections true");
  });

  it("rejects a SET ROLE administrator before taking the provider lock", async () => {
    const { client, statements } = createClient({
      administrator: {
        current_role: "postgres",
        session_role: "bootstrap_login",
        is_superuser: true,
        can_create_database: true,
        can_create_role: true
      }
    });
    await expect(
      applyAccessLogicalDatabase(client, "hyperion_access", "access-migrator-password-0001")
    ).rejects.toThrow("separate CREATEROLE and CREATEDB administrator session");
    expect(statements).not.toContain("select pg_advisory_lock(hashtext($1))");
  });
});
