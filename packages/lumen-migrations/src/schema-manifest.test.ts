import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeLumenMigrationChecksum, runLumenMigrationsWithClient, type LumenMigrationClient } from "./runner.js";
import {
  createLumenStructuralManifest,
  evaluateLumenSchemaSnapshot,
  evaluateLumenRuntimeSecurity,
  LUMEN_BASELINE_MIGRATION,
  LUMEN_CURRENT_MIGRATION,
  LUMEN_SCHEMA_MANIFEST,
  LUMEN_RUNTIME_TABLE_PRIVILEGES,
  type LumenAclRow,
  type LumenMigrationLedgerRow,
  type LumenRoleSecurityRow,
  type LumenSchemaCatalogRow,
  type LumenSchemaManifestSet
} from "./schema-manifest.js";

const schemaRow = row("schema", "lumen", "present");
const legacyRows: LumenSchemaCatalogRow[] = [
  schemaRow,
  row("table", "schema_version", '{"kind":"r"}'),
  row("column", "schema_version.current_version", '{"ordinal":2,"type":"integer","notNull":true}'),
  row("function", "guard_synthetic_encounter()", "CREATE FUNCTION lumen.guard_synthetic_encounter() RETURNS trigger"),
  row("trigger", "encounters.trg_guard_synthetic_encounter", "CREATE TRIGGER trg_guard_synthetic_encounter"),
  row("index", "encounters.encounters_pkey", "CREATE UNIQUE INDEX encounters_pkey ON lumen.encounters (id)"),
  row("constraint", "encounters.ck_lumen_encounter_synthetic_only", "CHECK (is_demo AND demo_key IS NOT NULL)")
];
const managedRows: LumenSchemaCatalogRow[] = [
  ...legacyRows,
  row("table", "migration_ledger", '{"kind":"r"}'),
  row("column", "migration_ledger.name", '{"ordinal":1,"type":"text","notNull":true}'),
  row("index", "migration_ledger.migration_ledger_pkey", "CREATE UNIQUE INDEX migration_ledger_pkey"),
  row("constraint", "migration_ledger.migration_ledger_pkey", "PRIMARY KEY (name)")
];
const fixtureManifests: LumenSchemaManifestSet = {
  legacy: createLumenStructuralManifest(legacyRows),
  managed: createLumenStructuralManifest(managedRows)
};
const sqlDirectory = fileURLToPath(new URL("../sql/", import.meta.url));

