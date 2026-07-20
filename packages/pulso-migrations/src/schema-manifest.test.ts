import { describe, expect, it } from "vitest";
import { PULSO_MIGRATOR_ROLE, PULSO_RUNTIME_ROLE_DEFINITIONS, type PulsoRuntimeRole } from "./config.js";
import {
  comparePulsoCatalogToManifest,
  createPulsoStructuralManifest,
  evaluatePulsoRuntimeSecurity,
  evaluatePulsoSchemaSnapshot,
  PULSO_BASELINE_MIGRATION,
  PULSO_CURRENT_MIGRATION,
  PULSO_CURRENT_SCHEMA_VERSION,
  PULSO_FUNCTIONS,
  PULSO_MANAGED_SCHEMA_MANIFEST_001,
  PULSO_MANAGED_SCHEMA_MANIFEST_002,
  PULSO_MANAGED_SCHEMA_MANIFEST_003,
  PULSO_MANAGED_SCHEMA_MANIFEST_004,
  PULSO_MANAGED_SCHEMA_MANIFEST_005,
  PULSO_MANAGED_SCHEMA_MANIFEST_006,
  PULSO_PROVIDER_SCHEMAS,
  PULSO_RUNTIME_POLICIES,
  PULSO_SCHEMA_MANIFEST,
  summarizePulsoCatalog,
  type PulsoAclRow,
  type PulsoRoleSecurityRow,
  type PulsoSchemaCatalogRow
} from "./schema-manifest.js";

function row(
  category: PulsoSchemaCatalogRow["category"],
  identity: string,
  definition = "definition"
): PulsoSchemaCatalogRow {
  return {
    category,
    identity,
    definition,
    owner: PULSO_MIGRATOR_ROLE,
    owner_is_current_user: true,
    public_privileged: false,
    valid: true,
    ready: true
  };
}

const SCHEMAS = PULSO_PROVIDER_SCHEMAS.map((schema) => row("schema", schema, "present"));

