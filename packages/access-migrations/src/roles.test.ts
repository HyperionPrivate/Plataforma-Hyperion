import { describe, expect, it, vi } from "vitest";
import { ACCESS_MIGRATOR_ROLE, ACCESS_RUNTIME_DATABASE_ROLES, type AccessRolePasswords } from "./config.js";
import { applyAccessRolePasswords, fenceAccessRuntimeRolesWithClient } from "./roles.js";
import { ACCESS_FRESH_PROVIDER_LEDGER } from "./schema-manifest.js";

const EXPECTED_ROLES = [ACCESS_MIGRATOR_ROLE, ...ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role)];
const CLEAN_ROLES = EXPECTED_ROLES.map((rolname) => ({
  has_memberships: false,
  has_out_of_scope_acl: false,
  owns_out_of_scope_objects: false,
  rolname,
  unsafe_capabilities: false
}));
const PASSWORDS: AccessRolePasswords = new Map([
  ["hyperion_identity", "identity-runtime-password-001"],
  ["hyperion_tenant", "tenant-runtime-password-00002"]
]);

function createClient(roles = CLEAN_ROLES, databaseOwner: string = ACCESS_MIGRATOR_ROLE) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("set_config('search_path'")) return { rows: [{ search_path: "pg_catalog" }] };
    if (sql.includes("where role.rolname = current_user")) {
      return {
        rows: [
          {
            current_role: "postgres",
            session_role: "postgres",
            is_superuser: true,
            can_create_role: true
          }
        ]
      };
    }
    if (sql.includes("from pg_roles runtime_role")) {
      const expected = new Set((values?.[0] as string[]) ?? []);
      return { rows: roles.filter(({ rolname }) => expected.has(rolname)) };
    }
    if (sql.includes("select pg_get_userbyid(datdba)")) return { rows: [{ owner: databaseOwner }] };
    if (sql.includes("from pg_roles role")) return { rows: roles };
    if (sql.startsWith("select format(")) {
      return { rows: [{ statement: `alter role "${String(values?.[0])}" with login password 'redacted'` }] };
    }
    return { rows: [] };
  });
  return { client: { query } as never, query, statements };
}

function createTargetClient(
  migrations: readonly Readonly<{ name: string; checksum: string }>[] = ACCESS_FRESH_PROVIDER_LEDGER
) {
  return {
    query: vi.fn(async (sql: string) =>
      sql.includes("set_config('search_path'")
        ? { rows: [{ search_path: "pg_catalog" }] }
        : sql.includes("current_database()")
          ? {
              rows: [
                {
                  current_role: "postgres",
                  session_role: "postgres",
                  current_database: "hyperion_access"
                }
              ]
            }
          : { rows: migrations.map((entry) => ({ ...entry })) }
    )
  };
}

const verifyBoundary = vi.fn(async () => undefined);

