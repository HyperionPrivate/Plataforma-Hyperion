import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeNovaMigrationChecksum, runNovaMigrationsWithClient } from "./runner.js";
import { NOVA_PROVIDER_LEDGER } from "./schema-manifest.js";

describe("NOVA-owned migration set", () => {
  it("contains only NOVA-cell schemas and no platform product write", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const contents = await Promise.all(
      files.map((file) => readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"))
    );
    const sql = contents.join("\n").toLowerCase();

    expect(files).toEqual([
      "047-nova-autonomy.sql",
      "048-nova-correlation-and-domain.sql",
      "049-nova-ui-meta-contactos.sql",
      "050-nova-lead-product-line.sql",
      "051-liwa-accepted-pending.sql",
      "052-nova-conversation-messages.sql",
      "053-nova-tenant-owned-routing.sql"
    ]);
    expect(sql).not.toContain("platform.products");
    expect(contents.every((content) => /^[a-f0-9]{64}$/.test(computeNovaMigrationChecksum(content)))).toBe(true);
    expect(files.map((name, index) => ({ name, checksum: computeNovaMigrationChecksum(contents[index]!) }))).toEqual(
      NOVA_PROVIDER_LEDGER
    );
  });

  it("adopts provider ledgers from an already-applied global deployment", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const historical = [
      "047-nova-autonomy.sql",
      "048-nova-correlation-and-domain.sql",
      "049-nova-ui-meta-contactos.sql",
      "050-nova-lead-product-line.sql",
      "051-liwa-accepted-pending.sql",
      "052-nova-conversation-messages.sql"
    ];
    const query = async (sql: string, values?: unknown[]) => {
      if (sql === "select name, checksum from nova.migration_ledger") return { rows: [] };
      if (sql === "select to_regclass($1) as table_name") return { rows: [{ table_name: values?.[0] }] };
      if (/select name from (nova|voice|liwa|documents)\.service_migrations/.test(sql)) {
        return { rows: historical.map((name) => ({ name })) };
      }
      return { rows: [] };
    };

    const result = await runNovaMigrationsWithClient({ query } as never, sqlDirectory);

    expect(result.adopted).toEqual(historical);
    expect(result.applied).toEqual(["053-nova-tenant-owned-routing.sql"]);
  });

  it("rejects an unmanifested migration before opening a transaction", async () => {
    const sqlDirectory = await mkdtemp(path.join(tmpdir(), "nova-migrations-policy-"));
    const statements: string[] = [];
    const unsafeSql = "create table platform.nova_escape(id uuid);";
    await writeFile(path.join(sqlDirectory, "999-cross-cell.sql"), unsafeSql, "utf8");

    try {
      const query = async (sql: string) => {
        statements.push(sql);
        if (sql === "select name, checksum from nova.migration_ledger") return { rows: [] };
        if (sql === "select to_regclass($1) as table_name") return { rows: [{ table_name: null }] };
        return { rows: [] };
      };

      await expect(runNovaMigrationsWithClient({ query } as never, sqlDirectory)).rejects.toThrow(
        "NOVA migration inventory does not match the provider manifest"
      );
      expect(statements).not.toContain("begin");
      expect(statements).not.toContain(unsafeSql);
    } finally {
      await rm(sqlDirectory, { recursive: true, force: true });
    }
  });
});
