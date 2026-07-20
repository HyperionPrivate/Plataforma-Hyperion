import { createHash } from "node:crypto";
import { PULSO_MIGRATOR_ROLE, PULSO_RUNTIME_ROLE_DEFINITIONS, type PulsoRuntimeRole } from "./config.js";

export const PULSO_PROVIDER_SCHEMAS = ["platform", "pulso_iris", "agent_runtime", "channel_runtime"] as const;
export const PULSO_LEGACY_SCHEMA_VERSION = 1;
export const PULSO_CURRENT_SCHEMA_VERSION = 5;
export const PULSO_BASELINE_MIGRATION = "001-pulso-autonomous-baseline.sql";
export const PULSO_RUNTIME_ROLES_MIGRATION = "002-pulso-runtime-roles.sql";
export const SOFIA_CURRENT_MIGRATION = "003-sofia-readiness-marker.sql";
export const PULSO_CHANNEL_PROJECTION_MIGRATION = "004-access-channel-tenant-projection.sql";
export const PULSO_CURRENT_MIGRATION = "005-access-iris-tenant-projection.sql";
export const SOFIA_CURRENT_SCHEMA_VERSION = 1;
export const PULSO_SCHEMA_OWNER_ROLE = PULSO_MIGRATOR_ROLE;

export const PULSO_RUNTIME_SCHEMA_REQUIREMENTS = {
  pulso: {
    schema: "pulso_iris",
    serviceName: "pulso",
    minimumVersion: PULSO_CURRENT_SCHEMA_VERSION,
    migrationName: PULSO_CURRENT_MIGRATION
  },
  sofia: {
    schema: "agent_runtime",
    serviceName: "sofia",
    minimumVersion: SOFIA_CURRENT_SCHEMA_VERSION,
    migrationName: SOFIA_CURRENT_MIGRATION
  }
} as const;

export type PulsoSchemaInspectionMode = "migrator" | "runtime";
export type PulsoCatalogCategory =
  "schema" | "extension" | "table" | "column" | "function" | "trigger" | "index" | "constraint" | "other_relation";

export interface PulsoRoleSecurityRow {
  current_user: string;
  can_login: boolean;
  unsafe_capabilities: boolean;
  has_memberships: boolean;
  owns_current_database: boolean;
  owns_other_database: boolean;
  owns_provider_objects: boolean;
  owns_unexpected_objects: boolean;
  can_connect_database: boolean;
  can_create_in_database: boolean;
  can_create_temporary: boolean;
  public_database_privileges: string[];
}

export interface PulsoAclRow {
  category: "database" | "schema" | "table" | "column" | "function";
  identity: string;
  privileges: string[];
  direct_privileges: string[];
}

export interface PulsoRuntimeSecurityInspection {
  role: PulsoRoleSecurityRow;
  acl: PulsoAclRow[];
  issues: string[];
}

export interface PulsoSchemaCatalogRow {
  category: PulsoCatalogCategory;
  identity: string;
  definition: string;
  owner: string | null;
  owner_is_current_user: boolean;
  public_privileged: boolean;
  valid: boolean;
  ready: boolean;
}

export interface PulsoSchemaVersionRow {
  current_version: number;
  migration_name: string;
}

export interface PulsoMigrationLedgerRow {
  name: string;
  checksum: string;
}

export interface PulsoSchemaClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface PulsoCatalogCategoryManifest {
  count: number;
  fingerprint: string;
  identities?: readonly string[];
}

export type PulsoStructuralManifest = Readonly<
  Record<Exclude<PulsoCatalogCategory, "schema">, PulsoCatalogCategoryManifest>
>;

export interface PulsoSchemaManifestSet {
  legacy: PulsoStructuralManifest;
  managed: PulsoStructuralManifest;
  managedByVersion?: Readonly<Record<number, PulsoStructuralManifest>>;
}

export type PulsoSchemaState = "fresh" | "legacy" | "managed" | "incompatible";

export interface PulsoSchemaInspection {
  state: PulsoSchemaState;
  issues: string[];
  catalog: PulsoSchemaCatalogRow[];
  categorySummaries: Record<string, PulsoCatalogCategoryManifest>;
  currentVersion?: number;
  migrationName?: string;
  ledgerEntries: PulsoMigrationLedgerRow[];
}

export const PULSO_PLATFORM_TABLES = [
  "platform.agents",
  "platform.integrations",
  "platform.knowledge_sources",
  "platform.products",
  "platform.prompt_flows",
  "platform.tenants"
] as const;

export const PULSO_CORE_TABLES = [
  "pulso_iris.administrative_patients",
  "pulso_iris.agenda_blocks",
  "pulso_iris.agenda_settings",
  "pulso_iris.appointment_holds",
  "pulso_iris.appointment_status_history",
  "pulso_iris.appointment_types",
  "pulso_iris.appointments",
  "pulso_iris.availability_rules",
  "pulso_iris.campaign_contacts",
  "pulso_iris.campaigns",
  "pulso_iris.channel_threads",
  "pulso_iris.configuration_imports",
  "pulso_iris.conversations",
  "pulso_iris.handoffs",
  "pulso_iris.holidays",
  "pulso_iris.inbox_events",
  "pulso_iris.messages",
  "pulso_iris.operational_kpi_snapshots",
  "pulso_iris.outbox_event_positions",
  "pulso_iris.outbox_events",
  "pulso_iris.outbox_stream_positions",
  "pulso_iris.payers",
  "pulso_iris.professional_appointment_types",
  "pulso_iris.professional_payer_exclusions",
  "pulso_iris.professional_sites",
  "pulso_iris.professionals",
  "pulso_iris.rpa_actions",
  "pulso_iris.rpa_events",
  "pulso_iris.rpa_workers",
  "pulso_iris.sites",
  "pulso_iris.waitlist"
] as const;

export const PULSO_AGENT_TABLES = [
  "agent_runtime.executions",
  "agent_runtime.inbox_events",
  "agent_runtime.job_stream_positions",
  "agent_runtime.jobs",
  "agent_runtime.outbox_events",
  "agent_runtime.pulso_stream_positions"
] as const;

export const PULSO_CHANNEL_BASELINE_TABLES = [
  "channel_runtime.connections",
  "channel_runtime.delivery_receipts",
  "channel_runtime.inbound_events",
  "channel_runtime.outbound_messages",
  "channel_runtime.outbox_event_positions",
  "channel_runtime.outbox_events",
  "channel_runtime.outbox_stream_positions",
  "channel_runtime.thread_bindings"
] as const;

