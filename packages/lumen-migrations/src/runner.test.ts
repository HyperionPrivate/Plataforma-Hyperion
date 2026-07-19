import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertLumenProviderMigrationNames, computeLumenMigrationChecksum } from "./runner.js";

describe("LUMEN provider-owned migration set", () => {
  it("contains the effective local schema and no sibling-cell object", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const contents = await Promise.all(
      files.map((file) => readFile(new URL(`../sql/${file}`, import.meta.url), "utf8"))
    );
    const sql = contents.join("\n").toLowerCase();

    expect(files).toEqual(["001-lumen-autonomous-baseline.sql", "002-lumen-runtime-role.sql"]);
    expect(sql).not.toMatch(/\b(?:platform|pulso_iris|nova|voice|liwa|documents|channel_runtime|agent_runtime)\./);
    expect(sql).not.toMatch(/hyperion_(?:nova|pulso|sofia|channel|access|audit|integration|knowledge)/);
    expect(sql.match(/^create table lumen\./gm) ?? []).toHaveLength(15);
    expect(sql.match(/^create function lumen\./gm) ?? []).toHaveLength(9);
    expect(contents.every((content) => /^[a-f0-9]{64}$/.test(computeLumenMigrationChecksum(content)))).toBe(true);
  });

  it("keeps the runtime out of migration and N-1 administration ledgers", async () => {
    const grants = await readFile(new URL("../sql/002-lumen-runtime-role.sql", import.meta.url), "utf8");
    expect(grants).toContain("lumen.migration_ledger");
    expect(grants).toContain("lumen.n_minus_one_compatibility_windows");
    expect(grants).toContain("lumen.legacy_audio_scope_attestations");
    expect(grants).toMatch(/revoke all privileges[\s\S]*from hyperion_lumen/);
    expect(grants).not.toMatch(/grant (?:insert|update|delete)[\s\S]*lumen\.schema_version/i);
  });

  it("rejects missing, reordered, or unknown provider migration files", () => {
    expect(() =>
      assertLumenProviderMigrationNames(["001-lumen-autonomous-baseline.sql", "002-lumen-runtime-role.sql"])
    ).not.toThrow();
    expect(() => assertLumenProviderMigrationNames(["001-lumen-autonomous-baseline.sql"])).toThrow(
      "migration set mismatch"
    );
    expect(() =>
      assertLumenProviderMigrationNames([
        "001-lumen-autonomous-baseline.sql",
        "002-lumen-runtime-role.sql",
        "003-foreign.sql"
      ])
    ).toThrow("migration set mismatch");
  });
});
