import { describe, expect, it, vi } from "vitest";
import { AUDIT_MIGRATOR_ROLE, AUDIT_RUNTIME_ROLE } from "./config.js";
import { applyAuditRolePassword } from "./roles.js";
import { AUDIT_BASELINE_MIGRATION } from "./schema-manifest.js";

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
    rolname: AUDIT_MIGRATOR_ROLE,
    unsafe_capabilities: false
  },
  {
    has_memberships: false,
    owns_out_of_scope_objects: false,
    rolname: AUDIT_RUNTIME_ROLE,
    unsafe_capabilities: false
  }
];

const LEAST_PRIVILEGE_ACL = {
  can_connect: true,
  can_create: false,
  can_temporary: false,
  can_use_platform: true,
  can_use_runtime: true,
  can_read_audit: true,
  can_insert_audit: true,
  can_mutate_audit: false,
  can_read_inbox: true,
  can_insert_inbox: true,
  can_mutate_inbox: false,
  can_read_ledger: true,
  can_write_ledger: false
};

function createClient(options: { roles?: RoleState[]; databaseOwner?: string; acl?: object; sessions?: number } = {}) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("select pg_get_userbyid(datdba)")) {
      return { rows: [{ owner: options.databaseOwner ?? AUDIT_MIGRATOR_ROLE }] };
    }
    if (sql.includes("from pg_roles role")) return { rows: options.roles ?? CLEAN_ROLES };
    if (sql.includes("from pg_stat_activity")) return { rows: [{ count: options.sessions ?? 0 }] };
    if (sql === "select name from audit_runtime.migration_ledger order by name") {
      return { rows: [{ name: AUDIT_BASELINE_MIGRATION }] };
    }
    if (sql.includes("has_database_privilege($1")) return { rows: [options.acl ?? LEAST_PRIVILEGE_ACL] };
    if (sql.startsWith("select format(")) {
      return { rows: [{ statement: `alter role "${String(values?.[0])}" with login password 'redacted'` }] };
    }
    return { rows: [] };
  });
  return { client: { query } as never, query, statements };
}

describe("Audit runtime role bootstrap", () => {
  it("fences the runtime, validates ledger and ACL, then activates it", async () => {
    const { client, query, statements } = createClient();

    await applyAuditRolePassword(client, "hyperion_audit", "runtime-password-000000001");

    expect(statements).toContain(`alter role "${AUDIT_RUNTIME_ROLE}" with nologin`);
    expect(query).toHaveBeenCalledWith("select name from audit_runtime.migration_ledger order by name");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("dependency.dbid = target_database.oid"), [
      [AUDIT_MIGRATOR_ROLE, AUDIT_RUNTIME_ROLE],
      "hyperion_audit",
      AUDIT_MIGRATOR_ROLE
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("has_database_privilege($1"), [AUDIT_RUNTIME_ROLE]);
    expect(
      statements.filter(
        (statement) => statement.startsWith('alter role "') && statement.includes("with login password")
      )
    ).toHaveLength(1);
  });

  it("leaves the runtime fenced when its ACL is excessive", async () => {
    const { client, statements } = createClient({ acl: { ...LEAST_PRIVILEGE_ACL, can_mutate_audit: true } });

    await expect(applyAuditRolePassword(client, "hyperion_audit", "runtime-password-000000001")).rejects.toThrow(
      "incomplete or excessive runtime ACL"
    );

    expect(statements).toContain(`alter role "${AUDIT_RUNTIME_ROLE}" with nologin`);
    expect(
      statements.filter(
        (statement) => statement.startsWith('alter role "') && statement.includes("with login password")
      )
    ).toHaveLength(0);
  });

  it("refuses activation while old Audit sessions are still connected", async () => {
    const { client, statements } = createClient({ sessions: 1 });

    await expect(applyAuditRolePassword(client, "hyperion_audit", "runtime-password-000000001")).rejects.toThrow(
      "sessions to be drained"
    );

    expect(
      statements.filter(
        (statement) => statement.startsWith('alter role "') && statement.includes("with login password")
      )
    ).toHaveLength(0);
  });
});