describe("PULSO structural manifest", () => {
  it("fingerprints definitions, validity and readiness for every catalog category", () => {
    const catalog = [
      ...SCHEMAS,
      row("extension", "btree_gist", "v1.7"),
      row("table", "pulso_iris.messages"),
      row("column", "pulso_iris.messages.id", "uuid not null"),
      row("function", "pulso_iris.prepare_ordered_message_outbox_event()"),
      row("trigger", "pulso_iris.outbox_events.prepare_ordered"),
      row("index", "pulso_iris.messages.messages_pkey"),
      row("constraint", "pulso_iris.messages.messages_pkey")
    ];
    const manifest = createPulsoStructuralManifest(catalog);
    expect(comparePulsoCatalogToManifest(catalog, manifest)).toEqual([]);

    for (const category of ["extension", "table", "column", "function", "trigger", "index", "constraint"] as const) {
      const drifted = catalog.map((entry) =>
        entry.category === category ? { ...entry, definition: `${entry.definition}:drift` } : entry
      );
      expect(comparePulsoCatalogToManifest(drifted, manifest)).toContain(`${category} structural fingerprint mismatch`);
    }
  });

  it("distinguishes fresh, exact legacy and provider-managed states", () => {
    const freshCatalog = PULSO_PROVIDER_SCHEMAS.map((schema) => row("schema", schema, "absent"));
    const emptyManifest = createPulsoStructuralManifest(freshCatalog);
    const manifests = { legacy: emptyManifest, managed: emptyManifest };
    expect(evaluatePulsoSchemaSnapshot(freshCatalog, [], [], manifests).state).toBe("fresh");

    const legacyCatalog = [...SCHEMAS, row("table", "pulso_iris.messages")];
    const legacyManifest = createPulsoStructuralManifest(legacyCatalog);
    expect(
      evaluatePulsoSchemaSnapshot(legacyCatalog, [], [], { legacy: legacyManifest, managed: legacyManifest }).state
    ).toBe("legacy");

    const managedCatalog = [
      ...legacyCatalog,
      row("table", "pulso_iris.schema_version"),
      row("table", "pulso_iris.migration_ledger")
    ];
    const managedManifest = createPulsoStructuralManifest(managedCatalog);
    const managed = evaluatePulsoSchemaSnapshot(
      managedCatalog,
      [{ current_version: PULSO_CURRENT_SCHEMA_VERSION, migration_name: PULSO_CURRENT_MIGRATION }],
      [{ name: PULSO_BASELINE_MIGRATION, checksum: "a".repeat(64) }],
      { legacy: legacyManifest, managed: managedManifest }
    );
    expect(managed.state).toBe("managed");
  });

  it("has no LUMEN clinical inventory in the production manifest identities", () => {
    const serialized = JSON.stringify(PULSO_SCHEMA_MANIFEST);
    expect(serialized).not.toMatch(/clinical_records|dictations|encounters|audio_cleanup|lumen/i);
    expect(PULSO_CURRENT_SCHEMA_VERSION).toBe(6);
    expect(PULSO_FUNCTIONS).toHaveLength(19);
  });

  it("allows only the two audited NOT VALID checks during legacy adoption and requires them validated once managed", () => {
    const legacyDebt = {
      ...row("constraint", "pulso_iris.appointments.chk_appointments_manual_verification"),
      valid: false
    };
    const legacyCatalog = [...SCHEMAS, row("table", "pulso_iris.appointments"), legacyDebt];
    const legacyManifest = createPulsoStructuralManifest(legacyCatalog);
    expect(
      evaluatePulsoSchemaSnapshot(legacyCatalog, [], [], { legacy: legacyManifest, managed: legacyManifest }).state
    ).toBe("legacy");

    const unknownDebt = legacyCatalog.map((entry) =>
      entry === legacyDebt ? { ...entry, identity: "pulso_iris.appointments.unexpected_unvalidated_check" } : entry
    );
    const unknownManifest = createPulsoStructuralManifest(unknownDebt);
    expect(
      evaluatePulsoSchemaSnapshot(unknownDebt, [], [], { legacy: unknownManifest, managed: unknownManifest }).state
    ).toBe("incompatible");

    const managedCatalog = [
      ...legacyCatalog,
      row("table", "pulso_iris.schema_version"),
      row("table", "pulso_iris.migration_ledger")
    ];
    const managedManifest = createPulsoStructuralManifest(managedCatalog);
    expect(
      evaluatePulsoSchemaSnapshot(
        managedCatalog,
        [{ current_version: 2, migration_name: PULSO_CURRENT_MIGRATION }],
        [{ name: PULSO_BASELINE_MIGRATION, checksum: "a".repeat(64) }],
        { legacy: legacyManifest, managed: managedManifest }
      ).state
    ).toBe("incompatible");

    const resumableBaseline = evaluatePulsoSchemaSnapshot(
      managedCatalog,
      [{ current_version: 1, migration_name: PULSO_BASELINE_MIGRATION }],
      [{ name: PULSO_BASELINE_MIGRATION, checksum: "a".repeat(64) }],
      {
        legacy: legacyManifest,
        managed: managedManifest,
        managedByVersion: { 1: managedManifest }
      }
    );
    expect(resumableBaseline.state).toBe("managed");
  });
});

