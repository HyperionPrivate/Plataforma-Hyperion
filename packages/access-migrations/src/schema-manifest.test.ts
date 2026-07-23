import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCESS_CURRENT_MIGRATION,
  ACCESS_FRESH_BASELINE_MIGRATION,
  ACCESS_FRESH_PROVIDER_LEDGER,
  ACCESS_RUNTIME_MIGRATION_REQUIREMENT
} from "./schema-manifest.js";

describe("Access runtime migration manifest", () => {
  it("pins readiness to the complete fresh provider ledger", async () => {
    const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    expect(files.at(-1)).toBe(ACCESS_CURRENT_MIGRATION);
    expect(ACCESS_RUNTIME_MIGRATION_REQUIREMENT).toEqual({
      schema: "access_runtime",
      migrationNames: [
        "001-access-fresh-baseline.sql",
        "002-access-runtime-role-boundary.sql",
        "003-access-tenant-projection.sql",
        "004-access-tenant-lifecycle-integrity.sql",
        "005-access-jwt-denylist.sql"
      ],
      exactMigrationLedger: [
        {
          name: "001-access-fresh-baseline.sql",
          checksum: "e24c32b0055a84f319328ed524a25f6ccd348db0bbd1dbd864dbb29bd7b42328"
        },
        {
          name: "002-access-runtime-role-boundary.sql",
          checksum: "3abcdfac4af18a3cbb4066741198d601a6e1b4a57c014c41dba7f5fc849ce24d"
        },
        {
          name: "003-access-tenant-projection.sql",
          checksum: "5fb558a7d36899e98e532b22e0134665187f3c4db75f63a155cfe9d31821e7c8"
        },
        {
          name: "004-access-tenant-lifecycle-integrity.sql",
          checksum: "c17283b147bcc57cd66e040e4b8f91e20285667f4c2dd1d23c16671b55d61a08"
        },
        {
          name: "005-access-jwt-denylist.sql",
          checksum: "3c88553e9d4d5a6085b8e80c5ef2a7d4391e02fac30ee1ff0c26b0f33e92c7a7"
        }
      ]
    });
    expect(ACCESS_RUNTIME_MIGRATION_REQUIREMENT.migrationNames).toEqual(files);
    expect(Object.isFrozen(ACCESS_RUNTIME_MIGRATION_REQUIREMENT.migrationNames)).toBe(true);
    expect(Object.isFrozen(ACCESS_FRESH_PROVIDER_LEDGER)).toBe(true);
  });

  it("keeps readiness down when a forged terminal row exists without the baseline", () => {
    const applied = new Set([ACCESS_CURRENT_MIGRATION]);
    const missing = ACCESS_RUNTIME_MIGRATION_REQUIREMENT.migrationNames.find((name) => !applied.has(name));
    expect(missing).toBe(ACCESS_FRESH_BASELINE_MIGRATION);
    expect(ACCESS_RUNTIME_MIGRATION_REQUIREMENT).not.toHaveProperty("compatibleMigrationNameSets");
  });
});
