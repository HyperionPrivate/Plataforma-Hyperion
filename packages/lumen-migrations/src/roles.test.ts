import { describe, expect, it, vi } from "vitest";
import { LUMEN_MIGRATOR_ROLE, LUMEN_RUNTIME_ROLE } from "./config.js";
import { applyLumenRolePassword } from "./roles.js";

interface RoleState {
  has_memberships: boolean;
  owns_out_of_scope_objects: boolean;
  rolname: string;
  unsafe_capabilities: boolean;
}

const CLEAN_ROLES: RoleState[] = [
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

function createClient(roles: RoleState[] = CLEAN_ROLES, databaseOwner: string = LUMEN_MIGRATOR_ROLE) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("select pg_get_userbyid(datdba)")) {
      return { rows: databaseOwner ? [{ owner: databaseOwner }] : [] };
    }
    if (sql.includes("from pg_roles role")) return { rows: roles };
    if (sql.startsWith("select format(")) {
      return { rows: [{ statement: `alter role "${String(values?.[0])}" with login password 'redacted'` }] };
    }
    return { rows: [] };
  });
  return { client: { query } as never, query, statements };
}

describe("LUMEN runtime role bootstrap", () => {
  it("validates both LUMEN identities before fencing and activating only the runtime identity", async () => {
    const { client, query, statements } = createClient();

    await applyLumenRolePassword(client, "hyperion_lumen", "runtime-password-000000001");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("where role.rolname = any($1::text[])"), [
      [LUMEN_MIGRATOR_ROLE, LUMEN_RUNTIME_ROLE],
      "hyperion_lumen",
      LUMEN_MIGRATOR_ROLE
    ]);
    const inspectionIndex = statements.findIndex((statement) => statement.includes("from pg_roles role"));
    const fenceIndex = statements.indexOf(`alter role "${LUMEN_RUNTIME_ROLE}" with nologin`);
    expect(inspectionIndex).toBeGreaterThan(-1);
    expect(fenceIndex).toBeGreaterThan(inspectionIndex);
    expect(
      statements.filter(
        (statement) => statement.startsWith('alter role "') && statement.includes(" with login password")
      )
    ).toHaveLength(1);
    expect(statements.join("\n")).not.toMatch(/hyperion_(nova|pulso|sofia|channel)/i);
  });

  it("can rotate a clean runtime role repeatedly without changing the authority matrix", async () => {
    const { client, statements } = createClient();

    await applyLumenRolePassword(client, "hyperion_lumen", "runtime-password-000000001");
    await applyLumenRolePassword(client, "hyperion_lumen", "runtime-password-000000002");

    expect(
      statements.filter((statement) => statement === `alter role "${LUMEN_RUNTIME_ROLE}" with nologin`)
    ).toHaveLength(2);
    expect(
      statements.filter(
        (statement) => statement.startsWith('alter role "') && statement.includes(" with login password")
      )
    ).toHaveLength(2);
  });

  it.each([
    {
      label: "unsafe migrator capabilities",
      roles: [{ ...CLEAN_ROLES[0]!, unsafe_capabilities: true }, CLEAN_ROLES[1]!]
    },
    {
      label: "a migrator membership",
      roles: [{ ...CLEAN_ROLES[0]!, has_memberships: true }, CLEAN_ROLES[1]!]
    },
    {
      label: "unsafe runtime capabilities",
      roles: [CLEAN_ROLES[0]!, { ...CLEAN_ROLES[1]!, unsafe_capabilities: true }]
    },
    {
      label: "a runtime membership",
      roles: [CLEAN_ROLES[0]!, { ...CLEAN_ROLES[1]!, has_memberships: true }]
    },
    {
      label: "runtime-owned objects",
      roles: [CLEAN_ROLES[0]!, { ...CLEAN_ROLES[1]!, owns_out_of_scope_objects: true }]
    },
    {
      label: "migrator ownership outside the LUMEN database",
      roles: [{ ...CLEAN_ROLES[0]!, owns_out_of_scope_objects: true }, CLEAN_ROLES[1]!]
    }
  ])("refuses $label before fencing the runtime role", async ({ roles }) => {
    const { client, query, statements } = createClient(roles);

    await expect(applyLumenRolePassword(client, "hyperion_lumen", "runtime-password-000000001")).rejects.toThrow(
      "unsafe role privilege matrix"
    );

    expect(statements).not.toContain(`alter role "${LUMEN_RUNTIME_ROLE}" with nologin`);
    expect(statements).toContain("rollback");
    expect(query).toHaveBeenLastCalledWith("select pg_advisory_unlock(hashtext($1))", [
      "lumen:database-role-bootstrap"
    ]);
  });

  it("refuses a missing fixed LUMEN identity before changing the runtime role", async () => {
    const { client, statements } = createClient([CLEAN_ROLES[1]!]);

    await expect(applyLumenRolePassword(client, "hyperion_lumen", "runtime-password-000000001")).rejects.toThrow(
      "requires the migrated LUMEN roles"
    );

    expect(statements).not.toContain(`alter role "${LUMEN_RUNTIME_ROLE}" with nologin`);
  });

  it("refuses a database owned outside the LUMEN matrix before inspecting or changing roles", async () => {
    const { client, statements } = createClient(CLEAN_ROLES, "unexpected_owner");

    await expect(applyLumenRolePassword(client, "hyperion_lumen", "runtime-password-000000001")).rejects.toThrow(
      `to be owned by ${LUMEN_MIGRATOR_ROLE}`
    );

    expect(statements.some((statement) => statement.includes("from pg_roles role"))).toBe(false);
    expect(statements).not.toContain(`alter role "${LUMEN_RUNTIME_ROLE}" with nologin`);
  });
});
