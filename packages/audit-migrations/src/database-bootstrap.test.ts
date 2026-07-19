import { describe, expect, it, vi } from "vitest";
import { AUDIT_MIGRATOR_ROLE, AUDIT_RUNTIME_ROLE } from "./config.js";
import { applyAuditLogicalDatabase } from "./database-bootstrap.js";

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

describe("Audit logical database bootstrap", () => {
  it("creates only the Audit migrator, runtime role and logical database", async () => {
    const { client, query, statements } = createClient();

    await applyAuditLogicalDatabase(client, "hyperion_audit", "migrator-password-00000001");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("create database"), [
      "hyperion_audit",
      AUDIT_MIGRATOR_ROLE
    ]);
    expect(statements.join("\n")).toContain(AUDIT_RUNTIME_ROLE);
    expect(statements.join("\n")).not.toMatch(/hyperion_(nova|lumen|pulso|sofia|channel)/i);
  });

  it("is idempotent when the existing authority matrix is clean", async () => {
    const { client, query } = createClient({ databaseOwner: AUDIT_MIGRATOR_ROLE, roles: CLEAN_EXISTING_ROLES });

    await applyAuditLogicalDatabase(client, "hyperion_audit", "migrator-password-00000001");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("where role.rolname = any($1::text[])"), [
      [AUDIT_MIGRATOR_ROLE, AUDIT_RUNTIME_ROLE],
      "hyperion_audit",
      AUDIT_MIGRATOR_ROLE
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("dependency.dbid = target_database.oid"), [
      [AUDIT_MIGRATOR_ROLE, AUDIT_RUNTIME_ROLE],
      "hyperion_audit",
      AUDIT_MIGRATOR_ROLE
    ]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("create database %I owner %I"))).toBe(false);
  });

  it("refuses role authority drift before changing cluster state", async () => {
    const roles = [{ ...CLEAN_EXISTING_ROLES[0]!, unsafe_capabilities: true }, CLEAN_EXISTING_ROLES[1]!];
    const { client, query } = createClient({ databaseOwner: AUDIT_MIGRATOR_ROLE, roles });

    await expect(applyAuditLogicalDatabase(client, "hyperion_audit", "migrator-password-00000001")).rejects.toThrow(
      "refused pre-existing authority drift"
    );

    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("select format("))).toBe(false);
  });

  it("refuses a pre-existing database owned outside Audit", async () => {
    const { client, query } = createClient({ databaseOwner: "unexpected_owner", roles: CLEAN_EXISTING_ROLES });

    await expect(applyAuditLogicalDatabase(client, "hyperion_audit", "migrator-password-00000001")).rejects.toThrow(
      `must be owned by ${AUDIT_MIGRATOR_ROLE}`
    );

    expect(query.mock.calls.some(([sql]) => String(sql).includes("from pg_roles role"))).toBe(false);
  });
});