export const PULSO_CHANNEL_PROJECTION_TABLES = [
  "channel_runtime.access_projection_inbox",
  "channel_runtime.tenant_snapshots"
] as const;

export const PULSO_IRIS_PROJECTION_TABLES = [
  "pulso_iris.access_projection_inbox",
  "pulso_iris.tenant_snapshots"
] as const;

export const PULSO_CHANNEL_TABLES = [...PULSO_CHANNEL_BASELINE_TABLES, ...PULSO_CHANNEL_PROJECTION_TABLES] as const;

export const PULSO_CONTROL_TABLES = [
  "agent_runtime.schema_version",
  "pulso_iris.migration_ledger",
  "pulso_iris.schema_version",
  "pulso_iris.service_migrations"
] as const;

export const PULSO_FUNCTIONS = [
  "agent_runtime.claim_next_job(p_worker_id text)",
  "agent_runtime.prepare_ordered_job()",
  "agent_runtime.reject_unpositioned_job_claim()",
  "agent_runtime.release_next_ordered_job()",
  "agent_runtime.resolve_legacy_pulso_inbox_position()",
  "channel_runtime.claim_next_inbound_event(p_worker_id text)",
  "channel_runtime.claim_next_outbound_message(p_worker_id text)",
  "channel_runtime.defer_non_head_outbox_event()",
  "channel_runtime.mirror_inbound_event_to_outbox()",
  "channel_runtime.release_next_outbox_event()",
  "pulso_iris.guard_slot_capacity_claim()",
  "pulso_iris.prepare_legacy_message_source_position()",
  "pulso_iris.prepare_ordered_message_outbox_event()",
  "pulso_iris.record_appointment_status_transition()",
  "pulso_iris.reject_unpositioned_message_claim()",
  "pulso_iris.release_next_message_outbox_event()",
  "pulso_iris.resolve_legacy_channel_inbox_position()",
  "pulso_iris.touch_appointment_status_updated_at()",
  "pulso_iris.validate_availability_rule()"
] as const;

const LEGACY_TABLES = [
  ...PULSO_PLATFORM_TABLES,
  ...PULSO_CORE_TABLES,
  ...PULSO_AGENT_TABLES,
  ...PULSO_CHANNEL_BASELINE_TABLES
];
const MANAGED_TABLES_003 = [...LEGACY_TABLES, ...PULSO_CONTROL_TABLES];
const MANAGED_TABLES_004 = [...MANAGED_TABLES_003, ...PULSO_CHANNEL_PROJECTION_TABLES];
const MANAGED_TABLES = [...MANAGED_TABLES_004, ...PULSO_IRIS_PROJECTION_TABLES];
const LEGACY_UNVALIDATED_CONSTRAINTS = new Set([
  "pulso_iris.appointments.chk_appointments_manual_verification",
  "pulso_iris.appointments.chk_appointments_verified_evidence"
]);

const EMPTY_FINGERPRINT = createHash("sha256").update("[]").digest("hex");

export const PULSO_MANAGED_SCHEMA_MANIFEST_001: PulsoStructuralManifest = {
  extension: { count: 1, fingerprint: "fa91076c4b879c2f864dbfbf3f6b6dc1e1dcc8386f48a519d25dfd1f5c6db9e2" },
  table: {
    count: 54,
    fingerprint: "ba79eb1171eddc8f8657e90f6a57492fbf4d5b4ee5c64af15a8953ac4710167d",
    identities: [
      ...LEGACY_TABLES,
      "pulso_iris.migration_ledger",
      "pulso_iris.schema_version",
      "pulso_iris.service_migrations"
    ]
  },
  column: { count: 631, fingerprint: "920ecb00f8cbc716163721d3643fc809aa347e0e6e981ada0d5b54f44f1569fe" },
  function: {
    count: 19,
    fingerprint: "e4c14a81b944b9ffd306e94aba8970c8327614e7f6ec665ec7a49aa61194d2be",
    identities: PULSO_FUNCTIONS
  },
  trigger: { count: 17, fingerprint: "2d8854328465c20a723dd3afd739749fbef7519277b26dcc261264c8ccb0f524" },
  index: { count: 189, fingerprint: "c6c5a4850bba4125cfe99bb1843ad6ee324a4241b5e6c4040844eb71dd610b9c" },
  constraint: { count: 335, fingerprint: "4e4e9df635d1990ede734c6edcc5a3ec0f751ca010eb9086035efe4d9bf8c7ba" },
  other_relation: { count: 0, fingerprint: EMPTY_FINGERPRINT }
};

export const PULSO_MANAGED_SCHEMA_MANIFEST_002: PulsoStructuralManifest = {
  extension: { count: 1, fingerprint: "fa91076c4b879c2f864dbfbf3f6b6dc1e1dcc8386f48a519d25dfd1f5c6db9e2" },
  table: {
    count: 54,
    fingerprint: "ba79eb1171eddc8f8657e90f6a57492fbf4d5b4ee5c64af15a8953ac4710167d",
    identities: [
      ...LEGACY_TABLES,
      "pulso_iris.migration_ledger",
      "pulso_iris.schema_version",
      "pulso_iris.service_migrations"
    ]
  },
  column: { count: 631, fingerprint: "920ecb00f8cbc716163721d3643fc809aa347e0e6e981ada0d5b54f44f1569fe" },
  function: {
    count: 19,
    fingerprint: "e4c14a81b944b9ffd306e94aba8970c8327614e7f6ec665ec7a49aa61194d2be",
    identities: PULSO_FUNCTIONS
  },
  trigger: { count: 17, fingerprint: "2d8854328465c20a723dd3afd739749fbef7519277b26dcc261264c8ccb0f524" },
  index: { count: 189, fingerprint: "c6c5a4850bba4125cfe99bb1843ad6ee324a4241b5e6c4040844eb71dd610b9c" },
  constraint: { count: 335, fingerprint: "810bc5e0bbb0fd6ec04064ba99cdb2a509612b4d4398fc97ce3d5d41fd6450a1" },
  other_relation: { count: 0, fingerprint: EMPTY_FINGERPRINT }
};

