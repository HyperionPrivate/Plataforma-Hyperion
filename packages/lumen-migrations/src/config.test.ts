import { describe, expect, it } from "vitest";
import {
  readLumenMigratorDatabaseUrl,
  readLumenMigratorPassword,
  readLumenPostgresAdminUrl,
  readLumenPostgresDatabase,
  readLumenRuntimePassword
} from "./config.js";

describe("LUMEN migration configuration", () => {
  it("requires only LUMEN-owned database credentials", () => {
    expect(
      readLumenMigratorDatabaseUrl({
        LUMEN_MIGRATOR_DATABASE_URL: "postgresql://hyperion_lumen_migrator:secret@db/hyperion_lumen"
      })
    ).toContain("hyperion_lumen");
    expect(readLumenPostgresAdminUrl({ LUMEN_POSTGRES_ADMIN_URL: "postgresql://admin:secret@db/postgres" })).toContain(
      "/postgres"
    );
    expect(readLumenPostgresDatabase({ LUMEN_POSTGRES_DB: "hyperion_lumen" })).toBe("hyperion_lumen");
    expect(readLumenMigratorPassword({ LUMEN_MIGRATOR_DATABASE_PASSWORD: "migrator-password-00000001" })).toBe(
      "migrator-password-00000001"
    );
    expect(readLumenRuntimePassword({ LUMEN_DATABASE_PASSWORD: "runtime-password-000000001" })).toBe(
      "runtime-password-000000001"
    );
  });

  it("does not fall back to global database variables", () => {
    expect(() => readLumenMigratorDatabaseUrl({ DATABASE_URL: "postgresql://admin:secret@db/global" })).toThrow(
      "LUMEN_MIGRATOR_DATABASE_URL is required"
    );
    expect(() => readLumenRuntimePassword({ NOVA_DATABASE_PASSWORD: "nova-password-000000000001" })).toThrow(
      "LUMEN_DATABASE_PASSWORD"
    );
  });
});