describe("LUMEN fail-closed schema manifest", () => {
  it("accepts only the exact synthetic legacy fixture", () => {
    const inspection = evaluateLumenSchemaSnapshot(
      legacyRows,
      [{ current_version: 39, migration_name: "039-lumen-unresolved-cleanup-owner-index.sql" }],
      [],
      fixtureManifests
    );
    expect(inspection.state).toBe("legacy");
    expect(inspection.issues).toEqual([]);
  });

  it.each([
    [
      "function",
      "guard_synthetic_encounter()",
      "CREATE FUNCTION lumen.guard_synthetic_encounter() RETURNS trigger AS 'changed'"
    ],
    ["index", "encounters.encounters_pkey", "CREATE INDEX encounters_pkey ON lumen.encounters (id)"],
    ["constraint", "encounters.ck_lumen_encounter_synthetic_only", "CHECK (is_demo)"]
  ] as const)("rejects a mutated %s before issuing any database mutation", async (category, identity, definition) => {
    const catalog = legacyRows.map((entry) =>
      entry.category === category && entry.identity === identity ? { ...entry, definition } : { ...entry }
    );
    const client = new CatalogFixtureClient(catalog, 39, []);

    await expect(runLumenMigrationsWithClient(client, sqlDirectory, fixtureManifests)).rejects.toThrow(
      `${category} structural fingerprint mismatch`
    );
    expect(client.mutatingQueries()).toEqual([]);
  });

  it("rejects a managed version that is inconsistent with its exact ledger without applying the next migration", async () => {
    const baselineSql = await readFile(new URL("../sql/001-lumen-autonomous-baseline.sql", import.meta.url), "utf8");
    const client = new CatalogFixtureClient(managedRows, 999, [
      { name: LUMEN_BASELINE_MIGRATION, checksum: computeLumenMigrationChecksum(baselineSql) }
    ]);

    await expect(runLumenMigrationsWithClient(client, sqlDirectory, fixtureManifests)).rejects.toThrow(
      "schema_version is inconsistent with the ledger"
    );
    expect(client.mutatingQueries()).toEqual([]);
  });

  it("rejects unknown or non-prefix ledger entries without mutating the catalog", async () => {
    const baselineSql = await readFile(new URL("../sql/001-lumen-autonomous-baseline.sql", import.meta.url), "utf8");
    const client = new CatalogFixtureClient(managedRows, 39, [
      { name: LUMEN_BASELINE_MIGRATION, checksum: computeLumenMigrationChecksum(baselineSql) },
      { name: "999-foreign.sql", checksum: "a".repeat(64) }
    ]);

    await expect(runLumenMigrationsWithClient(client, sqlDirectory, fixtureManifests)).rejects.toThrow("exact prefix");
    expect(client.mutatingQueries()).toEqual([]);
  });

  it("keeps ownership and PUBLIC privileges outside the structural fingerprint but inside the security gate", () => {
    const unsafe = legacyRows.map((entry) =>
      entry.category === "function"
        ? { ...entry, owner: "foreign_owner", owner_is_current_user: false, public_privileged: true }
        : { ...entry }
    );
    const inspection = evaluateLumenSchemaSnapshot(
      unsafe,
      [{ current_version: 39, migration_name: "039-lumen-unresolved-cleanup-owner-index.sql" }],
      [],
      fixtureManifests
    );
    expect(inspection.state).toBe("incompatible");
    expect(inspection.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("not owned by current_user"),
        expect.stringContaining("critical privilege to PUBLIC")
      ])
    );
  });

  it("lets runtime verify the managed structure without ledger SELECT while requiring exact v40 provenance", () => {
    const runtimeRows = managedRows.map((entry) => ({ ...entry, owner_is_current_user: false }));
    const valid = evaluateLumenSchemaSnapshot(
      runtimeRows,
      [{ current_version: 40, migration_name: LUMEN_CURRENT_MIGRATION }],
      [],
      fixtureManifests,
      "runtime"
    );
    expect(valid.state).toBe("managed");
    expect(valid.issues).toEqual([]);

    const staleProvenance = evaluateLumenSchemaSnapshot(
      runtimeRows,
      [{ current_version: 40, migration_name: "foreign.sql" }],
      [],
      fixtureManifests,
      "runtime"
    );
    expect(staleProvenance.state).toBe("incompatible");
    expect(staleProvenance.issues).toContain(`runtime requires LUMEN migration ${LUMEN_CURRENT_MIGRATION}`);
  });

  it("rejects runtime capability, direct ACL and function EXECUTE drift", () => {
    const role = runtimeSecurityRole();
    const acl = runtimeAclFixture();
    expect(evaluateLumenRuntimeSecurity(role, acl)).toEqual([]);

    const driftedAcl = acl.map((entry) => {
      if (entry.category === "table" && entry.identity === "service_migrations") {
        return { ...entry, privileges: ["INSERT", "SELECT"], direct_privileges: ["INSERT", "SELECT"] };
      }
      if (entry.category === "function" && entry.identity === "guard_synthetic_encounter()") {
        return { ...entry, privileges: ["EXECUTE"], direct_privileges: ["EXECUTE:GRANT"] };
      }
      return entry;
    });
    driftedAcl.push({
      category: "column",
      identity: "service_migrations.name",
      privileges: ["UPDATE"],
      direct_privileges: ["UPDATE"]
    });
    const issues = evaluateLumenRuntimeSecurity(
      { ...role, has_memberships: true, public_database_privileges: ["CONNECT"] },
      driftedAcl
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("membership"),
        expect.stringContaining("grants privileges to PUBLIC"),
        expect.stringContaining("table:service_migrations effective privileges"),
        expect.stringContaining("unexpected runtime ACL object column:service_migrations.name"),
        expect.stringContaining("function:guard_synthetic_encounter() effective privileges"),
        expect.stringContaining("function:guard_synthetic_encounter() direct privileges")
      ])
    );
  });

  it("canonicalizes a legacy adoption so a crash before 002 is safely resumable", async () => {
    const baselineSql = await readFile(new URL("../sql/001-lumen-autonomous-baseline.sql", import.meta.url), "utf8");
    const client = new RecoveryFixtureClient(computeLumenMigrationChecksum(baselineSql));

    await expect(runLumenMigrationsWithClient(client, sqlDirectory, fixtureManifests)).rejects.toThrow(
      "simulated 002 interruption"
    );
    expect(client.state()).toEqual({
      ledger: [LUMEN_BASELINE_MIGRATION],
      version: 39,
      migrationName: LUMEN_BASELINE_MIGRATION
    });

    const resumed = await runLumenMigrationsWithClient(client, sqlDirectory, fixtureManifests);
    expect(resumed).toEqual({
      applied: [LUMEN_CURRENT_MIGRATION],
      adopted: [],
      skipped: [LUMEN_BASELINE_MIGRATION]
    });
    expect(client.state()).toEqual({
      ledger: [LUMEN_BASELINE_MIGRATION, LUMEN_CURRENT_MIGRATION],
      version: 40,
      migrationName: LUMEN_CURRENT_MIGRATION
    });
  });
});

