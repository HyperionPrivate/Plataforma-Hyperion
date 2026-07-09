import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeChecksum, listMigrationFiles } from "./runner.js";

describe("migrations runner", () => {
  it("computes the same checksum regardless of line endings", () => {
    const unix = "create table t (\n  id int\n);\n";
    const windows = "create table t (\r\n  id int\r\n);\r\n";

    expect(computeChecksum(windows)).toBe(computeChecksum(unix));
  });

  it("changes the checksum when content changes", () => {
    expect(computeChecksum("select 1")).not.toBe(computeChecksum("select 2"));
  });

  it("lists the repository migrations in order", async () => {
    const sqlDir = fileURLToPath(new URL("../sql", import.meta.url));
    const files = await listMigrationFiles(sqlDir);

    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files[0]).toBe("001-platform.sql");
    expect(files[1]).toBe("002-pulso-iris.sql");
    expect([...files].sort()).toEqual(files);
  });
});
