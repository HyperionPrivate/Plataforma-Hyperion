import { describe, expect, it } from "vitest";
import { ACCESS_MIGRATOR_ROLE, type AccessRuntimeDatabaseRole } from "./config.js";
import { assertAccessRuntimeDatabaseBoundary } from "./runtime-boundary.js";

const RELATIONS = [
  "access_runtime.bootstrap_tenants",
  "access_runtime.lumen_projection_outbox",
  "access_runtime.lumen_projection_state",
  "access_runtime.migration_ledger",
  "access_runtime.product_grants",
  "access_runtime.tenant_projection_outbox",
  "access_runtime.tenant_projection_state",
  "platform.access_token_denylist",
  "platform.operator_sessions",
  "platform.operator_tenants",
  "platform.operators",
  "platform.tenants"
] as const;

const IDENTITY_PRIVILEGES = new Map<string, string[]>([
  ["access_runtime.bootstrap_tenants", ["select"]],
  ["access_runtime.lumen_projection_outbox", ["select", "insert", "update"]],
  ["access_runtime.lumen_projection_state", ["select", "insert", "update"]],
  ["access_runtime.migration_ledger", ["select"]],
  ["access_runtime.product_grants", ["select", "insert", "update", "delete"]],
  ["access_runtime.tenant_projection_outbox", ["select", "insert", "update"]],
  ["access_runtime.tenant_projection_state", ["select", "insert", "update"]],
  ["platform.access_token_denylist", ["select", "insert", "delete"]],
  ["platform.operator_sessions", ["select", "insert", "update"]],
  ["platform.operator_tenants", ["select", "insert", "delete"]],
  ["platform.operators", ["select", "insert", "update"]],
  ["platform.tenants", ["select"]]
]);

function boundaryClient(role: AccessRuntimeDatabaseRole, mutate?: (rows: Record<string, unknown>[]) => void) {
  const query = async (sql: string) => {
    let rows: Record<string, unknown>[];
    if (sql.includes("set_config('search_path'")) {
      rows = [{ search_path: "pg_catalog" }];
    } else if (sql.includes("from pg_database")) {
      rows = [
        {
          runtime_role: role,
          session_role: role,
          database_owner: ACCESS_MIGRATOR_ROLE,
          can_connect: true,
          can_create: false,
          can_temporary: false
        }
      ];
    } else if (sql.includes("from pg_namespace namespace")) {
      rows = ["access_runtime", "platform"].map((schema_name) => ({
        schema_name,
        owner: ACCESS_MIGRATOR_ROLE,
        can_use: true,
        can_create: false
      }));
    } else if (sql.includes("from pg_class relation")) {
      rows = RELATIONS.map((relation) => {
        const allowed = new Set(
          role === "hyperion_identity" ? IDENTITY_PRIVILEGES.get(relation) : tenantPrivileges(relation)
        );
        return {
          relation,
          owner: ACCESS_MIGRATOR_ROLE,
          can_select: allowed.has("select"),
          can_insert: allowed.has("insert"),
          can_update: allowed.has("update"),
          can_delete: allowed.has("delete"),
          can_truncate: false,
          can_references: false,
          can_trigger: false
        };
      });
    } else if (sql.includes("pg_proc routine_catalog")) {
      rows = [
        {
          signature: "access_runtime.enforce_tenant_lifecycle_v1()",
          owner: ACCESS_MIGRATOR_ROLE,
          configuration: ["search_path=pg_catalog"],
          can_execute: false
        },
        {
          signature: "access_runtime.valid_grant_values(text[],text)",
          owner: ACCESS_MIGRATOR_ROLE,
          configuration: null,
          can_execute: role === "hyperion_identity"
        }
      ];
    } else {
      rows = [{ can_create: false }];
    }
    mutate?.(rows);
    return { rows };
  };
  return { query };
}

function tenantPrivileges(relation: string): string[] {
  return ["access_runtime.migration_ledger", "platform.tenants"].includes(relation) ? ["select"] : [];
}

describe("Access runtime database boundary", () => {
  it("accepts the exact Identity and Tenant privilege closures", async () => {
    await expect(
      assertAccessRuntimeDatabaseBoundary(boundaryClient("hyperion_identity") as never, "hyperion_identity")
    ).resolves.toBeUndefined();
    await expect(
      assertAccessRuntimeDatabaseBoundary(boundaryClient("hyperion_tenant") as never, "hyperion_tenant")
    ).resolves.toBeUndefined();
  });

  it("rejects a missing baseline relation and an escalated runtime ACL", async () => {
    const missing = boundaryClient("hyperion_tenant", (rows) => {
      const index = rows.findIndex((row) => row.relation === "platform.tenants");
      if (index >= 0) rows.splice(index, 1);
    });
    await expect(assertAccessRuntimeDatabaseBoundary(missing as never, "hyperion_tenant")).rejects.toThrow(
      "platform.tenants is missing"
    );

    const escalated = boundaryClient("hyperion_identity", (rows) => {
      const grants = rows.find((row) => row.relation === "access_runtime.product_grants");
      if (grants) grants.can_truncate = true;
    });
    await expect(assertAccessRuntimeDatabaseBoundary(escalated as never, "hyperion_identity")).rejects.toThrow(
      "product_grants truncate privilege drifted"
    );

    const executableLifecycleGuard = boundaryClient("hyperion_identity", (rows) => {
      const lifecycleGuard = rows.find((row) => row.signature === "access_runtime.enforce_tenant_lifecycle_v1()");
      if (lifecycleGuard) lifecycleGuard.can_execute = true;
    });
    await expect(
      assertAccessRuntimeDatabaseBoundary(executableLifecycleGuard as never, "hyperion_identity")
    ).rejects.toThrow("enforce_tenant_lifecycle_v1() execute privilege drifted");

    const unsafeLifecycleSearchPath = boundaryClient("hyperion_identity", (rows) => {
      const lifecycleGuard = rows.find((row) => row.signature === "access_runtime.enforce_tenant_lifecycle_v1()");
      if (lifecycleGuard) lifecycleGuard.configuration = ["search_path=public"];
    });
    await expect(
      assertAccessRuntimeDatabaseBoundary(unsafeLifecycleSearchPath as never, "hyperion_identity")
    ).rejects.toThrow("enforce_tenant_lifecycle_v1() configuration drifted");
  });

  it("fails before catalog probes when the runtime search_path cannot be pinned", async () => {
    const client = { query: async () => ({ rows: [{ search_path: "attacker,pg_catalog" }] }) };
    await expect(assertAccessRuntimeDatabaseBoundary(client as never, "hyperion_identity")).rejects.toThrow(
      "could not pin search_path"
    );
  });
});
