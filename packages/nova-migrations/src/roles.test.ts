import { describe, expect, it, vi } from "vitest";
import { NOVA_CELL_DATABASE_ROLES, NOVA_MIGRATOR_ROLE, readNovaRolePasswords } from "./config.js";
import { applyNovaRolePasswords, fenceNovaRuntimeRolesWithClient } from "./roles.js";

const DATABASE = "hyperion_nova";
const ADMINISTRATOR = "cluster_admin";

function passwords() {
  return readNovaRolePasswords({
    NOVA_DATABASE_PASSWORD: "nova-password-000000000001",
    VOICE_DATABASE_PASSWORD: "voice-password-00000000001",
    LIWA_DATABASE_PASSWORD: "liwa-password-000000000001",
    DOCUMENTS_DATABASE_PASSWORD: "documents-password-00000001"
  });
}

function administratorClient() {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("set_config('search_path'")) return { rows: [{ search_path: "pg_catalog" }] };
    if (sql.includes("rolsuper as is_superuser")) {
      return {
        rows: [
          {
            current_role: ADMINISTRATOR,
            session_role: ADMINISTRATOR,
            is_superuser: true,
            can_create_role: true
          }
        ]
      };
    }
    if (sql.includes("where role.rolname = any") && !sql.includes("unsafe_capabilities")) {
      return { rows: NOVA_CELL_DATABASE_ROLES.map(({ role }) => ({ rolname: role })) };
    }
    if (sql.includes("from pg_catalog.pg_database")) return { rows: [{ owner: NOVA_MIGRATOR_ROLE }] };
    if (sql.includes("unsafe_capabilities")) {
      return {
        rows: NOVA_CELL_DATABASE_ROLES.map(({ role }) => ({
          rolname: role,
          unsafe_capabilities: false,
          has_memberships: false,
          owns_objects: false,
          has_out_of_scope_acl: false
        }))
      };
    }
    if (sql.startsWith("select pg_catalog.format(")) {
      return { rows: [{ statement: `alter role "${String(values?.[0])}" with login password 'redacted'` }] };
    }
    return { rows: [] };
  });
  return { query, statements };
}

function targetClient() {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("set_config('search_path'")) return { rows: [{ search_path: "pg_catalog" }] };
      if (sql.includes("current_database() as database")) {
        return {
          rows: [{ current_role: ADMINISTRATOR, session_role: ADMINISTRATOR, database: DATABASE }]
        };
      }
      return { rows: [] };
    })
  };
}

describe("NOVA role bootstrap", () => {
  it("fences every existing runtime role before later validation", async () => {
    const admin = administratorClient();
    await fenceNovaRuntimeRolesWithClient(admin as never);
    expect(admin.statements.filter((statement) => statement.includes(" with nologin"))).toHaveLength(4);
    expect(admin.statements.findIndex((statement) => statement.includes(" with nologin"))).toBeGreaterThan(
      admin.statements.findIndex((statement) => statement.includes("pg_advisory_lock"))
    );
  });

  it("activates only after target owner, role matrix and runtime boundary pass", async () => {
    const admin = administratorClient();
    const target = targetClient();
    const verifyBoundary = vi.fn(async () => undefined);

    await applyNovaRolePasswords(admin as never, target as never, DATABASE, ADMINISTRATOR, passwords(), verifyBoundary);

    expect(verifyBoundary).toHaveBeenCalledOnce();
    expect(
      admin.statements.filter(
        (statement) => statement.startsWith('alter role "') && statement.includes(" with login password")
      )
    ).toHaveLength(4);
  });

  it("keeps every role fenced when the target boundary fails", async () => {
    const admin = administratorClient();
    const target = targetClient();
    const verifyBoundary = vi.fn(async () => {
      throw new Error("target ACL drift");
    });

    await expect(
      applyNovaRolePasswords(admin as never, target as never, DATABASE, ADMINISTRATOR, passwords(), verifyBoundary)
    ).rejects.toThrow("target ACL drift");
    expect(admin.statements.some((statement) => statement.includes(" with login password"))).toBe(false);
  });
});
