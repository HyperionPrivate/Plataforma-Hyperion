import { describe, expect, it } from "vitest";
import {
  readAccessMigratorDatabaseUrl,
  readAccessMigratorPassword,
  readAccessPostgresAdminUrl,
  readAccessPostgresDatabase,
  readAccessRolePasswords
} from "./config.js";

describe("Access migration configuration", () => {
  it("reads the isolated logical-database contract", () => {
    const environment = {
      ACCESS_MIGRATOR_DATABASE_URL: "postgresql://hyperion_access_migrator:secret@db/hyperion_access",
      ACCESS_POSTGRES_ADMIN_URL: "postgresql://admin:secret@db/postgres",
      ACCESS_POSTGRES_DB: "hyperion_access",
      ACCESS_MIGRATOR_DATABASE_PASSWORD: "access-migrator-password-0001",
      IDENTITY_DATABASE_PASSWORD: "identity-runtime-password-001",
      TENANT_DATABASE_PASSWORD: "tenant-runtime-password-00002"
    };
    expect(readAccessMigratorDatabaseUrl(environment)).toContain("/hyperion_access");
    expect(readAccessPostgresAdminUrl(environment)).toContain("/postgres");
    expect(readAccessPostgresDatabase(environment)).toBe("hyperion_access");
    expect(readAccessMigratorPassword(environment)).toBe("access-migrator-password-0001");
    expect([...readAccessRolePasswords(environment)]).toEqual([
      ["hyperion_identity", "identity-runtime-password-001"],
      ["hyperion_tenant", "tenant-runtime-password-00002"]
    ]);
  });

  it("does not fall back to global database variables or a shared Access password", () => {
    expect(() => readAccessMigratorDatabaseUrl({ DATABASE_URL: "postgresql://admin:secret@db/global" })).toThrow(
      "ACCESS_MIGRATOR_DATABASE_URL is required"
    );
    expect(() => readAccessPostgresDatabase({ POSTGRES_DB: "hyperion" })).toThrow(
      "ACCESS_POSTGRES_DB must be a safe lowercase PostgreSQL database name"
    );
    expect(() => readAccessRolePasswords({ ACCESS_DATABASE_PASSWORD: "shared-access-password-0001" })).toThrow(
      "IDENTITY_DATABASE_PASSWORD"
    );
  });

  it("binds migration and administration URLs to their exact identities", () => {
    expect(() =>
      readAccessMigratorDatabaseUrl({
        ACCESS_MIGRATOR_DATABASE_URL: "postgresql://postgres:secret@db/hyperion_access",
        ACCESS_POSTGRES_DB: "hyperion_access"
      })
    ).toThrow("must authenticate as hyperion_access_migrator");
    expect(() =>
      readAccessMigratorDatabaseUrl({
        ACCESS_MIGRATOR_DATABASE_URL: "postgresql://hyperion_access_migrator:secret@db/hyperion",
        ACCESS_POSTGRES_DB: "hyperion_access"
      })
    ).toThrow("must target ACCESS_POSTGRES_DB");
    expect(() =>
      readAccessPostgresAdminUrl({
        ACCESS_POSTGRES_ADMIN_URL: "postgresql://hyperion_identity:secret@db/postgres"
      })
    ).toThrow("separate PostgreSQL administrator identity");
    expect(() =>
      readAccessMigratorDatabaseUrl({
        ACCESS_MIGRATOR_DATABASE_URL: "postgresql://hyperion_access_migrator:secret@db/hyperion_access?user=postgres",
        ACCESS_POSTGRES_DB: "hyperion_access"
      })
    ).toThrow("must not override connection identity");
    expect(() =>
      readAccessPostgresAdminUrl({
        ACCESS_POSTGRES_ADMIN_URL: "postgresql://postgres:secret@db/postgres?database=hyperion_access"
      })
    ).toThrow("must not override connection identity");
  });

  it("rejects reused runtime credentials and production placeholders", () => {
    expect(() =>
      readAccessRolePasswords({
        ACCESS_MIGRATOR_DATABASE_PASSWORD: "access-migrator-password-0001",
        IDENTITY_DATABASE_PASSWORD: "same-runtime-password-00001",
        TENANT_DATABASE_PASSWORD: "same-runtime-password-00001"
      })
    ).toThrow("must all be distinct");
    expect(() =>
      readAccessRolePasswords({
        ACCESS_MIGRATOR_DATABASE_PASSWORD: "same-migrator-password-0001",
        IDENTITY_DATABASE_PASSWORD: "same-migrator-password-0001",
        TENANT_DATABASE_PASSWORD: "tenant-runtime-password-00002"
      })
    ).toThrow("must all be distinct");
    expect(() =>
      readAccessMigratorPassword({
        HYPERION_ENVIRONMENT: "production",
        ACCESS_MIGRATOR_DATABASE_PASSWORD: "replace-access-migrator-0001"
      })
    ).toThrow("must not use a placeholder");
  });
});