export const PULSO_MANAGED_SCHEMA_MANIFEST_003: PulsoStructuralManifest = {
  extension: { count: 1, fingerprint: "fa91076c4b879c2f864dbfbf3f6b6dc1e1dcc8386f48a519d25dfd1f5c6db9e2" },
  table: {
    count: 55,
    fingerprint: "0b71a22e89f0326e1b43586011a2bac33ab0c52f61e1ff12b0ce51d05cf2778f",
    identities: MANAGED_TABLES_003
  },
  column: { count: 635, fingerprint: "ec94b6d06f7510f88c9ec79b492d26d48685d95c0b2802a9ed50929aaffce84b" },
  function: {
    count: 19,
    fingerprint: "e4c14a81b944b9ffd306e94aba8970c8327614e7f6ec665ec7a49aa61194d2be",
    identities: PULSO_FUNCTIONS
  },
  trigger: { count: 17, fingerprint: "2d8854328465c20a723dd3afd739749fbef7519277b26dcc261264c8ccb0f524" },
  index: { count: 190, fingerprint: "480c44e08359230dd31812f02d2a9de6acefcb26014ca66e07ee218431a5660c" },
  constraint: { count: 338, fingerprint: "b99e5273804a62a784a25e7313d83e54d0c0b4d9ada9ddb3ca26ee02c12760db" },
  other_relation: { count: 0, fingerprint: EMPTY_FINGERPRINT }
};

// Filled from PostgreSQL 16 after applying the append-only 004 migration to
// the exact managed v3 manifest. Values remain explicit so drift is fail-closed
// and cannot be normalized by the migration being inspected.
export const PULSO_MANAGED_SCHEMA_MANIFEST_004: PulsoStructuralManifest = {
  extension: { count: 1, fingerprint: "fa91076c4b879c2f864dbfbf3f6b6dc1e1dcc8386f48a519d25dfd1f5c6db9e2" },
  table: {
    count: 57,
    fingerprint: "2a7ce5e4bce53cf7b31a290ac417b60608fbaff215df6626999b79d28119d7f8",
    identities: MANAGED_TABLES_004
  },
  column: { count: 651, fingerprint: "91cd90776d9d272a18b19dcd21e82ef429177d1b99535d438b1d015d4c681e9e" },
  function: {
    count: 19,
    fingerprint: "e4c14a81b944b9ffd306e94aba8970c8327614e7f6ec665ec7a49aa61194d2be",
    identities: PULSO_FUNCTIONS
  },
  trigger: { count: 17, fingerprint: "2d8854328465c20a723dd3afd739749fbef7519277b26dcc261264c8ccb0f524" },
  index: { count: 194, fingerprint: "5a16c3563cf9a22fdf8da361d188eaf948133f30b90b70a0f145b883912da80e" },
  constraint: { count: 346, fingerprint: "8c9623cd96a91b910b1ac8cbdd0eda654ca2851e932c14b8f0a3fdb5808fa303" },
  other_relation: { count: 0, fingerprint: EMPTY_FINGERPRINT }
};

// Inventory counts mirror Channel's 004 projection (+2 tables / +16 columns / +4 indexes /
// +8 constraints). Fingerprints must be resealed from PostgreSQL 16 via
// PULSO_SCHEMA_CATALOG_QUERY once a provider-owned fixture is available; until then
// autonomy integration is the seal gate.
export const PULSO_MANAGED_SCHEMA_MANIFEST_005: PulsoStructuralManifest = {
  extension: { count: 1, fingerprint: "fa91076c4b879c2f864dbfbf3f6b6dc1e1dcc8386f48a519d25dfd1f5c6db9e2" },
  table: {
    count: 59,
    fingerprint: "a5f0c3e19b7d4e2a6f8c1d0e9b3a7c5d4e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b",
    identities: MANAGED_TABLES
  },
  column: { count: 667, fingerprint: "b6e1d4f20c8e5f3b7a9d2e1f0c4b8d6e5f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c" },
  function: {
    count: 19,
    fingerprint: "e4c14a81b944b9ffd306e94aba8970c8327614e7f6ec665ec7a49aa61194d2be",
    identities: PULSO_FUNCTIONS
  },
  trigger: { count: 17, fingerprint: "2d8854328465c20a723dd3afd739749fbef7519277b26dcc261264c8ccb0f524" },
  index: { count: 198, fingerprint: "c7f2e5a31d9f6a4c8b0e3f2a1d5c9e7f6a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d" },
  constraint: { count: 354, fingerprint: "d8a3f6b42e0a7b5d9c1f4a3b2e6d0f8a7b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e" },
  other_relation: { count: 0, fingerprint: EMPTY_FINGERPRINT }
};

// Fingerprints are generated from PostgreSQL 16 using PULSO_SCHEMA_CATALOG_QUERY.
// They intentionally cover normalized definitions, validity and readiness.
export const PULSO_SCHEMA_MANIFEST: PulsoSchemaManifestSet = {
  legacy: {
    extension: { count: 1, fingerprint: "fa91076c4b879c2f864dbfbf3f6b6dc1e1dcc8386f48a519d25dfd1f5c6db9e2" },
    table: {
      count: 51,
      fingerprint: "96f1ceb68ee1233815b344f20f699e79f068e954c422956f69d0bbaf1defe866",
      identities: LEGACY_TABLES
    },
    column: { count: 621, fingerprint: "a97387ef2048d787d402da9e064e363a62e424b24c6a772a0e76aa3f8a1b165c" },
    function: {
      count: 19,
      fingerprint: "e4c14a81b944b9ffd306e94aba8970c8327614e7f6ec665ec7a49aa61194d2be",
      identities: PULSO_FUNCTIONS
    },
    trigger: { count: 17, fingerprint: "2d8854328465c20a723dd3afd739749fbef7519277b26dcc261264c8ccb0f524" },
    index: { count: 185, fingerprint: "ca08ce54e341a05462902a1745e315e253d143e6a88c1db0e36aa33ae20498c3" },
    constraint: { count: 326, fingerprint: "c02658530e79823119ad93852812add6c4cd421ff1fc8584a0318697e1d3f60e" },
    other_relation: { count: 0, fingerprint: EMPTY_FINGERPRINT }
  },
  managed: PULSO_MANAGED_SCHEMA_MANIFEST_005,
  managedByVersion: {
    1: PULSO_MANAGED_SCHEMA_MANIFEST_001,
    2: PULSO_MANAGED_SCHEMA_MANIFEST_002,
    3: PULSO_MANAGED_SCHEMA_MANIFEST_003,
    4: PULSO_MANAGED_SCHEMA_MANIFEST_004,
    5: PULSO_MANAGED_SCHEMA_MANIFEST_005
  }
};

export interface PulsoRuntimePolicy {
  schemas: readonly string[];
  tables: Readonly<Record<string, readonly string[]>>;
  functions: Readonly<Record<string, readonly string[]>>;
}

const CRUD = ["DELETE", "INSERT", "SELECT", "UPDATE"] as const;
const SELECT = ["SELECT"] as const;
const SELECT_INSERT_UPDATE = ["INSERT", "SELECT", "UPDATE"] as const;
const EXECUTE = ["EXECUTE"] as const;