describe("PULSO runtime ACL policies", () => {
  it.each(PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition) => definition.role))(
    "accepts the exact direct/effective matrix for %s",
    (role) => {
      const policy = PULSO_RUNTIME_POLICIES[role];
      const acl: PulsoAclRow[] = [aclRow("database", "hyperion_pulso", ["CONNECT"])];
      for (const schema of PULSO_PROVIDER_SCHEMAS) {
        acl.push(aclRow("schema", schema, policy.schemas.includes(schema) ? ["USAGE"] : []));
      }
      for (const [table, privileges] of Object.entries(policy.tables)) {
        acl.push(aclRow("table", table, privileges));
      }
      for (const [fn, privileges] of Object.entries(policy.functions)) {
        acl.push(aclRow("function", fn, privileges));
      }
      expect(evaluatePulsoRuntimeSecurity(roleRow(role), acl)).toEqual([]);
    }
  );

  it("rejects column grants, privilege drift, memberships and object ownership", () => {
    const role = "hyperion_knowledge";
    const policy = PULSO_RUNTIME_POLICIES[role];
    const acl: PulsoAclRow[] = [aclRow("database", "hyperion_pulso", ["CONNECT"])];
    for (const schema of PULSO_PROVIDER_SCHEMAS) {
      acl.push(aclRow("schema", schema, policy.schemas.includes(schema) ? ["USAGE"] : []));
    }
    for (const [table, privileges] of Object.entries(policy.tables)) acl.push(aclRow("table", table, privileges));
    for (const [fn, privileges] of Object.entries(policy.functions)) acl.push(aclRow("function", fn, privileges));
    acl.push(aclRow("column", "platform.knowledge_sources.config", ["UPDATE"]));

    const issues = evaluatePulsoRuntimeSecurity(
      { ...roleRow(role), has_memberships: true, owns_provider_objects: true },
      acl
    );
    expect(issues).toContain("runtime role has a direct or inherited membership");
    expect(issues).toContain("runtime role owns a database or schema object");
    expect(issues).toContain("unexpected runtime ACL object column:platform.knowledge_sources.config");
  });

  it("requires SELECT on pulso_iris.schema_version for every runtime", () => {
    for (const definition of PULSO_RUNTIME_ROLE_DEFINITIONS) {
      expect(PULSO_RUNTIME_POLICIES[definition.role].tables["pulso_iris.schema_version"]).toEqual(["SELECT"]);
    }
  });

  it("grants the SOFIA marker only to the SOFIA runtime", () => {
    for (const definition of PULSO_RUNTIME_ROLE_DEFINITIONS) {
      expect(PULSO_RUNTIME_POLICIES[definition.role].tables["agent_runtime.schema_version"]).toEqual(
        definition.role === "hyperion_sofia" ? ["SELECT"] : []
      );
    }
  });
});