describe("Access runtime role bootstrap", () => {
  it("can fence existing runtime roles before reading target credentials or opening the target database", async () => {
    const { client, statements } = createClient();
    await fenceAccessRuntimeRolesWithClient(client);

    expect(statements).toContain('alter role "hyperion_identity" with nologin');
    expect(statements).toContain('alter role "hyperion_tenant" with nologin');
    expect(statements.some((statement) => statement.includes("login password"))).toBe(false);
  });

  it("fences and activates exactly the separate Identity and Tenant roles", async () => {
    const { client, statements } = createClient();
    await applyAccessRolePasswords(client, createTargetClient() as never, "hyperion_access", PASSWORDS, verifyBoundary);

    expect(statements).toContain('alter role "hyperion_identity" with nologin');
    expect(statements).toContain('alter role "hyperion_tenant" with nologin');
    expect(
      statements.filter((statement) => statement.startsWith('alter role "') && statement.includes("login password"))
    ).toHaveLength(2);
    expect(statements.join("\n")).not.toMatch(/hyperion_(audit|nova|lumen|pulso|sofia|channel)/);
  });

  it("rejects missing, unsafe or object-owning runtime roles before activation", async () => {
    const unsafe = CLEAN_ROLES.map((role) =>
      role.rolname === "hyperion_identity" ? { ...role, owns_out_of_scope_objects: true } : role
    );
    const { client, statements } = createClient(unsafe);
    await expect(
      applyAccessRolePasswords(client, createTargetClient() as never, "hyperion_access", PASSWORDS, verifyBoundary)
    ).rejects.toThrow("unsafe role privilege matrix");
    expect(statements).toContain('alter role "hyperion_identity" with nologin');

    const missing = createClient(CLEAN_ROLES.slice(0, 2));
    await expect(
      applyAccessRolePasswords(
        missing.client,
        createTargetClient() as never,
        "hyperion_access",
        PASSWORDS,
        verifyBoundary
      )
    ).rejects.toThrow("requires all provider-owned Access roles");

    const foreignAcl = createClient(
      CLEAN_ROLES.map((role) => (role.rolname === "hyperion_tenant" ? { ...role, has_out_of_scope_acl: true } : role))
    );
    await expect(
      applyAccessRolePasswords(
        foreignAcl.client,
        createTargetClient() as never,
        "hyperion_access",
        PASSWORDS,
        verifyBoundary
      )
    ).rejects.toThrow("unsafe role privilege matrix");
  });

  it("rejects an incomplete password matrix and foreign database owner", async () => {
    const { client, statements } = createClient();
    await expect(
      applyAccessRolePasswords(
        client,
        createTargetClient() as never,
        "hyperion_access",
        new Map([["hyperion_identity", "only-one"]]),
        verifyBoundary
      )
    ).rejects.toThrow("exactly the Identity and Tenant passwords");
    expect(statements).toContain('alter role "hyperion_identity" with nologin');
    expect(statements).toContain('alter role "hyperion_tenant" with nologin');

    const foreign = createClient(CLEAN_ROLES, "foreign_owner");
    await expect(
      applyAccessRolePasswords(
        foreign.client,
        createTargetClient() as never,
        "hyperion_access",
        PASSWORDS,
        verifyBoundary
      )
    ).rejects.toThrow(`to be owned by ${ACCESS_MIGRATOR_ROLE}`);
  });

  it("refuses LOGIN activation until the fresh ledger and boundary grants are complete", async () => {
    const { client, statements } = createClient();
    await expect(
      applyAccessRolePasswords(
        client,
        createTargetClient([ACCESS_FRESH_PROVIDER_LEDGER[1]!]) as never,
        "hyperion_access",
        PASSWORDS,
        verifyBoundary
      )
    ).rejects.toThrow("exact fresh provider ledger");
    expect(statements).toContain('alter role "hyperion_identity" with nologin');
    expect(statements.some((statement) => statement.includes("login password"))).toBe(false);

    const rejectedBoundary = vi.fn(async () => {
      throw new Error("grant drift");
    });
    await expect(
      applyAccessRolePasswords(
        createClient().client,
        createTargetClient() as never,
        "hyperion_access",
        PASSWORDS,
        rejectedBoundary
      )
    ).rejects.toThrow("grant drift");

    const wrongChecksum = ACCESS_FRESH_PROVIDER_LEDGER.map((entry, index) =>
      index === 0 ? { ...entry, checksum: "0".repeat(64) } : entry
    );
    await expect(
      applyAccessRolePasswords(
        createClient().client,
        createTargetClient(wrongChecksum) as never,
        "hyperion_access",
        PASSWORDS,
        verifyBoundary
      )
    ).rejects.toThrow("exact fresh provider ledger");

    await expect(
      applyAccessRolePasswords(
        createClient().client,
        createTargetClient([
          ...ACCESS_FRESH_PROVIDER_LEDGER,
          { name: "999-mixed-provider.sql", checksum: "f".repeat(64) }
        ]) as never,
        "hyperion_access",
        PASSWORDS,
        verifyBoundary
      )
    ).rejects.toThrow("exact fresh provider ledger");
  });

  it("rejects SET ROLE and a target session connected to another database", async () => {
    const elevated = createClient();
    elevated.query
      .mockImplementationOnce(async () => ({ rows: [{ search_path: "pg_catalog" }] }))
      .mockImplementationOnce(async () => ({
        rows: [
          {
            current_role: "postgres",
            session_role: "bootstrap_login",
            is_superuser: true,
            can_create_role: true
          }
        ]
      }));
    await expect(
      applyAccessRolePasswords(
        elevated.client,
        createTargetClient() as never,
        "hyperion_access",
        PASSWORDS,
        verifyBoundary
      )
    ).rejects.toThrow("separate CREATEROLE administrator session");

    const wrongTarget = {
      query: vi.fn(async (sql: string) =>
        sql.includes("set_config('search_path'")
          ? { rows: [{ search_path: "pg_catalog" }] }
          : { rows: [{ current_role: "postgres", session_role: "postgres", current_database: "postgres" }] }
      )
    };
    await expect(
      applyAccessRolePasswords(
        createClient().client,
        wrongTarget as never,
        "hyperion_access",
        PASSWORDS,
        verifyBoundary
      )
    ).rejects.toThrow("target session identity or database is invalid");
  });
});