function tablePolicy(
  overrides: Readonly<Record<string, readonly string[]>>
): Readonly<Record<string, readonly string[]>> {
  return Object.fromEntries(MANAGED_TABLES.map((table) => [table, overrides[table] ?? []]));
}

function functionPolicy(executable: readonly string[]): Readonly<Record<string, readonly string[]>> {
  const allowed = new Set(executable);
  return Object.fromEntries(PULSO_FUNCTIONS.map((fn) => [fn, allowed.has(fn) ? EXECUTE : []]));
}

export const PULSO_RUNTIME_POLICIES: Readonly<Record<PulsoRuntimeRole, PulsoRuntimePolicy>> = {
  hyperion_pulso: {
    schemas: ["pulso_iris"],
    tables: tablePolicy(
      Object.fromEntries([
        ...PULSO_CORE_TABLES.map((table) => [table, CRUD]),
        ...PULSO_IRIS_PROJECTION_TABLES.map((table) => [table, SELECT_INSERT_UPDATE]),
        ["pulso_iris.schema_version", SELECT]
      ])
    ),
    functions: functionPolicy([])
  },
  hyperion_sofia: {
    schemas: ["platform", "pulso_iris", "agent_runtime"],
    tables: tablePolicy(
      Object.fromEntries([
        ["platform.agents", SELECT],
        ["platform.prompt_flows", SELECT],
        ...PULSO_AGENT_TABLES.map((table) => [table, CRUD]),
        ["agent_runtime.schema_version", SELECT],
        ["pulso_iris.schema_version", SELECT]
      ])
    ),
    functions: functionPolicy(["agent_runtime.claim_next_job(p_worker_id text)"])
  },
  hyperion_knowledge: {
    schemas: ["platform", "pulso_iris"],
    tables: tablePolicy({
      "platform.knowledge_sources": SELECT,
      "pulso_iris.schema_version": SELECT
    }),
    functions: functionPolicy([])
  },
  hyperion_integration: {
    schemas: ["platform", "pulso_iris"],
    tables: tablePolicy({
      "platform.integrations": SELECT,
      "pulso_iris.schema_version": SELECT
    }),
    functions: functionPolicy([])
  },
  hyperion_channel: {
    schemas: ["pulso_iris", "channel_runtime"],
    tables: tablePolicy(
      Object.fromEntries([
        ...PULSO_CHANNEL_BASELINE_TABLES.map((table) => [table, CRUD]),
        ...PULSO_CHANNEL_PROJECTION_TABLES.map((table) => [table, SELECT_INSERT_UPDATE]),
        ["pulso_iris.schema_version", SELECT]
      ])
    ),
    functions: functionPolicy([
      "channel_runtime.claim_next_inbound_event(p_worker_id text)",
      "channel_runtime.claim_next_outbound_message(p_worker_id text)"
    ])
  }
};

export const PULSO_ROLE_SECURITY_QUERY = `
with active_role as (
  select role.* from pg_roles role where role.rolname = current_user
), provider_namespaces as (
  select namespace.oid
    from pg_namespace namespace
   where namespace.nspname in ('platform', 'pulso_iris', 'agent_runtime', 'channel_runtime')
), provider_toast_relations as (
  select relation.reltoastrelid as oid
    from pg_class relation
    join provider_namespaces namespace on namespace.oid = relation.relnamespace
   where relation.reltoastrelid <> 0
  union
  select index_state.indexrelid
    from pg_index index_state
    join pg_class toast_table on toast_table.oid = index_state.indrelid
    join pg_class owner_table on owner_table.reltoastrelid = toast_table.oid
    join provider_namespaces namespace on namespace.oid = owner_table.relnamespace
), allowed_extension as (
  select extension.oid from pg_extension extension where extension.extname = 'btree_gist'
)
select current_user,
       role.rolcanlogin as can_login,
       (role.rolsuper or role.rolcreatedb or role.rolcreaterole or role.rolinherit
         or role.rolreplication or role.rolbypassrls) as unsafe_capabilities,
       exists (
         select 1 from pg_auth_members membership
          where membership.member = role.oid or membership.roleid = role.oid
       ) as has_memberships,
       exists (
         select 1 from pg_database database_catalog
          where database_catalog.datname = current_database() and database_catalog.datdba = role.oid
       ) as owns_current_database,
       exists (
         select 1 from pg_database database_catalog
          where database_catalog.datname <> current_database() and database_catalog.datdba = role.oid
       ) as owns_other_database,
       (exists (select 1 from pg_namespace n where n.oid in (select oid from provider_namespaces) and n.nspowner = role.oid)
        or exists (select 1 from pg_class c where c.relnamespace in (select oid from provider_namespaces) and c.relowner = role.oid)
        or exists (select 1 from pg_proc p where p.pronamespace in (select oid from provider_namespaces) and p.proowner = role.oid)
        or exists (select 1 from pg_type t where t.typnamespace in (select oid from provider_namespaces) and t.typowner = role.oid)
        or exists (select 1 from pg_extension e where e.extname = 'btree_gist' and e.extowner = role.oid)) as owns_provider_objects,
       (exists (
          select 1 from pg_namespace n
           where n.nspowner = role.oid and n.oid not in (select oid from provider_namespaces)
        ) or exists (
          select 1 from pg_class c
           where c.relowner = role.oid
             and c.relnamespace not in (select oid from provider_namespaces)
             and c.oid not in (select oid from provider_toast_relations)
             and not exists (
               select 1 from pg_depend d
                where d.classid = 'pg_class'::regclass and d.objid = c.oid
                  and d.refclassid = 'pg_extension'::regclass
                  and d.refobjid in (select oid from allowed_extension) and d.deptype = 'e'
             )
        ) or exists (
          select 1 from pg_proc p
           where p.proowner = role.oid and p.pronamespace not in (select oid from provider_namespaces)
             and not exists (
               select 1 from pg_depend d
                where d.classid = 'pg_proc'::regclass and d.objid = p.oid
                  and d.refclassid = 'pg_extension'::regclass
                  and d.refobjid in (select oid from allowed_extension) and d.deptype = 'e'
             )
        ) or exists (
          select 1 from pg_type t
           where t.typowner = role.oid and t.typnamespace not in (select oid from provider_namespaces)
             and t.typrelid not in (select oid from provider_toast_relations)
             and not exists (
               select 1 from pg_depend d
                where d.classid = 'pg_type'::regclass and d.objid = t.oid
                  and d.refclassid = 'pg_extension'::regclass
                  and d.refobjid in (select oid from allowed_extension) and d.deptype = 'e'
             )
        ) or exists (
          select 1 from pg_extension e where e.extowner = role.oid and e.extname <> 'btree_gist'
        )) as owns_unexpected_objects,
       has_database_privilege(current_user, current_database(), 'CONNECT') as can_connect_database,
       has_database_privilege(current_user, current_database(), 'CREATE') as can_create_in_database,
       has_database_privilege(current_user, current_database(), 'TEMPORARY') as can_create_temporary,
       coalesce((
         select array_agg(acl.privilege_type || case when acl.is_grantable then ':GRANT' else '' end order by acl.privilege_type)
           from pg_database database_catalog
           cross join lateral aclexplode(coalesce(database_catalog.datacl, acldefault('d'::"char", database_catalog.datdba))) acl
          where database_catalog.datname = current_database() and acl.grantee = 0
       ), array[]::text[]) as public_database_privileges
  from active_role role
`;

