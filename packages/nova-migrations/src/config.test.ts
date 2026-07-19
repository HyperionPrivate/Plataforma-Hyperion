import { describe, expect, it } from "vitest";
import {
  NOVA_CELL_DATABASE_ROLES,
  readNovaMigratorDatabaseUrl,
  readNovaMigratorPassword,
  readNovaPostgresAdminUrl,
  readNovaPostgresDatabase,
  readNovaRolePasswords
} from "./config.js";

describe("NOVA migration configuration", () => {
  it("requires only NOVA-cell role passwords", () => {
    const environment: NodeJS.ProcessEnv = {
      NOVA_DATABASE_PASSWORD: "nova-password-000000000001",
      VOICE_DATABASE_PASSWORD: "voice-password-00000000001",
      LIWA_DATABASE_PASSWORD: "liwa-password-000000000001",
      DOCUMENTS_DATABASE_PASSWORD: "documents-password-00000001"
    };
    const passwords = readNovaRolePasswords(environment);

    expect([...passwords.keys()]).toEqual(NOVA_CELL_DATABASE_ROLES.map(({ role }) => role));
    expect(Object.keys(environment).sort()).toEqual(
      NOVA_CELL_DATABASE_ROLES.map(({ environmentVariable }) => environmentVariable).sort()
    );
  });

  it("uses a NOVA-specific migrator URL", () => {
    expect(readNovaMigratorDatabaseUrl({ NOVA_MIGRATOR_DATABASE_URL: "postgresql://admin:secret@db/nova" })).toBe(
      "postgresql://admin:secret@db/nova"
    );
    expect(() => readNovaMigratorDatabaseUrl({ DATABASE_URL: "postgresql://admin:secret@db/global" })).toThrow(
      "NOVA_MIGRATOR_DATABASE_URL is required"
    );
  });

  it("separates admin bootstrap, logical database and migrator credentials", () => {
    expect(readNovaPostgresAdminUrl({ NOVA_POSTGRES_ADMIN_URL: "postgresql://admin:secret@db/postgres" })).toBe(
      "postgresql://admin:secret@db/postgres"
    );
    expect(readNovaPostgresDatabase({ NOVA_POSTGRES_DB: "hyperion_nova" })).toBe("hyperion_nova");
    expect(readNovaMigratorPassword({ NOVA_MIGRATOR_DATABASE_PASSWORD: "migrator-password-00000001" })).toBe(
      "migrator-password-00000001"
    );
  });
});
