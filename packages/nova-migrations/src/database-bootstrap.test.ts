import { describe, expect, it, vi } from "vitest";
import { NOVA_CELL_DATABASE_ROLES, NOVA_MIGRATOR_ROLE } from "./config.js";
import { applyNovaLogicalDatabase } from "./database-bootstrap.js";

describe("NOVA logical database bootstrap", () => {
  it("creates only the migrator, NOVA runtime roles and the NOVA-owned database", async () => {
    const executed: string[] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      executed.push(sql);
      if (sql.includes("select exists(select 1 from pg_roles")) return { rows: [{ present: false }] };
      if (sql.includes("from pg_database")) return { rows: [] };
      if (sql.startsWith("select format(")) {
        return { rows: [{ statement: `prepared:${String(values?.join(":"))}` }] };
      }
      return { rows: [] };
    });

    await applyNovaLogicalDatabase({ query } as never, "hyperion_nova", "migrator-password-00000001");

    expect(executed.filter((sql) => sql.startsWith("prepared:"))).toHaveLength(NOVA_CELL_DATABASE_ROLES.length + 4);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("create database"), [
      "hyperion_nova",
      NOVA_MIGRATOR_ROLE
    ]);
  });
});