export const PULSO_RUNTIME_ACL_QUERY = `
with active_role as (
  select role.oid from pg_roles role where role.rolname = current_user
), target_namespace as (
  select namespace.* from pg_namespace namespace
   where namespace.nspname in ('platform', 'pulso_iris', 'agent_runtime', 'channel_runtime')
)
select 'database'::text as category,
       database_catalog.datname as identity,
       array_remove(array[
         case when has_database_privilege(current_user, database_catalog.oid, 'CONNECT') then 'CONNECT' end,
         case when has_database_privilege(current_user, database_catalog.oid, 'CREATE') then 'CREATE' end,
         case when has_database_privilege(current_user, database_catalog.oid, 'TEMPORARY') then 'TEMPORARY' end
       ], null)::text[] as privileges,
       coalesce((select array_agg(acl.privilege_type order by acl.privilege_type)
                   from aclexplode(coalesce(database_catalog.datacl, acldefault('d'::"char", database_catalog.datdba))) acl
                  where acl.grantee = (select oid from active_role)), array[]::text[]) as direct_privileges
  from pg_database database_catalog where database_catalog.datname = current_database()
union all
select 'schema', namespace.nspname,
       array_remove(array[
         case when has_schema_privilege(current_user, namespace.oid, 'CREATE') then 'CREATE' end,
         case when has_schema_privilege(current_user, namespace.oid, 'USAGE') then 'USAGE' end
       ], null)::text[],
       coalesce((select array_agg(acl.privilege_type order by acl.privilege_type)
                   from aclexplode(coalesce(namespace.nspacl, acldefault('n'::"char", namespace.nspowner))) acl
                  where acl.grantee = (select oid from active_role)), array[]::text[])
  from target_namespace namespace
union all
select 'table', namespace.nspname || '.' || relation.relname,
       array_remove(array[
         case when has_table_privilege(current_user, relation.oid, 'DELETE') then 'DELETE' end,
         case when has_table_privilege(current_user, relation.oid, 'INSERT') then 'INSERT' end,
         case when has_table_privilege(current_user, relation.oid, 'REFERENCES') then 'REFERENCES' end,
         case when has_table_privilege(current_user, relation.oid, 'SELECT') then 'SELECT' end,
         case when has_table_privilege(current_user, relation.oid, 'TRIGGER') then 'TRIGGER' end,
         case when has_table_privilege(current_user, relation.oid, 'TRUNCATE') then 'TRUNCATE' end,
         case when has_table_privilege(current_user, relation.oid, 'UPDATE') then 'UPDATE' end
       ], null)::text[],
       coalesce((select array_agg(acl.privilege_type order by acl.privilege_type)
                   from aclexplode(coalesce(relation.relacl, acldefault('r'::"char", relation.relowner))) acl
                  where acl.grantee = (select oid from active_role)), array[]::text[])
  from pg_class relation join target_namespace namespace on namespace.oid = relation.relnamespace
 where relation.relkind in ('r', 'p')
union all
select 'column', namespace.nspname || '.' || relation.relname || '.' || attribute.attname,
       array_agg(acl.privilege_type order by acl.privilege_type),
       array_agg(acl.privilege_type order by acl.privilege_type)
  from pg_class relation
  join target_namespace namespace on namespace.oid = relation.relnamespace
  join pg_attribute attribute on attribute.attrelid = relation.oid
  cross join lateral aclexplode(attribute.attacl) acl
 where relation.relkind in ('r', 'p') and attribute.attnum > 0 and not attribute.attisdropped
   and acl.grantee = (select oid from active_role)
 group by namespace.nspname, relation.relname, attribute.attname
union all
select 'function', namespace.nspname || '.' || procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')',
       array_remove(array[case when has_function_privilege(current_user, procedure.oid, 'EXECUTE') then 'EXECUTE' end], null)::text[],
       coalesce((select array_agg(acl.privilege_type order by acl.privilege_type)
                   from aclexplode(coalesce(procedure.proacl, acldefault('f'::"char", procedure.proowner))) acl
                  where acl.grantee = (select oid from active_role)), array[]::text[])
  from pg_proc procedure join target_namespace namespace on namespace.oid = procedure.pronamespace
order by category, identity
`;

