import { describe, expect, it } from "vitest";
import {
  readAuditMigratorDatabaseUrl,
  readAuditMigratorPassword,
  readAuditPostgresAdminUrl,
  readAuditPostgresDatabase,
  readAuditRuntimePassword
} from "./config.js";

describe("Audit migration configuration", () => {
  it("requires only Audit-owned database credentials", () => {
    expect(
      readAuditMigratorDatabaseUrl({
        AUDIT_MIGRATOR_DATABASE_URL: "postgresql://hyperion_audit_migrator:secret@db/hyperion_audit"
      })
    ).toContain("hyperion_audit");
    expect(readAuditPostgresAdminUrl({ AUDIT_POSTGRES_ADMIN_URL: "postgresql://admin:secret@db/postgres" })).toContain(
      "/postgres"
    );
    expect(readAuditPostgresDatabase({ AUDIT_POSTGRES_DB: "hyperion_audit" })).toBe("hyperion_audit");
    expect(readAuditMigratorPassword({ AUDIT_MIGRATOR_DATABASE_PASSWORD: "migrator-password-00000001" })).toBe(
      "migrator-password-00000001"
    );
    expect(readAuditRuntimePassword({ AUDIT_DATABASE_PASSWORD: "runtime-password-000000001" })).toBe(
      "runtime-password-000000001"
    );
  });

  it("does not fall back to global or product database variables", () => {
    expect(() => readAuditMigratorDatabaseUrl({ DATABASE_URL: "postgresql://admin:secret@db/global" })).toThrow(
      "AUDIT_MIGRATOR_DATABASE_URL is required"
    );
    expect(() => readAuditRuntimePassword({ NOVA_DATABASE_PASSWORD: "nova-password-000000000001" })).toThrow(
      "AUDIT_DATABASE_PASSWORD"
    );
  });
});
