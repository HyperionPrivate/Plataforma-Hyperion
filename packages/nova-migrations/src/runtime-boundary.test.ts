import { describe, expect, it } from "vitest";
import { NOVA_CELL_DATABASE_ROLES, NOVA_MIGRATOR_ROLE, type NovaCellDatabaseRole } from "./config.js";
import { assertNovaRuntimeDatabaseBoundary } from "./runtime-boundary.js";
import {
  NOVA_PROVIDER_LEDGER,
  NOVA_PROVIDER_ROUTINES,
  NOVA_PROVIDER_TABLES,
  NOVA_RUNTIME_APPEND_ONLY_TABLES,
  NOVA_RUNTIME_NO_DELETE_TABLES,
  NOVA_RUNTIME_READ_ONLY_TABLES
} from "./schema-manifest.js";

const ROLE_SCHEMA = new Map<NovaCellDatabaseRole, string>([
  ["hyperion_nova", "nova"],
  ["hyperion_voice", "voice"],
  ["hyperion_liwa", "liwa"],
  ["hyperion_documents", "documents"]
]);

function boundaryClient(mutate?: (sql: string, rows: Record<string, unknown>[], values?: unknown[]) => void) {
  return {
    query: async (sql: string, values?: unknown[]) => {
      let rows: Record<string, unknown>[];
      if (sql.includes("set_config('search_path'")) rows = [{ search_path: "pg_catalog" }];
      else if (sql.includes("from pg_catalog.pg_database"))
        rows = [{ database: "hyperion_nova", owner: NOVA_MIGRATOR_ROLE }];
      else if (sql.includes("from nova.migration_ledger")) rows = NOVA_PROVIDER_LEDGER.map((row) => ({ ...row }));
      else if (sql.includes("cross join pg_catalog.pg_roles")) {
        rows = ["documents", "liwa", "nova", "voice"].flatMap((schema_name) =>
          NOVA_CELL_DATABASE_ROLES.map(({ role }) => ({
            schema_name,
            role_name: role,
            owner: NOVA_MIGRATOR_ROLE,
            can_use: ROLE_SCHEMA.get(role) === schema_name,
            can_create: false
          }))
        );
      } else if (sql.includes("as object_count")) rows = [{ object_count: "0" }];
      else if (sql.includes("from pg_catalog.pg_proc routine")) {
        rows = NOVA_PROVIDER_ROUTINES.map((routine) => ({
          routine,
          owner: NOVA_MIGRATOR_ROLE,
          security_definer: false
        }));
      } else if (sql.includes("from pg_catalog.pg_class relation")) {
        const role = String(values?.[1]) as NovaCellDatabaseRole;
        const ownedSchema = ROLE_SCHEMA.get(role);
        rows = NOVA_PROVIDER_TABLES.map((relation) => {
          const schema_name = relation.split(".")[0]!;
          const ownsSchema = schema_name === ownedSchema;
          const readOnly = (NOVA_RUNTIME_READ_ONLY_TABLES as readonly string[]).includes(relation);
          const appendOnly = (NOVA_RUNTIME_APPEND_ONLY_TABLES as readonly string[]).includes(relation);
          const noDelete = (NOVA_RUNTIME_NO_DELETE_TABLES as readonly string[]).includes(relation);
          return {
            relation,
            schema_name,
            owner: NOVA_MIGRATOR_ROLE,
            can_select: ownsSchema,
            can_insert: ownsSchema && (!readOnly || appendOnly),
            can_update: ownsSchema && !readOnly && !appendOnly,
            can_delete: ownsSchema && !readOnly && !appendOnly && !noDelete,
            can_truncate: false,
            can_references: false,
            can_trigger: false
          };
        });
      } else if (sql.includes("as can_connect")) {
        rows = NOVA_CELL_DATABASE_ROLES.map(({ role }) => ({
          role_name: role,
          can_connect: true,
          can_create: false,
          can_temporary: false
        }));
      } else rows = [];
      mutate?.(sql, rows, values);
      return { rows };
    }
  };
}

describe("NOVA runtime database boundary", () => {
  it("accepts the exact provider ledger, relation inventory and four disjoint role closures", async () => {
    await expect(assertNovaRuntimeDatabaseBoundary(boundaryClient() as never)).resolves.toBeUndefined();
  });

  it("rejects a mixed ledger and a cross-schema table grant", async () => {
    const mixedLedger = boundaryClient((sql, rows) => {
      if (sql.includes("from nova.migration_ledger")) rows.push({ name: "999-foreign.sql", checksum: "0".repeat(64) });
    });
    await expect(assertNovaRuntimeDatabaseBoundary(mixedLedger as never)).rejects.toThrow(
      "provider ledger is not exact"
    );

    const crossGrant = boundaryClient((sql, rows, values) => {
      if (sql.includes("from pg_catalog.pg_class relation") && values?.[1] === "hyperion_voice") {
        const foreign = rows.find((row) => row.relation === "nova.contacts");
        if (foreign) foreign.can_select = true;
      }
    });
    await expect(assertNovaRuntimeDatabaseBoundary(crossGrant as never)).rejects.toThrow(
      "hyperion_voice nova.contacts select privilege drifted"
    );
  });

  it("rejects unmanaged routines/sequences and a role with CREATE/TEMPORARY", async () => {
    const drifted = boundaryClient((sql, rows) => {
      if (sql.includes("as object_count")) rows[0]!.object_count = "1";
      if (sql.includes("as can_connect")) rows[0]!.can_temporary = true;
    });
    await expect(assertNovaRuntimeDatabaseBoundary(drifted as never)).rejects.toThrow(
      "provider schemas contain unmanaged sequences or composite types"
    );
  });
});