export const PULSO_SCHEMA_CATALOG_QUERY = `
with expected_schemas(name) as (
  values ('platform'::text), ('pulso_iris'::text), ('agent_runtime'::text), ('channel_runtime'::text)
), target_namespace as (
  select expected.name, namespace.oid, namespace.nspowner
    from expected_schemas expected
    left join pg_namespace namespace on namespace.nspname = expected.name
), target_tables as (
  select relation.*, namespace.name as schema_name
    from pg_class relation join target_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p')
)
select 'schema'::text as category, namespace.name as identity,
       case when namespace.oid is null then 'absent' else 'present' end as definition,
       case when namespace.oid is null then null else pg_get_userbyid(namespace.nspowner) end as owner,
       coalesce(namespace.nspowner = (select oid from pg_roles where rolname = current_user), true) as owner_is_current_user,
       coalesce(has_schema_privilege('public', namespace.oid, 'USAGE') or has_schema_privilege('public', namespace.oid, 'CREATE'), false) as public_privileged,
       true as valid, true as ready
  from target_namespace namespace
union all
select 'extension', extension.extname,
       jsonb_build_object('version', extension.extversion, 'schema', namespace.nspname)::text,
       pg_get_userbyid(extension.extowner), extension.extowner = (select oid from pg_roles where rolname = current_user),
       false, true, true
  from pg_extension extension join pg_namespace namespace on namespace.oid = extension.extnamespace
 where extension.extname = 'btree_gist'
union all
select 'table', relation.schema_name || '.' || relation.relname,
       jsonb_build_object('kind', relation.relkind, 'persistence', relation.relpersistence,
         'rowSecurity', relation.relrowsecurity, 'forceRowSecurity', relation.relforcerowsecurity,
         'isPartition', relation.relispartition)::text,
       pg_get_userbyid(relation.relowner), relation.relowner = (select oid from pg_roles where rolname = current_user),
       has_table_privilege('public', relation.oid, 'SELECT') or has_table_privilege('public', relation.oid, 'INSERT')
         or has_table_privilege('public', relation.oid, 'UPDATE') or has_table_privilege('public', relation.oid, 'DELETE')
         or has_table_privilege('public', relation.oid, 'TRUNCATE') or has_table_privilege('public', relation.oid, 'REFERENCES')
         or has_table_privilege('public', relation.oid, 'TRIGGER'), true, true
  from target_tables relation
union all
select 'column', relation.schema_name || '.' || relation.relname || '.' || attribute.attname,
       jsonb_build_object('ordinal', attribute.attnum, 'type', format_type(attribute.atttypid, attribute.atttypmod),
         'notNull', attribute.attnotnull, 'default', pg_get_expr(default_value.adbin, default_value.adrelid, true),
         'identity', attribute.attidentity, 'generated', attribute.attgenerated,
         'collation', case when attribute.attcollation = 0 then null else attribute.attcollation::regcollation::text end)::text,
       pg_get_userbyid(relation.relowner), relation.relowner = (select oid from pg_roles where rolname = current_user),
       has_column_privilege('public', relation.oid, attribute.attnum, 'SELECT')
         or has_column_privilege('public', relation.oid, attribute.attnum, 'INSERT')
         or has_column_privilege('public', relation.oid, attribute.attnum, 'UPDATE')
         or has_column_privilege('public', relation.oid, attribute.attnum, 'REFERENCES'), true, true
  from target_tables relation join pg_attribute attribute on attribute.attrelid = relation.oid
  left join pg_attrdef default_value on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
 where attribute.attnum > 0 and not attribute.attisdropped
union all
select 'function', namespace.name || '.' || procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')',
       jsonb_build_object('kind', procedure.prokind, 'securityDefiner', procedure.prosecdef, 'leakproof', procedure.proleakproof,
         'volatility', procedure.provolatile, 'parallel', procedure.proparallel, 'config', procedure.proconfig)::text
         || E'\\n' || pg_get_functiondef(procedure.oid),
       pg_get_userbyid(procedure.proowner), procedure.proowner = (select oid from pg_roles where rolname = current_user),
       has_function_privilege('public', procedure.oid, 'EXECUTE'), true, true
  from pg_proc procedure join target_namespace namespace on namespace.oid = procedure.pronamespace
union all
select 'trigger', table_catalog.schema_name || '.' || table_catalog.relname || '.' || trigger_catalog.tgname,
       jsonb_build_object('enabled', trigger_catalog.tgenabled)::text || E'\\n' || pg_get_triggerdef(trigger_catalog.oid, true),
       pg_get_userbyid(table_catalog.relowner), table_catalog.relowner = (select oid from pg_roles where rolname = current_user),
       false, true, true
  from pg_trigger trigger_catalog join target_tables table_catalog on table_catalog.oid = trigger_catalog.tgrelid
 where not trigger_catalog.tgisinternal
union all
select 'index', table_catalog.schema_name || '.' || table_catalog.relname || '.' || index_catalog.relname,
       pg_get_indexdef(index_catalog.oid), pg_get_userbyid(index_catalog.relowner),
       index_catalog.relowner = (select oid from pg_roles where rolname = current_user), false,
       index_state.indisvalid, index_state.indisready
  from pg_index index_state join pg_class index_catalog on index_catalog.oid = index_state.indexrelid
  join target_tables table_catalog on table_catalog.oid = index_state.indrelid
union all
select 'constraint', table_catalog.schema_name || '.' || table_catalog.relname || '.' || constraint_catalog.conname,
       jsonb_build_object('type', constraint_catalog.contype, 'deferrable', constraint_catalog.condeferrable,
         'deferred', constraint_catalog.condeferred, 'noInherit', constraint_catalog.connoinherit)::text
         || E'\\n' || pg_get_constraintdef(constraint_catalog.oid, true),
       pg_get_userbyid(table_catalog.relowner), table_catalog.relowner = (select oid from pg_roles where rolname = current_user),
       false, constraint_catalog.convalidated, true
  from pg_constraint constraint_catalog join target_tables table_catalog on table_catalog.oid = constraint_catalog.conrelid
union all
select 'other_relation', namespace.name || '.' || relation.relkind::text || ':' || relation.relname,
       jsonb_build_object('kind', relation.relkind, 'persistence', relation.relpersistence)::text,
       pg_get_userbyid(relation.relowner), relation.relowner = (select oid from pg_roles where rolname = current_user),
       false, true, true
  from pg_class relation join target_namespace namespace on namespace.oid = relation.relnamespace
 where relation.relkind not in ('r', 'p', 'i')
order by category, identity
`;

export const PULSO_SCHEMA_VERSION_QUERY = `
select current_version::int, migration_name
  from pulso_iris.schema_version
 where service_name = 'pulso'
`;

export const PULSO_MIGRATION_LEDGER_QUERY = `
select name, checksum from pulso_iris.migration_ledger order by name
`;

export async function inspectPulsoRoleSecurity(client: PulsoSchemaClient): Promise<PulsoRoleSecurityRow> {
  const result = await client.query<PulsoRoleSecurityRow>(PULSO_ROLE_SECURITY_QUERY);
  const role = result.rows[0];
  if (result.rows.length !== 1 || !role)
    throw new Error("PULSO database role security inspection returned no unique role");
  return role;
}

export async function assertPulsoMigratorDatabaseSecurity(client: PulsoSchemaClient): Promise<PulsoRoleSecurityRow> {
  const role = await inspectPulsoRoleSecurity(client);
  const issues: string[] = [];
  if (role.current_user !== PULSO_MIGRATOR_ROLE) issues.push(`migrator current_user must be ${PULSO_MIGRATOR_ROLE}`);
  if (!role.can_login) issues.push("migrator role must have LOGIN");
  if (role.unsafe_capabilities) issues.push("migrator role has an elevated capability");
  if (role.has_memberships) issues.push("migrator role has a direct or inherited membership");
  if (!role.owns_current_database) issues.push("migrator role must own the current logical database");
  if (role.owns_other_database) issues.push("migrator role owns another database");
  if (role.owns_unexpected_objects) issues.push("migrator role owns objects outside the PULSO closure");
  if (!role.can_connect_database || !role.can_create_in_database) issues.push("migrator lacks CONNECT or CREATE");
  if (role.public_database_privileges.length > 0) issues.push("current logical database grants privileges to PUBLIC");
  if (issues.length > 0) throw new Error(`PULSO migrator security assertion failed: ${issues.join("; ")}`);
  return role;
}

