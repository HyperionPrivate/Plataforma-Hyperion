import { describe, expect, it, vi } from "vitest";
import { LUMEN_MIGRATOR_ROLE, LUMEN_RUNTIME_ROLE } from "./config.js";
import { applyLumenLogicalDatabase } from "./database-bootstrap.js";

interface ExistingRoleState {
  has_memberships: boolean;
  owns_out_of_scope_objects: boolean;
  rolname: string;
  unsafe_capabilities: boolean;
}

const CLEAN_EXISTING_ROLES: ExistingRoleState[] = [
  {
    has_memberships: false,
    owns_out_of_scope_objects: false,
    rolname: LUMEN_MIGRATOR_ROLE,
    unsafe_capabilities: false
  },
  {
    has_memberships: false,
    owns_out_of_scope_objects: false,
    rolname: LUMEN_RUNTIME_ROLE,
    unsafe_capabilities: false
  }
];

function createClient(options: { databaseOwner?: string; roles?: ExistingRoleState[] } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("select pg_get_userbyid(datdba)")) {
      return { rows: options.databaseOwner ? [{ owner: options.databaseOwner }] : [] };
    }
    if (sql.includes("from pg_roles role")) return { rows: options.roles ?? [] };
    if (sql.startsWith("select format(")) {
      return { rows: [{ statement: `prepared:${String(values?.join(":"))}` }] };
    }
    return { rows: [] };
  });
  return { client: { query } as never, query, statements };
}

describe("LUMEN logical database bootstrap", () => {
  it("creates only the migrator, runtime role and provider-owned database", async () => {
    const { client, query, statements } = createClient();

    await applyLumenLogicalDatabase(client, "hyperion_lumen", "migrator-password-00000001");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("create database"), [
      "hyperion_lumen",
      LUMEN_MIGRATOR_ROLE
    ]);
    expect(statements.join("\n")).toContain(LUMEN_RUNTIME_ROLE);
    expect(statements.join("\n")).not.toMatch(/nova|pulso|sofia|channel/i);
  });

  it("is idempotent when both existing roles and the LUMEN database match the authority matrix", async () => {
    const { client, query } = createClient({
      databaseOwner: LUMEN_MIGRATOR_ROLE,
      roles: CLEAN_EXISTING_ROLES
    });

    await applyLumenLogicalDatabase(client, "hyperion_lumen", "migrator-password-00000001");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("where role.rolname = any($1::text[])"), [
      [LUMEN_MIGRATOR_ROLE, LUMEN_RUNTIME_ROLE],
      "hyperion_lumen",
      LUMEN_MIGRATOR_ROLE
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("create database %I owner %I"))).toBe(false);
    const existingRoleChanges = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("alter role %I with"));
    expect(existingRoleChanges).toHaveLength(2);
    expect(existingRoleChanges.join("\n")).not.toMatch(
      /nosuperuser|nocreatedb|nocreaterole|noinherit|noreplication|nobypassrls/
    );
  });

  it.each([
    {
      label: "unsafe migrator capabilities",
      roles: [{ ...CLEAN_EXISTING_ROLES[0]!, unsafe_capabilities: true }, CLEAN_EXISTING_ROLES[1]!]
    },
    {
      label: "a runtime membership",
      roles: [CLEAN_EXISTING_ROLES[0]!, { ...CLEAN_EXISTING_ROLES[1]!, has_memberships: true }]
    },
    {
      label: "migrator ownership outside the LUMEN database",
      roles: [{ ...CLEAN_EXISTING_ROLES[0]!, owns_out_of_scope_objects: true }, CLEAN_EXISTING_ROLES[1]!]
    },
    {
      label: "runtime object ownership",
      roles: [CLEAN_EXISTING_ROLES[0]!, { ...CLEAN_EXISTING_ROLES[1]!, owns_out_of_scope_objects: true }]
    }
  ])("refuses $label before changing either role", async ({ roles }) => {
    const { client, query } = createClient({ databaseOwner: LUMEN_MIGRATOR_ROLE, roles });

    await expect(applyLumenLogicalDatabase(client, "hyperion_lumen", "migrator-password-00000001")).rejects.toThrow(
      "refused pre-existing authority drift"
    );

    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("select format("))).toBe(false);
    expect(query).toHaveBeenLastCalledWith("select pg_advisory_unlock(hashtext($1))", [
      "lumen:logical-database-bootstrap"
    ]);
  });

  it("refuses a pre-existing database owned outside the LUMEN matrix before changing roles", async () => {
    const { client, query } = createClient({ databaseOwner: "unexpected_owner", roles: CLEAN_EXISTING_ROLES });

    await expect(applyLumenLogicalDatabase(client, "hyperion_lumen", "migrator-password-00000001")).rejects.toThrow(
      `must be owned by ${LUMEN_MIGRATOR_ROLE}`
    );

    expect(query.mock.calls.some(([sql]) => String(sql).includes("from pg_roles role"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("select format("))).toBe(false);
  });
});
