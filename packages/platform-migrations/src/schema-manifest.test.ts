import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCESS_CURRENT_MIGRATION, ACCESS_RUNTIME_MIGRATION_REQUIREMENT } from "./schema-manifest.js";

describe("Access migration runtime manifest", () => {
  it("pins readiness to the terminal provider-owned migration", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const migrationFiles = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();

    expect(migrationFiles.at(-1)).toBe(ACCESS_CURRENT_MIGRATION);
    expect(ACCESS_RUNTIME_MIGRATION_REQUIREMENT).toEqual({
      schema: "access_runtime",
      migrationNames: [ACCESS_CURRENT_MIGRATION]
    });
    expect(Object.isFrozen(ACCESS_RUNTIME_MIGRATION_REQUIREMENT)).toBe(true);
    expect(Object.isFrozen(ACCESS_RUNTIME_MIGRATION_REQUIREMENT.migrationNames)).toBe(true);
  });

  it("keeps the public runtime subpath pure and separate from the migrator entrypoint", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      exports?: Record<string, { import?: string; types?: string }>;
    };
    const source = await readFile(new URL("./schema-manifest.ts", import.meta.url), "utf8");

    expect(packageJson.exports?.["./schema-manifest"]).toEqual({
      types: "./dist/schema-manifest.d.ts",
      import: "./dist/schema-manifest.js"
    });
    expect(source).not.toMatch(/(?:from|import\()\s*["'](?:pg|\.\/runner|\.\/config|\.\/index)/);
  });
});