class CatalogFixtureClient implements LumenMigrationClient {
  readonly queries: string[] = [];

  constructor(
    private readonly catalog: LumenSchemaCatalogRow[],
    private readonly version: number,
    private readonly ledger: LumenMigrationLedgerRow[]
  ) {}

  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
    this.queries.push(sql);
    if (sql.includes("unsafe_capabilities")) return { rows: [migratorSecurityRole()] as T[] };
    if (sql.includes("with target_namespace as")) return { rows: this.catalog as T[] };
    if (sql.includes("from lumen.schema_version")) {
      return { rows: [{ current_version: this.version, migration_name: "fixture.sql" }] as T[] };
    }
    if (sql.includes("from lumen.migration_ledger")) return { rows: this.ledger as T[] };
    if (sql.includes("pg_advisory_lock") || sql.includes("pg_advisory_unlock") || sql.includes("set_config")) {
      return { rows: [] };
    }
    throw new Error(`Unexpected fixture query: ${sql.slice(0, 80)}`);
  }

  mutatingQueries(): string[] {
    return this.queries.filter((sql) =>
      /^(?:begin|commit|rollback|create|alter|drop|insert|update|delete|revoke|grant)\b/i.test(sql.trim())
    );
  }
}

class RecoveryFixtureClient implements LumenMigrationClient {
  private catalog = legacyRows.map((entry) => ({ ...entry }));
  private version = 39;
  private migrationName = "039-lumen-unresolved-cleanup-owner-index.sql";
  private ledger: LumenMigrationLedgerRow[] = [];
  private failCurrentMigration = true;
  private transactionSnapshot?: {
    catalog: LumenSchemaCatalogRow[];
    version: number;
    migrationName: string;
    ledger: LumenMigrationLedgerRow[];
  };

  constructor(private readonly baselineChecksum: string) {}