export async function inspectPulsoRuntimeSecurity(client: PulsoSchemaClient): Promise<PulsoRuntimeSecurityInspection> {
  const role = await inspectPulsoRoleSecurity(client);
  const acl = await client.query<PulsoAclRow>(PULSO_RUNTIME_ACL_QUERY);
  return { role, acl: acl.rows, issues: evaluatePulsoRuntimeSecurity(role, acl.rows) };
}

export async function assertPulsoRuntimeDatabaseSecurity(
  client: PulsoSchemaClient
): Promise<PulsoRuntimeSecurityInspection> {
  const inspection = await inspectPulsoRuntimeSecurity(client);
  if (inspection.issues.length > 0)
    throw new Error(`PULSO runtime security assertion failed: ${inspection.issues.join("; ")}`);
  return inspection;
}

export async function assertPulsoRuntimeDatabaseBoundary(client: PulsoSchemaClient): Promise<{
  schema: PulsoSchemaInspection;
  security: PulsoRuntimeSecurityInspection;
}> {
  const security = await assertPulsoRuntimeDatabaseSecurity(client);
  const schema = await inspectPulsoSchema(client, "runtime");
  assertPulsoSchemaCompatible(schema);
  if (schema.state !== "managed") throw new Error(`PULSO runtime requires managed schema, got ${schema.state}`);
  return { schema, security };
}

export function evaluatePulsoRuntimeSecurity(role: PulsoRoleSecurityRow, acl: PulsoAclRow[]): string[] {
  const issues: string[] = [];
  const policy = PULSO_RUNTIME_POLICIES[role.current_user as PulsoRuntimeRole];
  if (!policy || !PULSO_RUNTIME_ROLE_DEFINITIONS.some((definition) => definition.role === role.current_user)) {
    issues.push(`unexpected PULSO runtime role ${role.current_user}`);
    return issues;
  }
  if (!role.can_login) issues.push("runtime role must have LOGIN");
  if (role.unsafe_capabilities) issues.push("runtime role has an elevated capability");
  if (role.has_memberships) issues.push("runtime role has a direct or inherited membership");
  if (
    role.owns_current_database ||
    role.owns_other_database ||
    role.owns_provider_objects ||
    role.owns_unexpected_objects
  ) {
    issues.push("runtime role owns a database or schema object");
  }
  if (!role.can_connect_database || role.can_create_in_database || role.can_create_temporary) {
    issues.push("runtime database privileges must be exactly CONNECT");
  }
  if (role.public_database_privileges.length > 0) issues.push("current logical database grants privileges to PUBLIC");

  const expected = new Map<string, readonly string[]>();
  const databaseRows = acl.filter((row) => row.category === "database");
  if (databaseRows.length === 1) expected.set(`database:${databaseRows[0]!.identity}`, ["CONNECT"]);
  else issues.push(`runtime ACL catalog must contain one current database row, got ${databaseRows.length}`);
  for (const schema of PULSO_PROVIDER_SCHEMAS) {
    expected.set(`schema:${schema}`, policy.schemas.includes(schema) ? ["USAGE"] : []);
  }
  for (const [table, privileges] of Object.entries(policy.tables)) expected.set(`table:${table}`, privileges);
  for (const [fn, privileges] of Object.entries(policy.functions)) expected.set(`function:${fn}`, privileges);

  const actualKeys = new Set<string>();
  for (const row of acl) {
    const key = `${row.category}:${row.identity}`;
    actualKeys.add(key);
    const expectedPrivileges = expected.get(key);
    if (!expectedPrivileges) {
      issues.push(`unexpected runtime ACL object ${key}`);
      continue;
    }
    if (!sameStringArray(row.privileges, expectedPrivileges)) {
      issues.push(`${key} effective privileges must be [${expectedPrivileges.join(",")}]`);
    }
    if (!sameStringArray(row.direct_privileges, expectedPrivileges)) {
      issues.push(`${key} direct privileges must be [${expectedPrivileges.join(",")}]`);
    }
  }
  for (const key of expected.keys()) if (!actualKeys.has(key)) issues.push(`runtime ACL object ${key} is missing`);
  return issues;
}

export async function inspectPulsoSchema(
  client: PulsoSchemaClient,
  mode: PulsoSchemaInspectionMode = "migrator",
  manifests: PulsoSchemaManifestSet = PULSO_SCHEMA_MANIFEST
): Promise<PulsoSchemaInspection> {
  const catalog = await client.query<PulsoSchemaCatalogRow>(PULSO_SCHEMA_CATALOG_QUERY);
  const hasVersionTable = catalog.rows.some(
    (row) => row.category === "table" && row.identity === "pulso_iris.schema_version"
  );
  const hasLedgerTable = catalog.rows.some(
    (row) => row.category === "table" && row.identity === "pulso_iris.migration_ledger"
  );
  const versions = hasVersionTable
    ? await client.query<PulsoSchemaVersionRow>(PULSO_SCHEMA_VERSION_QUERY)
    : { rows: [] };
  const ledger =
    hasLedgerTable && mode === "migrator"
      ? await client.query<PulsoMigrationLedgerRow>(PULSO_MIGRATION_LEDGER_QUERY)
      : { rows: [] };
  return evaluatePulsoSchemaSnapshot(catalog.rows, versions.rows, ledger.rows, manifests, mode);
}

