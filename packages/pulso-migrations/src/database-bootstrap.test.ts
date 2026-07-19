import { describe, expect, it, vi } from "vitest";
import { PULSO_MIGRATOR_ROLE, PULSO_RUNTIME_ROLE_DEFINITIONS } from "./config.js";
import { applyPulsoLogicalDatabase } from "./database-bootstrap.js";

interface ExistingRoleState {
  has_memberships: boolean;
  owns_out_of_scope_objects: boolean;
  rolname: string;
  unsafe_capabilities: boolean;
}

const ALL_ROLES = [PULSO_MIGRATOR_ROLE, ...PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition) => definition.role)];
const CLEAN_ROLES: ExistingRoleState[] = ALL_ROLES.map((rolname) => ({
  has_memberships: false,
  owns_out_of_scope_objects: false,
  rolname,
  unsafe_capabilities: false
}));

function createClient(options: { databaseOwner?: string; roles?: ExistingRoleState[] } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("select pg_get_userbyid(datdba)")) {
      return { rows: options.databaseOwner ? [{ owner: options.databaseOwner }] : [] };
    }
    if (sql.includes("from pg_roles role")) return { rows: options.roles ?? [] };
    if (sql.startsWith("select format(")) return { rows: [{ statement: `prepared:${String(values?.[0])}` }] };
    return { rows: [] };
  });
  return { client: { query } as never, calls };
}

describe("PULSO logical database bootstrap", () => {
  it("creates one migrator, five fenced runtimes and a dedicated logical database", async () => {
    const { client, calls } = createClient();
    await applyPulsoLogicalDatabase(client, "hyperion_pulso", "migrator-password-00000001");

    for (const role of ALL_ROLES) {
      expect(calls.some((call) => call.values?.[0] === role)).toBe(true);
    }
    expect(calls.some((call) => call.sql.includes("create database %I owner %I"))).toBe(true);
    expect(calls.some((call) => call.values?.[1] === PULSO_MIGRATOR_ROLE)).toBe(true);
  });

  it("is idempotent for the exact existing role/database authority matrix", async () => {
    const { client, calls } = createClient({ databaseOwner: PULSO_MIGRATOR_ROLE, roles: CLEAN_ROLES });
    await applyPulsoLogicalDatabase(client, "hyperion_pulso", "migrator-password-00000001");

    expect(calls.some((call) => call.sql.includes("create database %I owner %I"))).toBe(false);
    expect(calls).toContainEqual(
      expect.objectContaining({
        values: [ALL_ROLES, "hyperion_pulso", PULSO_MIGRATOR_ROLE]
      })
    );
  });

  it.each(["unsafe_capabilities", "has_memberships", "owns_out_of_scope_objects"] as const)(
    "refuses pre-existing %s drift before formatting any mutation",
    async (field) => {
      const roles = CLEAN_ROLES.map((role, index) => (index === 2 ? { ...role, [field]: true } : role));
      const { client, calls } = createClient({ databaseOwner: PULSO_MIGRATOR_ROLE, roles });
      await expect(applyPulsoLogicalDatabase(client, "hyperion_pulso", "migrator-password-00000001")).rejects.toThrow(
        "refused pre-existing authority drift"
      );
      expect(calls.some((call) => call.sql.startsWith("select format("))).toBe(false);
    }
  );

  it("refuses a logical database owned outside the provider boundary", async () => {
    const { client } = createClient({ databaseOwner: "unexpected_owner", roles: CLEAN_ROLES });
    await expect(applyPulsoLogicalDatabase(client, "hyperion_pulso", "migrator-password-00000001")).rejects.toThrow(
      `must be owned by ${PULSO_MIGRATOR_ROLE}`
    );
  });
});