  async query<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    const normalized = sql.trim().toLowerCase();
    if (sql.includes("unsafe_capabilities")) return { rows: [migratorSecurityRole()] as T[] };
    if (sql.includes("with target_namespace as")) return { rows: this.catalog as T[] };
    if (sql.includes("from lumen.schema_version")) {
      return { rows: [{ current_version: this.version, migration_name: this.migrationName }] as T[] };
    }
    if (sql.includes("from lumen.migration_ledger")) return { rows: this.ledger as T[] };
    if (sql.includes("pg_advisory_lock") || sql.includes("pg_advisory_unlock") || sql.includes("set_config")) {
      return { rows: [] };
    }
    if (normalized === "begin") {
      this.transactionSnapshot = {
        catalog: this.catalog.map((entry) => ({ ...entry })),
        version: this.version,
        migrationName: this.migrationName,
        ledger: this.ledger.map((entry) => ({ ...entry }))
      };
      return { rows: [] };
    }
    if (normalized === "commit") {
      this.transactionSnapshot = undefined;
      return { rows: [] };
    }
    if (normalized === "rollback") {
      if (this.transactionSnapshot) {
        this.catalog = this.transactionSnapshot.catalog;
        this.version = this.transactionSnapshot.version;
        this.migrationName = this.transactionSnapshot.migrationName;
        this.ledger = this.transactionSnapshot.ledger;
      }
      this.transactionSnapshot = undefined;
      return { rows: [] };
    }
    if (normalized.startsWith("create table lumen.migration_ledger")) {
      this.catalog = managedRows.map((entry) => ({ ...entry }));
      return { rows: [] };
    }
    if (sql.includes("values (40, '002-lumen-runtime-role.sql')")) {
      if (this.failCurrentMigration) {
        this.failCurrentMigration = false;
        throw new Error("simulated 002 interruption");
      }
      this.version = 40;
      this.migrationName = LUMEN_CURRENT_MIGRATION;
      return { rows: [] };
    }
    if (sql.includes("insert into lumen.service_migrations")) return { rows: [] };
    if (sql.includes("insert into lumen.schema_version") && values[0] === 39) {
      this.version = 39;
      this.migrationName = String(values[1]);
      return { rows: [] };
    }
    if (sql.includes("insert into lumen.migration_ledger")) {
      this.ledger.push({ name: String(values[0]), checksum: String(values[1]) });
      return { rows: [] };
    }
    throw new Error(`Unexpected recovery fixture query: ${sql.slice(0, 80)}`);
  }

  state(): { ledger: string[]; version: number; migrationName: string } {
    return { ledger: this.ledger.map((entry) => entry.name), version: this.version, migrationName: this.migrationName };
  }
}

function row(category: LumenSchemaCatalogRow["category"], identity: string, definition: string): LumenSchemaCatalogRow {
  return {
    category,
    identity,
    definition,
    owner: "hyperion_lumen_migrator",
    owner_is_current_user: true,
    public_privileged: false,
    valid: true,
    ready: true
  };
}

function migratorSecurityRole(): LumenRoleSecurityRow {
  return {
    current_user: "hyperion_lumen_migrator",
    can_login: true,
    unsafe_capabilities: false,
    has_memberships: false,
    owns_current_database: true,
    owns_other_database: false,
    owns_lumen_objects: true,
    owns_non_lumen_objects: false,
    can_connect_database: true,
    can_create_in_database: true,
    can_create_temporary: true,
    public_database_privileges: []
  };
}

function runtimeSecurityRole(): LumenRoleSecurityRow {
  return {
    current_user: "hyperion_lumen",
    can_login: true,
    unsafe_capabilities: false,
    has_memberships: false,
    owns_current_database: false,
    owns_other_database: false,
    owns_lumen_objects: false,
    owns_non_lumen_objects: false,
    can_connect_database: true,
    can_create_in_database: false,
    can_create_temporary: false,
    public_database_privileges: []
  };
}

function runtimeAclFixture(): LumenAclRow[] {
  const rows: LumenAclRow[] = [
    { category: "database", identity: "hyperion_lumen", privileges: ["CONNECT"], direct_privileges: ["CONNECT"] },
    { category: "schema", identity: "lumen", privileges: ["USAGE"], direct_privileges: ["USAGE"] }
  ];
  for (const [identity, privileges] of Object.entries(LUMEN_RUNTIME_TABLE_PRIVILEGES)) {
    rows.push({ category: "table", identity, privileges: [...privileges], direct_privileges: [...privileges] });
  }
  for (const identity of LUMEN_SCHEMA_MANIFEST.managed.function.identities ?? []) {
    rows.push({ category: "function", identity, privileges: [], direct_privileges: [] });
  }
  return rows;
}
