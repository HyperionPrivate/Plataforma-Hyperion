import { describe, expect, it, vi } from "vitest";
import {
  applyServiceRolePrivilegeMatrix,
  applyServiceRolePasswords,
  readServiceRolePasswords,
  SERVICE_DATABASE_ROLES,
  type ServiceRolePasswords
} from "./bootstrap-roles.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    SERVICE_DATABASE_ROLES.map((definition, index) => [
      definition.environmentVariable,
      `service-role-${index}-password-000000`
    ])
  );
}

function existingRoleRows(): Array<{ rolname: string }> {
  return SERVICE_DATABASE_ROLES.map((definition) => ({ rolname: definition.role }));
}

describe("service database role bootstrap configuration", () => {
  it("excludes the provider-owned Audit role from the seven-role global rotation unit", () => {
    expect(SERVICE_DATABASE_ROLES).toEqual([
      { environmentVariable: "ACCESS_DATABASE_PASSWORD", role: "hyperion_access" },
      { environmentVariable: "SOFIA_DATABASE_PASSWORD", role: "hyperion_sofia" },
      { environmentVariable: "KNOWLEDGE_DATABASE_PASSWORD", role: "hyperion_knowledge" },
      { environmentVariable: "INTEGRATION_DATABASE_PASSWORD", role: "hyperion_integration" },
      { environmentVariable: "PULSO_DATABASE_PASSWORD", role: "hyperion_pulso" },
      { environmentVariable: "CHANNEL_DATABASE_PASSWORD", role: "hyperion_channel" },
      { environmentVariable: "LUMEN_DATABASE_PASSWORD", role: "hyperion_lumen" }
    ]);
  });

  it("does not replay NOVA schema grants from the global bootstrap", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    const fakeClient = { query } as unknown as Parameters<typeof applyServiceRolePrivilegeMatrix>[0];

    await applyServiceRolePrivilegeMatrix(fakeClient);

    const matrix = String(query.mock.calls[0]?.[0] ?? "");
    expect(matrix).not.toMatch(/hyperion_(?:nova|voice|liwa|documents)/);
  });

  it("loads one distinct password for every fixed service role", () => {
    const passwords = readServiceRolePasswords(validEnvironment());

    expect([...passwords.keys()]).toEqual(SERVICE_DATABASE_ROLES.map((definition) => definition.role));
    expect(new Set(passwords.values()).size).toBe(SERVICE_DATABASE_ROLES.length);
  });

  it("rejects a missing or too-short password without including its value", () => {
    const environment = validEnvironment();
    environment.LUMEN_DATABASE_PASSWORD = "short-secret";

    expect(() => readServiceRolePasswords(environment)).toThrow(
      "LUMEN_DATABASE_PASSWORD must contain at least 24 RFC 3986 unreserved characters"
    );
  });

  it("rejects URI-reserved characters", () => {
    const environment = validEnvironment();
    environment.CHANNEL_DATABASE_PASSWORD = "channel/password-that-is-long-enough";

    expect(() => readServiceRolePasswords(environment)).toThrow("CHANNEL_DATABASE_PASSWORD");
  });

  it("rejects .env.example placeholders when NODE_ENV is production", () => {
    const environment = validEnvironment();
    environment.NODE_ENV = "production";
    environment.ACCESS_DATABASE_PASSWORD = "replace-access-db-secret-0001";

    expect(() => readServiceRolePasswords(environment)).toThrow(/placeholder secrets/);
  });

  it("accepts replace-* database passwords in development", () => {
    const environment = validEnvironment();
    environment.NODE_ENV = "development";
    environment.ACCESS_DATABASE_PASSWORD = "replace-access-db-secret-0001";

    expect(() => readServiceRolePasswords(environment)).not.toThrow();
  });

  it("rolls back instead of committing when a later role activation fails", async () => {
    let activationCount = 0;
    const statements: string[] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("select rolsuper, rolcreaterole")) {
        return { rows: [{ rolsuper: true, rolcreaterole: true }] };
      }
      if (sql.trimStart().startsWith("select rolname")) {
        return { rows: existingRoleRows() };
      }
      if (sql.includes('as "migrationApplied"')) {
        return {
          rows: [
            {
              migrationApplied: true,
              allRolesPresent: true,
              safeCapabilities: true,
              noMemberships: true,
              noOwnedObjects: true,
              noActiveSessions: true,
              uniformLoginState: true
            }
          ]
        };
      }
      if (sql.includes("select format(")) {
        return { rows: [{ statement: `alter role ${String(values?.[0])} with login` }] };
      }
      if (sql.startsWith("alter role ") && sql.includes(" with login")) {
        activationCount += 1;
        if (activationCount === 5) throw new Error("synthetic database failure");
      }
      return { rows: [] };
    });
    const fakeClient = { query } as unknown as Parameters<typeof applyServiceRolePasswords>[0];
    const passwords = readServiceRolePasswords(validEnvironment()) as ServiceRolePasswords;

    await expect(applyServiceRolePasswords(fakeClient, passwords)).rejects.toThrow(
      `could not create or rotate service role ${SERVICE_DATABASE_ROLES[4]!.role}`
    );

    expect(statements).toContain("begin");
    expect(statements).toContain("select pg_advisory_lock(hashtext('hyperion:service-role-bootstrap'))");
    expect(statements).toContain("select pg_advisory_unlock(hashtext('hyperion:service-role-bootstrap'))");
    expect(statements).toContain('alter role "hyperion_lumen" with nologin');
    expect(statements).toContain("rollback");
    expect(statements.at(-1)).toBe("select pg_advisory_unlock(hashtext('hyperion:service-role-bootstrap'))");
    expect(statements.filter((statement) => statement === "commit")).toHaveLength(1);
  });

  it("leaves every role fenced when an established service session has not drained", async () => {
    const statements: string[] = [];
    let prerequisiteChecks = 0;
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("select rolsuper, rolcreaterole")) {
        return { rows: [{ rolsuper: true, rolcreaterole: true }] };
      }
      if (sql.trimStart().startsWith("select rolname")) {
        return { rows: existingRoleRows() };
      }
      if (sql.includes('as "migrationApplied"')) {
        prerequisiteChecks += 1;
        return {
          rows: [
            {
              migrationApplied: true,
              allRolesPresent: true,
              safeCapabilities: true,
              noMemberships: true,
              noOwnedObjects: true,
              noActiveSessions: prerequisiteChecks === 1,
              uniformLoginState: true
            }
          ]
        };
      }
      return { rows: [] };
    });
    const fakeClient = { query } as unknown as Parameters<typeof applyServiceRolePasswords>[0];
    const passwords = readServiceRolePasswords(validEnvironment()) as ServiceRolePasswords;

    await expect(applyServiceRolePasswords(fakeClient, passwords)).rejects.toThrow(
      "requires all service sessions to be drained"
    );

    expect(
      statements.filter((statement) => statement.startsWith("alter role ") && statement.includes(" with nologin"))
    ).toHaveLength(SERVICE_DATABASE_ROLES.length);
    expect(
      statements.some((statement) => statement.startsWith("alter role ") && statement.includes(" with login"))
    ).toBe(false);
    expect(statements.filter((statement) => statement === "commit")).toHaveLength(1);
    expect(statements).toContain("rollback");
    expect(statements.at(-1)).toBe("select pg_advisory_unlock(hashtext('hyperion:service-role-bootstrap'))");
  });

  it("recovers a legacy partially activated role set through the NOLOGIN fence", async () => {
    const statements: string[] = [];
    let prerequisiteChecks = 0;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      statements.push(sql);
      if (sql.includes("select rolsuper, rolcreaterole")) {
        return { rows: [{ rolsuper: true, rolcreaterole: true }] };
      }
      if (sql.trimStart().startsWith("select rolname")) {
        return { rows: existingRoleRows() };
      }
      if (sql.includes('as "migrationApplied"')) {
        prerequisiteChecks += 1;
        return {
          rows: [
            {
              migrationApplied: true,
              allRolesPresent: true,
              safeCapabilities: true,
              noMemberships: true,
              noOwnedObjects: true,
              noActiveSessions: true,
              uniformLoginState: prerequisiteChecks > 1
            }
          ]
        };
      }
      if (sql.includes("select format(")) {
        return { rows: [{ statement: `alter role ${String(values?.[0])} with login` }] };
      }
      return { rows: [] };
    });
    const fakeClient = { query } as unknown as Parameters<typeof applyServiceRolePasswords>[0];
    const passwords = readServiceRolePasswords(validEnvironment()) as ServiceRolePasswords;

    await applyServiceRolePasswords(fakeClient, passwords);

    expect(statements.filter((statement) => statement === "commit")).toHaveLength(2);
    expect(
      statements.filter((statement) => statement.startsWith("alter role ") && statement.includes(" with login"))
    ).toHaveLength(SERVICE_DATABASE_ROLES.length);
    expect(statements.some((statement) => statement.includes("close_reason = 'bootstrap_reconciled'"))).toBe(true);
    expect(statements).not.toContain("rollback");
  });

  it("durably fences every existing service role before rejecting unsafe drift", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("select rolsuper, rolcreaterole")) {
        return { rows: [{ rolsuper: true, rolcreaterole: true }] };
      }
      if (sql.trimStart().startsWith("select rolname")) {
        return { rows: existingRoleRows() };
      }
      if (sql.includes('as "migrationApplied"')) {
        return {
          rows: [
            {
              migrationApplied: true,
              allRolesPresent: true,
              safeCapabilities: true,
              noMemberships: false,
              noOwnedObjects: true,
              noActiveSessions: true,
              uniformLoginState: true
            }
          ]
        };
      }
      return { rows: [] };
    });
    const fakeClient = { query } as unknown as Parameters<typeof applyServiceRolePasswords>[0];
    const passwords = readServiceRolePasswords(validEnvironment()) as ServiceRolePasswords;

    await expect(applyServiceRolePasswords(fakeClient, passwords)).rejects.toThrow("unsafe role privilege matrix");

    expect(
      statements.filter((statement) => statement.startsWith("alter role ") && statement.includes(" with nologin"))
    ).toHaveLength(SERVICE_DATABASE_ROLES.length);
    expect(
      statements.some((statement) => statement.startsWith("alter role ") && statement.includes(" with login"))
    ).toBe(false);
    expect(statements.filter((statement) => statement === "commit")).toHaveLength(1);
    expect(statements.at(-1)).toBe("select pg_advisory_unlock(hashtext('hyperion:service-role-bootstrap'))");
  });
});
