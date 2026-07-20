import { describe, expect, it, vi } from "vitest";
import { PULSO_MIGRATOR_ROLE, PULSO_RUNTIME_ROLE_DEFINITIONS, type PulsoRuntimePasswords } from "./config.js";

vi.mock("./schema-manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./schema-manifest.js")>();
  return { ...actual, assertPulsoRuntimeDatabaseSecurity: vi.fn(async () => ({ issues: [] })) };
});

import { applyPulsoRolePasswords } from "./roles.js";

const ALL_ROLES = [PULSO_MIGRATOR_ROLE, ...PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition) => definition.role)];
const CLEAN_ROLES = ALL_ROLES.map((rolname) => ({
  has_memberships: false,
  owns_out_of_scope_objects: false,
  rolname,
  unsafe_capabilities: false
}));
const PASSWORDS: PulsoRuntimePasswords = new Map(
  PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition, index) => [definition.role, `runtime-password-${index}-00000001`])
);

interface SchemaMarker {
  current_version: number;
  migration_name: string;
}

function createClient(
  options: {
    databaseOwner?: string;
    globalMarker?: SchemaMarker | null;
    roles?: typeof CLEAN_ROLES;
    sessions?: number;
  } = {}
) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push(sql);
    if (sql.includes("select pg_get_userbyid(datdba)")) {
      return { rows: [{ owner: options.databaseOwner ?? PULSO_MIGRATOR_ROLE }] };
    }
    if (sql.includes("from pg_roles role")) return { rows: options.roles ?? CLEAN_ROLES };
    if (sql.includes("from pg_stat_activity")) return { rows: [{ count: options.sessions ?? 0 }] };
    if (sql.includes("from agent_runtime.schema_version")) {
      throw new Error("PULSO role bootstrap must not read SOFÍA markers");
    }
    if (sql.includes("from pulso_iris.schema_version")) {
      const marker =
        options.globalMarker === undefined
          ? { current_version: 15, migration_name: "015-revoke-sofia-pulso-iris-control-plane-grants.sql" }
          : options.globalMarker;
      return { rows: marker ? [marker] : [] };
    }
    if (sql.startsWith("select format('alter role")) {
      return { rows: [{ statement: `alter role "${String(values?.[0])}" with login password 'redacted'` }] };
    }
    if (sql.startsWith("select format('set local role")) {
      return { rows: [{ statement: `set local role "${String(values?.[0])}"` }] };
    }
    return { rows: [] };
  });
  return { client: { query } as never, statements };
}

describe("PULSO runtime role bootstrap", () => {
  it("commits a five-role NOLOGIN fence before atomically rotating and validating every runtime", async () => {
    const { client, statements } = createClient();
    await applyPulsoRolePasswords(client, "hyperion_pulso", PASSWORDS);

    const firstCommit = statements.indexOf("commit");
    const fences = PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition) =>
      statements.indexOf(`alter role "${definition.role}" with nologin`)
    );
    expect(fences.every((index) => index > -1 && index < firstCommit)).toBe(true);
    expect(statements.filter((statement) => statement.includes("with login password 'redacted'"))).toHaveLength(5);
    expect(statements.filter((statement) => statement.startsWith('set local role "'))).toHaveLength(5);
  });

  it("leaves the committed fence in place when authority validation fails", async () => {
    const roles = CLEAN_ROLES.map((role, index) => (index === 3 ? { ...role, has_memberships: true } : role));
    const { client, statements } = createClient({ roles });
    await expect(applyPulsoRolePasswords(client, "hyperion_pulso", PASSWORDS)).rejects.toThrow(
      "unsafe role privilege matrix"
    );
    expect(statements.filter((statement) => statement.endsWith("with nologin"))).toHaveLength(5);
    expect(statements).toContain("rollback");
    expect(statements.some((statement) => statement.includes("with login password"))).toBe(false);
  });

  it("refuses activation while an old runtime session is active", async () => {
    const { client } = createClient({ sessions: 1 });
    await expect(applyPulsoRolePasswords(client, "hyperion_pulso", PASSWORDS)).rejects.toThrow(
      "requires all runtime sessions to be drained"
    );
  });

  it("refuses activation while the global PULSO marker is still at 002", async () => {
    const { client, statements } = createClient({
      globalMarker: { current_version: 2, migration_name: "002-pulso-runtime-roles.sql" }
    });
    await expect(applyPulsoRolePasswords(client, "hyperion_pulso", PASSWORDS)).rejects.toThrow(
      "PULSO role bootstrap requires its terminal provider-owned schema version"
    );
    expect(statements.some((statement) => statement.includes("with login password"))).toBe(false);
  });

  it("activates on the PULSO tip marker without reading SOFÍA schema_version", async () => {
    const { client, statements } = createClient({
      globalMarker: { current_version: 15, migration_name: "015-revoke-sofia-pulso-iris-control-plane-grants.sql" }
    });
    await expect(applyPulsoRolePasswords(client, "hyperion_pulso", PASSWORDS)).resolves.toBeUndefined();
    expect(statements.some((statement) => statement.includes("agent_runtime.schema_version"))).toBe(false);
  });

  it("requires all runtime passwords before acquiring the bootstrap lock", async () => {
    const { client, statements } = createClient();
    await expect(applyPulsoRolePasswords(client, "hyperion_pulso", new Map())).rejects.toThrow("Missing password");
    expect(statements).toHaveLength(0);
  });
});