describe("PULSO managed manifest transitions", () => {
  it("keeps immutable structural manifests for every resumable managed state", () => {
    expect(PULSO_SCHEMA_MANIFEST.managedByVersion?.[1]).toBe(PULSO_MANAGED_SCHEMA_MANIFEST_001);
    expect(PULSO_SCHEMA_MANIFEST.managedByVersion?.[2]).toBe(PULSO_MANAGED_SCHEMA_MANIFEST_002);
    expect(PULSO_SCHEMA_MANIFEST.managedByVersion?.[3]).toBe(PULSO_MANAGED_SCHEMA_MANIFEST_003);
    expect(PULSO_SCHEMA_MANIFEST.managedByVersion?.[4]).toBe(PULSO_MANAGED_SCHEMA_MANIFEST_004);
    expect(PULSO_SCHEMA_MANIFEST.managedByVersion?.[5]).toBe(PULSO_MANAGED_SCHEMA_MANIFEST_005);
    expect(PULSO_SCHEMA_MANIFEST.managedByVersion?.[6]).toBe(PULSO_MANAGED_SCHEMA_MANIFEST_006);
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_001.constraint.fingerprint).not.toBe(
      PULSO_MANAGED_SCHEMA_MANIFEST_002.constraint.fingerprint
    );
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_002.table.count).toBe(54);
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_003.table.count).toBe(55);
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_004.table.count).toBe(57);
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_005.table.count).toBe(59);
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_006.table.count).toBe(61);
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_004.table.identities).toEqual(
      expect.arrayContaining(["channel_runtime.access_projection_inbox", "channel_runtime.tenant_snapshots"])
    );
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_005.table.identities).toEqual(
      expect.arrayContaining(["pulso_iris.access_projection_inbox", "pulso_iris.tenant_snapshots"])
    );
    expect(PULSO_MANAGED_SCHEMA_MANIFEST_006.table.identities).toEqual(
      expect.arrayContaining(["agent_runtime.access_projection_inbox", "agent_runtime.tenant_snapshots"])
    );
  });

  it("selects the exact structural manifest by version and rejects unknown managed versions", () => {
    const managedCatalogV2 = [
      ...SCHEMAS,
      row("table", "pulso_iris.schema_version"),
      row("table", "pulso_iris.migration_ledger")
    ];
    const managedCatalogV3 = [...managedCatalogV2, row("table", "agent_runtime.schema_version")];
    const managedCatalogV4 = [
      ...managedCatalogV3,
      row("table", "channel_runtime.access_projection_inbox"),
      row("table", "channel_runtime.tenant_snapshots")
    ];
    const managedCatalogV5 = [
      ...managedCatalogV4,
      row("table", "pulso_iris.access_projection_inbox"),
      row("table", "pulso_iris.tenant_snapshots")
    ];
    const managedCatalogV6 = [
      ...managedCatalogV5,
      row("table", "agent_runtime.access_projection_inbox"),
      row("table", "agent_runtime.tenant_snapshots")
    ];
    const manifestV2 = createPulsoStructuralManifest(managedCatalogV2);
    const manifestV3 = createPulsoStructuralManifest(managedCatalogV3);
    const manifestV4 = createPulsoStructuralManifest(managedCatalogV4);
    const manifestV5 = createPulsoStructuralManifest(managedCatalogV5);
    const manifestV6 = createPulsoStructuralManifest(managedCatalogV6);
    const manifests = {
      legacy: manifestV2,
      managed: manifestV6,
      managedByVersion: { 2: manifestV2, 3: manifestV3, 4: manifestV4, 5: manifestV5, 6: manifestV6 }
    };
    const ledger = [{ name: PULSO_BASELINE_MIGRATION, checksum: "a".repeat(64) }];

    expect(
      evaluatePulsoSchemaSnapshot(
        managedCatalogV2,
        [{ current_version: 2, migration_name: "002-pulso-runtime-roles.sql" }],
        ledger,
        manifests
      ).state
    ).toBe("managed");
    expect(
      evaluatePulsoSchemaSnapshot(
        managedCatalogV3,
        [{ current_version: 3, migration_name: "003-sofia-readiness-marker.sql" }],
        ledger,
        manifests
      ).state
    ).toBe("managed");
    expect(
      evaluatePulsoSchemaSnapshot(
        managedCatalogV4,
        [{ current_version: 4, migration_name: "004-access-channel-tenant-projection.sql" }],
        ledger,
        manifests
      ).state
    ).toBe("managed");
    expect(
      evaluatePulsoSchemaSnapshot(
        managedCatalogV5,
        [{ current_version: 5, migration_name: "005-access-iris-tenant-projection.sql" }],
        ledger,
        manifests
      ).state
    ).toBe("managed");
    expect(
      evaluatePulsoSchemaSnapshot(
        managedCatalogV6,
        [{ current_version: 6, migration_name: PULSO_CURRENT_MIGRATION }],
        ledger,
        manifests
      ).state
    ).toBe("managed");

    const unknown = evaluatePulsoSchemaSnapshot(
      managedCatalogV6,
      [{ current_version: 7, migration_name: "007-unknown.sql" }],
      ledger,
      manifests
    );
    expect(unknown.state).toBe("incompatible");
    expect(unknown.issues).toContain("managed PULSO schema version 7 has no structural manifest");
  });
});

function aclRow(category: PulsoAclRow["category"], identity: string, privileges: readonly string[]): PulsoAclRow {
  return { category, identity, privileges: [...privileges], direct_privileges: [...privileges] };
}

function roleRow(current_user: PulsoRuntimeRole): PulsoRoleSecurityRow {
  return {
    current_user,
    can_login: true,
    unsafe_capabilities: false,
    has_memberships: false,
    owns_current_database: false,
    owns_other_database: false,
    owns_provider_objects: false,
    owns_unexpected_objects: false,
    can_connect_database: true,
    can_create_in_database: false,
    can_create_temporary: false,
    public_database_privileges: []
  };
}

describe("catalog summaries", () => {
  it("normalizes CRLF before hashing", () => {
    const left = summarizePulsoCatalog([row("table", "pulso_iris.messages", "a\r\nb")]);
    const right = summarizePulsoCatalog([row("table", "pulso_iris.messages", "a\nb")]);
    expect(left.table).toEqual(right.table);
  });
});