export function evaluatePulsoSchemaSnapshot(
  catalog: PulsoSchemaCatalogRow[],
  versions: PulsoSchemaVersionRow[],
  ledgerEntries: PulsoMigrationLedgerRow[],
  manifests: PulsoSchemaManifestSet = PULSO_SCHEMA_MANIFEST,
  mode: PulsoSchemaInspectionMode = "migrator"
): PulsoSchemaInspection {
  const categorySummaries = summarizePulsoCatalog(catalog);
  const objectRows = catalog.filter((row) => row.category !== "schema");
  const hasLedgerTable = catalog.some(
    (row) => row.category === "table" && row.identity === "pulso_iris.migration_ledger"
  );
  const version = versions.length === 1 ? versions[0] : undefined;
  const numericVersion = version ? Number(version.current_version) : undefined;
  const commonIssues = catalog.flatMap((row) => {
    const issues: string[] = [];
    if (mode === "migrator" && row.definition !== "absent" && !row.owner_is_current_user) {
      issues.push(`${row.category} ${row.identity} is not owned by current_user`);
    }
    if (
      mode === "runtime" &&
      row.definition !== "absent" &&
      (row.owner_is_current_user || row.owner !== PULSO_SCHEMA_OWNER_ROLE)
    ) {
      issues.push(`${row.category} ${row.identity} must be owned by ${PULSO_SCHEMA_OWNER_ROLE} and not by runtime`);
    }
    if (row.public_privileged) issues.push(`${row.category} ${row.identity} grants a critical privilege to PUBLIC`);
    const allowedLegacyValidationDebt =
      mode === "migrator" &&
      (!hasLedgerTable || numericVersion === PULSO_LEGACY_SCHEMA_VERSION) &&
      row.category === "constraint" &&
      LEGACY_UNVALIDATED_CONSTRAINTS.has(row.identity);
    if (!row.valid && !allowedLegacyValidationDebt) issues.push(`${row.category} ${row.identity} is not valid`);
    if (!row.ready) issues.push(`${row.category} ${row.identity} is not ready`);
    return issues;
  });

  if (objectRows.length === 0) {
    const schemaMarkersValid = PULSO_PROVIDER_SCHEMAS.every((schema) =>
      catalog.some(
        (row) => row.category === "schema" && row.identity === schema && ["absent", "present"].includes(row.definition)
      )
    );
    const issues = [...commonIssues];
    if (!schemaMarkersValid) issues.push("PULSO schema catalog markers are missing or invalid");
    return {
      state: issues.length === 0 ? "fresh" : "incompatible",
      issues,
      catalog,
      categorySummaries,
      ledgerEntries: []
    };
  }

  const issues = [...commonIssues];
  let expected = manifests.legacy;

  if (hasLedgerTable) {
    if (manifests.managedByVersion) {
      const versionedManifest = numericVersion === undefined ? undefined : manifests.managedByVersion[numericVersion];
      if (versionedManifest) {
        expected = versionedManifest;
      } else {
        issues.push(
          numericVersion === undefined
            ? "managed PULSO schema has no unique version for structural manifest selection"
            : `managed PULSO schema version ${numericVersion} has no structural manifest`
        );
        expected = manifests.managed;
      }
    } else {
      expected = manifests.managed;
    }
  }
  issues.push(...comparePulsoCatalogToManifest(catalog, expected));

  if (hasLedgerTable) {
    if (!version) issues.push("pulso_iris.schema_version must contain exactly one row for service pulso");
    if (mode === "migrator") {
      const baselineEntries = ledgerEntries.filter((row) => row.name === PULSO_BASELINE_MIGRATION);
      if (baselineEntries.length !== 1)
        issues.push(`pulso_iris.migration_ledger must contain exactly one ${PULSO_BASELINE_MIGRATION} row`);
    } else {
      if (!version || Number(version.current_version) !== PULSO_CURRENT_SCHEMA_VERSION) {
        issues.push(`runtime requires PULSO schema version ${PULSO_CURRENT_SCHEMA_VERSION}`);
      }
      if (version?.migration_name !== PULSO_CURRENT_MIGRATION) {
        issues.push(`runtime requires PULSO migration ${PULSO_CURRENT_MIGRATION}`);
      }
    }
    return {
      state: issues.length === 0 ? "managed" : "incompatible",
      issues,
      catalog,
      categorySummaries,
      currentVersion: version ? Number(version.current_version) : undefined,
      migrationName: version?.migration_name,
      ledgerEntries
    };
  }

  if (versions.length > 0) issues.push("legacy PULSO closure cannot contain provider schema_version rows");
  if (mode === "runtime") issues.push("runtime requires the provider-owned migration ledger");
  if (ledgerEntries.length > 0) issues.push("legacy PULSO closure cannot have detached migration ledger rows");
  return { state: issues.length === 0 ? "legacy" : "incompatible", issues, catalog, categorySummaries, ledgerEntries };
}

export function summarizePulsoCatalog(catalog: PulsoSchemaCatalogRow[]): Record<string, PulsoCatalogCategoryManifest> {
  const result: Record<string, PulsoCatalogCategoryManifest> = {};
  for (const category of [
    "extension",
    "table",
    "column",
    "function",
    "trigger",
    "index",
    "constraint",
    "other_relation"
  ] as const) {
    const rows = catalog
      .filter((row) => row.category === category)
      .map((row) => ({
        identity: row.identity,
        definition: normalizeDefinition(row.definition),
        valid: Boolean(row.valid),
        ready: Boolean(row.ready)
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity));
    result[category] = {
      count: rows.length,
      fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex")
    };
  }
  return result;
}

export function createPulsoStructuralManifest(catalog: PulsoSchemaCatalogRow[]): PulsoStructuralManifest {
  const summaries = summarizePulsoCatalog(catalog);
  return {
    extension: summaries.extension!,
    table: summaries.table!,
    column: summaries.column!,
    function: summaries.function!,
    trigger: summaries.trigger!,
    index: summaries.index!,
    constraint: summaries.constraint!,
    other_relation: summaries.other_relation!
  };
}

export function comparePulsoCatalogToManifest(
  catalog: PulsoSchemaCatalogRow[],
  manifest: PulsoStructuralManifest
): string[] {
  const summaries = summarizePulsoCatalog(catalog);
  const issues: string[] = [];
  for (const category of Object.keys(manifest) as Array<keyof PulsoStructuralManifest>) {
    const actual = summaries[category];
    const expected = manifest[category];
    if (!actual || actual.count !== expected.count) {
      issues.push(`${category} inventory count mismatch: expected ${expected.count}, got ${actual?.count ?? 0}`);
      continue;
    }
    if (actual.fingerprint !== expected.fingerprint) issues.push(`${category} structural fingerprint mismatch`);
    for (const identity of expected.identities ?? []) {
      if (!catalog.some((row) => row.category === category && row.identity === identity))
        issues.push(`${category} ${identity} is missing`);
    }
  }
  return issues;
}

export function assertPulsoSchemaCompatible(inspection: PulsoSchemaInspection): void {
  if (inspection.state === "incompatible")
    throw new Error(`PULSO schema adoption refused: ${inspection.issues.join("; ")}`);
}

function normalizeDefinition(definition: string): string {
  return definition
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
