import { createHash } from "node:crypto";

export const LUMEN_SCHEMA_NAME = "lumen";
export const LUMEN_LEGACY_SCHEMA_VERSION = 39;
export const LUMEN_CURRENT_SCHEMA_VERSION = 40;
export const LUMEN_BASELINE_MIGRATION = "001-lumen-autonomous-baseline.sql";
export const LUMEN_CURRENT_MIGRATION = "002-lumen-runtime-role.sql";
export const LUMEN_SCHEMA_OWNER_ROLE = "hyperion_lumen_migrator";
export const LUMEN_RUNTIME_ROLE = "hyperion_lumen";

export const LUMEN_SCHEMA_SECURITY_POLICY = {
  publicPrivilegesAllowed: false,
  migratorMustOwnCatalog: true,
  runtimeOwnerRole: LUMEN_SCHEMA_OWNER_ROLE,
  runtimeMustNotOwnCatalog: true
} as const;

export type LumenSchemaInspectionMode = "migrator" | "runtime";

export interface LumenRoleSecurityRow {
  current_user: string;
  can_login: boolean;
  unsafe_capabilities: boolean;
  has_memberships: boolean;
  owns_current_database: boolean;
  owns_other_database: boolean;
  owns_lumen_objects: boolean;
  owns_non_lumen_objects: boolean;
  can_connect_database: boolean;
  can_create_in_database: boolean;
  can_create_temporary: boolean;
  public_database_privileges: string[];
}

export interface LumenAclRow {
  category: "database" | "schema" | "table" | "column" | "function";
  identity: string;
  privileges: string[];
  direct_privileges: string[];
}

export interface LumenRuntimeSecurityInspection {
  role: LumenRoleSecurityRow;
  acl: LumenAclRow[];
  issues: string[];
}

export type LumenCatalogCategory =
  "schema" | "table" | "column" | "function" | "trigger" | "index" | "constraint" | "other_relation";

export interface LumenSchemaCatalogRow {
  category: LumenCatalogCategory;
  identity: string;
  definition: string;
  owner: string | null;
  owner_is_current_user: boolean;
  public_privileged: boolean;
  valid: boolean;
  ready: boolean;
}

export interface LumenSchemaVersionRow {
  current_version: number;
  migration_name: string;
}

export interface LumenMigrationLedgerRow {
  name: string;
  checksum: string;
}

export interface LumenSchemaClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface LumenCatalogCategoryManifest {
  count: number;
  fingerprint: string;
  identities?: readonly string[];
}

export type LumenStructuralManifest = Readonly<
  Record<Exclude<LumenCatalogCategory, "schema">, LumenCatalogCategoryManifest>
>;

export interface LumenSchemaManifestSet {
  legacy: LumenStructuralManifest;
  managed: LumenStructuralManifest;
}

export type LumenSchemaState = "fresh" | "legacy" | "managed" | "incompatible";

export interface LumenSchemaInspection {
  state: LumenSchemaState;
  issues: string[];
  catalog: LumenSchemaCatalogRow[];
  categorySummaries: Record<string, LumenCatalogCategoryManifest>;
  currentVersion?: number;
  migrationName?: string;
  ledgerEntries: LumenMigrationLedgerRow[];
}

const BASELINE_TABLES = [
  "audio_cleanup_owner_leases",
  "clinical_records",
  "dictations",
  "encounter_reference_snapshots",
  "encounters",
  "inbox_events",
  "legacy_audio_scope_attestations",
  "n_minus_one_compatibility_windows",
  "operator_grants",
  "outbox_events",
  "preconsultation_summaries",
  "processing_attempts",
  "schema_version",
  "service_migrations",
  "tenant_snapshots"
] as const;

const BASELINE_FUNCTIONS = [
  "finalize_clinical_record_approval()",
  "guard_approved_dictation()",
  "guard_clinical_record()",
  "guard_dictation_real_audio_lineage()",
  "guard_encounter_reference_snapshot()",
  "guard_processing_attempt_transition()",
  "guard_synthetic_encounter()",
  "require_attested_legacy_cleanup_terminal()",
  "require_open_n1_compatibility_window()"
] as const;

const BASELINE_TRIGGERS = [
  "clinical_records.trg_finalize_clinical_record_approval",
  "clinical_records.trg_guard_clinical_record",
  "dictations.trg_guard_approved_dictation",
  "dictations.trg_guard_dictation_real_audio_lineage",
  "encounter_reference_snapshots.trg_guard_encounter_reference_snapshot",
  "encounters.trg_guard_synthetic_encounter",
  "processing_attempts.trg_guard_processing_attempt_transition",
  "processing_attempts.trg_require_attested_legacy_cleanup_terminal",
  "processing_attempts.trg_require_open_n1_compatibility_window"
] as const;

const REQUIRED_CONSTRAINTS = [
  "encounters.ck_lumen_encounter_synthetic_only",
  "dictations.fk_lumen_dictation_encounter_tenant",
  "dictations.fk_lumen_dictation_processing_attempt",
  "operator_grants.fk_lumen_operator_grant_tenant_snapshot",
  "preconsultation_summaries.fk_lumen_preconsultation_encounter_tenant",
  "processing_attempts.ck_lumen_processing_attempt_lifecycle",
  "processing_attempts.fk_lumen_processing_attempt_encounter_tenant",
  "clinical_records.fk_lumen_record_dictation_encounter",
  "clinical_records.fk_lumen_record_encounter_tenant",
  "encounter_reference_snapshots.fk_lumen_reference_tenant_snapshot",
  "legacy_audio_scope_attestations.legacy_audio_scope_attestations_cleanup_scope_id_fkey"
] as const;

const REQUIRED_INDEXES = [
  "dictations.idx_lumen_dictations_encounter",
  "dictations.idx_lumen_dictations_processing_attempt",
  "encounters.idx_lumen_encounters_worklist",
  "encounters.uq_lumen_encounters_demo_key",
  "processing_attempts.idx_lumen_processing_attempts_cleanup_pending",
  "processing_attempts.idx_lumen_processing_attempts_encounter",
  "processing_attempts.idx_lumen_processing_attempts_status",
  "processing_attempts.idx_lumen_processing_attempts_unresolved_cleanup_owner",
  "outbox_events.ix_lumen_outbox_claim",
  "n_minus_one_compatibility_windows.ux_lumen_single_open_n1_compatibility_window"
] as const;

export const LUMEN_RUNTIME_OPERATIONAL_TABLES = [
  "audio_cleanup_owner_leases",
  "clinical_records",
  "dictations",
  "encounter_reference_snapshots",
  "encounters",
  "inbox_events",
  "operator_grants",
  "outbox_events",
  "preconsultation_summaries",
  "processing_attempts",
  "tenant_snapshots"
] as const;

export const LUMEN_RUNTIME_TABLE_PRIVILEGES: Readonly<Record<string, readonly string[]>> = {
  audio_cleanup_owner_leases: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  clinical_records: ["INSERT", "SELECT", "UPDATE"],
  dictations: ["INSERT", "SELECT", "UPDATE"],
  encounter_reference_snapshots: ["INSERT", "SELECT", "UPDATE"],
  encounters: ["SELECT", "UPDATE"],
  inbox_events: ["INSERT", "SELECT", "UPDATE"],
  operator_grants: ["INSERT", "SELECT", "UPDATE"],
  outbox_events: ["INSERT", "SELECT", "UPDATE"],
  preconsultation_summaries: ["SELECT"],
  processing_attempts: ["INSERT", "SELECT", "UPDATE"],
  tenant_snapshots: ["INSERT", "SELECT", "UPDATE"],
  schema_version: ["SELECT"],
  service_migrations: ["SELECT"],
  legacy_audio_scope_attestations: [],
  migration_ledger: [],
  n_minus_one_compatibility_windows: []
};

export const LUMEN_RUNTIME_READ_ONLY_TABLES = ["schema_version", "service_migrations"] as const;
export const LUMEN_RUNTIME_PROTECTED_TABLES = [
  "legacy_audio_scope_attestations",
  "migration_ledger",
  "n_minus_one_compatibility_windows"
] as const;

// Fingerprints are generated from PostgreSQL 16 canonical catalog definitions of
// 001-lumen-autonomous-baseline.sql. They bind every identity and definition in
// each category; the readable inventories above make critical invariants obvious.
export const LUMEN_SCHEMA_MANIFEST: LumenSchemaManifestSet = {
  legacy: {
    table: {
      count: 15,
      fingerprint: "f862109ad961dd644922cf282416c8527a4cc89ec34b36be4ca1debacc64a24a",
      identities: BASELINE_TABLES
    },
    column: { count: 177, fingerprint: "83dd45e092e3a295675ed6c94eb9c3e29569f5a4e34104e85ebf1bfb82c75dbb" },
    function: {
      count: 9,
      fingerprint: "22f6090e02e2495df5fcac87e4d973040a861b833880979d95763db1fecb9f4e",
      identities: BASELINE_FUNCTIONS
    },
    trigger: {
      count: 9,
      fingerprint: "3e87766c7fa50938b14dd0231367c1da03e9d3ec53c15e5ede5f91e9b50b77f7",
      identities: BASELINE_TRIGGERS
    },
    index: {
      count: 42,
      fingerprint: "9999f5d609d6dd9da82274725417d44ef77c75d886a66a7afe9e975116948bd8",
      identities: REQUIRED_INDEXES
    },
    constraint: {
      count: 108,
      fingerprint: "b24ea753c0555aad48a8a4d61a43bf4b3a08d86b22a3f9050b5dfc0dd93de7a6",
      identities: REQUIRED_CONSTRAINTS
    },
    other_relation: { count: 0, fingerprint: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" }
  },
  managed: {
    table: {
      count: 16,
      fingerprint: "56dc913ea79b501ce3523d355df21ebe149102bbfa41fa63bd31515f2eb02775",
      identities: [...BASELINE_TABLES, "migration_ledger"]
    },
    column: { count: 180, fingerprint: "341249c20478aec1c8694c23a3f53f03005976bb0ebe6899a21f49bf943dfb34" },
    function: {
      count: 9,
      fingerprint: "22f6090e02e2495df5fcac87e4d973040a861b833880979d95763db1fecb9f4e",
      identities: BASELINE_FUNCTIONS
    },
    trigger: {
      count: 9,
      fingerprint: "3e87766c7fa50938b14dd0231367c1da03e9d3ec53c15e5ede5f91e9b50b77f7",
      identities: BASELINE_TRIGGERS
    },
    index: {
      count: 43,
      fingerprint: "e0f3625ee34cc452c4d41fc72da9665fd3952697940bd1ff3064cc79938e5599",
      identities: REQUIRED_INDEXES
    },
    constraint: {
      count: 110,
      fingerprint: "756a0fe83c992182f559d526265cdf3387bf3853f7625ae90b00f7a697209f6a",
      identities: REQUIRED_CONSTRAINTS
    },
    other_relation: { count: 0, fingerprint: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" }
  }
};

export const LUMEN_ROLE_SECURITY_QUERY = `
with active_role as (
  select role.* from pg_roles role where role.rolname = current_user
), lumen_toast_tables as (
  select relation.reltoastrelid as oid
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
   where namespace.nspname = 'lumen' and relation.reltoastrelid <> 0
), lumen_internal_relations as (
  select oid from lumen_toast_tables
  union
  select index_state.indexrelid
    from pg_index index_state
    join lumen_toast_tables toast_table on toast_table.oid = index_state.indrelid
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
       (exists (
          select 1 from pg_namespace namespace
           where namespace.nspname = 'lumen' and namespace.nspowner = role.oid
        ) or exists (
          select 1 from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
           where namespace.nspname = 'lumen' and relation.relowner = role.oid
        ) or exists (
          select 1 from pg_proc procedure
          join pg_namespace namespace on namespace.oid = procedure.pronamespace
           where namespace.nspname = 'lumen' and procedure.proowner = role.oid
        ) or exists (
          select 1 from pg_type type_catalog
          join pg_namespace namespace on namespace.oid = type_catalog.typnamespace
           where namespace.nspname = 'lumen' and type_catalog.typowner = role.oid
        )) as owns_lumen_objects,
       (exists (
          select 1 from pg_namespace namespace
           where namespace.nspname <> 'lumen' and namespace.nspowner = role.oid
        ) or exists (
          select 1 from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
           where namespace.nspname <> 'lumen' and relation.relowner = role.oid
             and not exists (select 1 from lumen_internal_relations internal where internal.oid = relation.oid)
        ) or exists (
          select 1 from pg_proc procedure
          join pg_namespace namespace on namespace.oid = procedure.pronamespace
           where namespace.nspname <> 'lumen' and procedure.proowner = role.oid
        ) or exists (
          select 1 from pg_type type_catalog
          join pg_namespace namespace on namespace.oid = type_catalog.typnamespace
           where namespace.nspname <> 'lumen' and type_catalog.typowner = role.oid
             and not exists (
               select 1 from lumen_internal_relations internal where internal.oid = type_catalog.typrelid
             )
        )) as owns_non_lumen_objects,
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

export const LUMEN_RUNTIME_ACL_QUERY = `
with active_role as (
  select role.oid from pg_roles role where role.rolname = current_user
), target_namespace as (
  select namespace.* from pg_namespace namespace where namespace.nspname = 'lumen'
)
select 'database'::text as category,
       database_catalog.datname as identity,
       array_remove(array[
         case when has_database_privilege(current_user, database_catalog.oid, 'CONNECT') then 'CONNECT' end,
         case when has_database_privilege(current_user, database_catalog.oid, 'CREATE') then 'CREATE' end,
         case when has_database_privilege(current_user, database_catalog.oid, 'TEMPORARY') then 'TEMPORARY' end
       ], null)::text[] as privileges,
       coalesce((
         select array_agg(acl.privilege_type || case when acl.is_grantable then ':GRANT' else '' end order by acl.privilege_type)
           from aclexplode(coalesce(database_catalog.datacl, acldefault('d'::"char", database_catalog.datdba))) acl
          where acl.grantee = (select oid from active_role)
       ), array[]::text[]) as direct_privileges
  from pg_database database_catalog
 where database_catalog.datname = current_database()
union all
select 'schema', namespace.nspname,
       array_remove(array[
         case when has_schema_privilege(current_user, namespace.oid, 'CREATE') then 'CREATE' end,
         case when has_schema_privilege(current_user, namespace.oid, 'USAGE') then 'USAGE' end
       ], null)::text[],
       coalesce((
         select array_agg(acl.privilege_type || case when acl.is_grantable then ':GRANT' else '' end order by acl.privilege_type)
           from aclexplode(coalesce(namespace.nspacl, acldefault('n'::"char", namespace.nspowner))) acl
          where acl.grantee = (select oid from active_role)
       ), array[]::text[])
  from target_namespace namespace
union all
select 'table', relation.relname,
       array_remove(array[
         case when has_table_privilege(current_user, relation.oid, 'DELETE') then 'DELETE' end,
         case when has_table_privilege(current_user, relation.oid, 'INSERT') then 'INSERT' end,
         case when has_table_privilege(current_user, relation.oid, 'REFERENCES') then 'REFERENCES' end,
         case when has_table_privilege(current_user, relation.oid, 'SELECT') then 'SELECT' end,
         case when has_table_privilege(current_user, relation.oid, 'TRIGGER') then 'TRIGGER' end,
         case when has_table_privilege(current_user, relation.oid, 'TRUNCATE') then 'TRUNCATE' end,
         case when has_table_privilege(current_user, relation.oid, 'UPDATE') then 'UPDATE' end
       ], null)::text[],
       coalesce((
         select array_agg(acl.privilege_type || case when acl.is_grantable then ':GRANT' else '' end order by acl.privilege_type)
           from aclexplode(coalesce(relation.relacl, acldefault('r'::"char", relation.relowner))) acl
          where acl.grantee = (select oid from active_role)
       ), array[]::text[])
  from pg_class relation
  join target_namespace namespace on namespace.oid = relation.relnamespace
 where relation.relkind in ('r', 'p')
union all
select 'column', relation.relname || '.' || attribute.attname,
       array_agg(acl.privilege_type || case when acl.is_grantable then ':GRANT' else '' end order by acl.privilege_type),
       array_agg(acl.privilege_type || case when acl.is_grantable then ':GRANT' else '' end order by acl.privilege_type)
  from pg_class relation
  join target_namespace namespace on namespace.oid = relation.relnamespace
  join pg_attribute attribute on attribute.attrelid = relation.oid
  cross join lateral aclexplode(attribute.attacl) acl
 where relation.relkind in ('r', 'p')
   and attribute.attnum > 0
   and not attribute.attisdropped
   and acl.grantee = (select oid from active_role)
 group by relation.relname, attribute.attname
union all
select 'function', procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')',
       array_remove(array[
         case when has_function_privilege(current_user, procedure.oid, 'EXECUTE') then 'EXECUTE' end
       ], null)::text[],
       coalesce((
         select array_agg(acl.privilege_type || case when acl.is_grantable then ':GRANT' else '' end order by acl.privilege_type)
           from aclexplode(coalesce(procedure.proacl, acldefault('f'::"char", procedure.proowner))) acl
          where acl.grantee = (select oid from active_role)
       ), array[]::text[])
  from pg_proc procedure
  join target_namespace namespace on namespace.oid = procedure.pronamespace
order by category, identity
`;

export const LUMEN_SCHEMA_CATALOG_QUERY = `
with target_namespace as (
  select namespace.oid, namespace.nspowner
    from pg_namespace namespace
   where namespace.nspname = 'lumen'
), target_tables as (
  select relation.*
    from pg_class relation
    join target_namespace namespace on namespace.oid = relation.relnamespace
   where relation.relkind in ('r', 'p')
)
select 'schema'::text as category,
       'lumen'::text as identity,
       case when namespace.oid is null then 'absent' else 'present' end as definition,
       case when namespace.oid is null then null else pg_get_userbyid(namespace.nspowner) end as owner,
       coalesce(namespace.nspowner = (select oid from pg_roles where rolname = current_user), true) as owner_is_current_user,
       coalesce(has_schema_privilege('public', namespace.oid, 'USAGE')
         or has_schema_privilege('public', namespace.oid, 'CREATE'), false) as public_privileged,
       true as valid,
       true as ready
  from (values (1)) seed(value)
  left join target_namespace namespace on true
union all
select 'table', relation.relname,
       jsonb_build_object(
         'kind', relation.relkind,
         'persistence', relation.relpersistence,
         'rowSecurity', relation.relrowsecurity,
         'forceRowSecurity', relation.relforcerowsecurity,
         'isPartition', relation.relispartition
       )::text,
       pg_get_userbyid(relation.relowner),
       relation.relowner = (select oid from pg_roles where rolname = current_user),
       has_table_privilege('public', relation.oid, 'SELECT')
         or has_table_privilege('public', relation.oid, 'INSERT')
         or has_table_privilege('public', relation.oid, 'UPDATE')
         or has_table_privilege('public', relation.oid, 'DELETE')
         or has_table_privilege('public', relation.oid, 'TRUNCATE')
         or has_table_privilege('public', relation.oid, 'REFERENCES')
         or has_table_privilege('public', relation.oid, 'TRIGGER'),
       true,
       true
  from target_tables relation
union all
select 'column', relation.relname || '.' || attribute.attname,
       jsonb_build_object(
         'ordinal', attribute.attnum,
         'type', format_type(attribute.atttypid, attribute.atttypmod),
         'notNull', attribute.attnotnull,
         'default', pg_get_expr(default_value.adbin, default_value.adrelid, true),
         'identity', attribute.attidentity,
         'generated', attribute.attgenerated,
         'collation', case when attribute.attcollation = 0 then null else attribute.attcollation::regcollation::text end
       )::text,
       pg_get_userbyid(relation.relowner),
       relation.relowner = (select oid from pg_roles where rolname = current_user),
       has_column_privilege('public', relation.oid, attribute.attnum, 'SELECT')
         or has_column_privilege('public', relation.oid, attribute.attnum, 'INSERT')
         or has_column_privilege('public', relation.oid, attribute.attnum, 'UPDATE')
         or has_column_privilege('public', relation.oid, attribute.attnum, 'REFERENCES'),
       true,
       true
  from target_tables relation
  join pg_attribute attribute on attribute.attrelid = relation.oid
  left join pg_attrdef default_value
    on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
 where attribute.attnum > 0 and not attribute.attisdropped
union all
select 'function', procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')',
       jsonb_build_object(
         'kind', procedure.prokind,
         'securityDefiner', procedure.prosecdef,
         'leakproof', procedure.proleakproof,
         'volatility', procedure.provolatile,
         'parallel', procedure.proparallel,
         'config', procedure.proconfig
       )::text || E'\\n' || pg_get_functiondef(procedure.oid),
       pg_get_userbyid(procedure.proowner),
       procedure.proowner = (select oid from pg_roles where rolname = current_user),
       has_function_privilege('public', procedure.oid, 'EXECUTE'),
       true,
       true
  from pg_proc procedure
  join target_namespace namespace on namespace.oid = procedure.pronamespace
union all
select 'trigger', table_catalog.relname || '.' || trigger_catalog.tgname,
       jsonb_build_object('enabled', trigger_catalog.tgenabled)::text
         || E'\\n' || pg_get_triggerdef(trigger_catalog.oid, true),
       pg_get_userbyid(table_catalog.relowner),
       table_catalog.relowner = (select oid from pg_roles where rolname = current_user),
       false,
       true,
       true
  from pg_trigger trigger_catalog
  join target_tables table_catalog on table_catalog.oid = trigger_catalog.tgrelid
 where not trigger_catalog.tgisinternal
union all
select 'index', table_catalog.relname || '.' || index_catalog.relname,
       pg_get_indexdef(index_catalog.oid),
       pg_get_userbyid(index_catalog.relowner),
       index_catalog.relowner = (select oid from pg_roles where rolname = current_user),
       false,
       index_state.indisvalid,
       index_state.indisready
  from pg_index index_state
  join pg_class index_catalog on index_catalog.oid = index_state.indexrelid
  join target_tables table_catalog on table_catalog.oid = index_state.indrelid
union all
select 'constraint', table_catalog.relname || '.' || constraint_catalog.conname,
       jsonb_build_object(
         'type', constraint_catalog.contype,
         'deferrable', constraint_catalog.condeferrable,
         'deferred', constraint_catalog.condeferred,
         'noInherit', constraint_catalog.connoinherit
       )::text || E'\\n' || pg_get_constraintdef(constraint_catalog.oid, true),
       pg_get_userbyid(table_catalog.relowner),
       table_catalog.relowner = (select oid from pg_roles where rolname = current_user),
       false,
       constraint_catalog.convalidated,
       true
  from pg_constraint constraint_catalog
  join target_tables table_catalog on table_catalog.oid = constraint_catalog.conrelid
union all
select 'other_relation', relation.relkind::text || ':' || relation.relname,
       jsonb_build_object('kind', relation.relkind, 'persistence', relation.relpersistence)::text,
       pg_get_userbyid(relation.relowner),
       relation.relowner = (select oid from pg_roles where rolname = current_user),
       false,
       true,
       true
  from pg_class relation
  join target_namespace namespace on namespace.oid = relation.relnamespace
 where relation.relkind not in ('r', 'p', 'i')
order by category, identity
`;

export const LUMEN_SCHEMA_VERSION_QUERY = `
select current_version::int, migration_name
  from lumen.schema_version
 where service_name = 'lumen'
`;

export const LUMEN_MIGRATION_LEDGER_QUERY = `
select name, checksum
  from lumen.migration_ledger
 order by name
`;

export async function inspectLumenRoleSecurity(client: LumenSchemaClient): Promise<LumenRoleSecurityRow> {
  const result = await client.query<LumenRoleSecurityRow>(LUMEN_ROLE_SECURITY_QUERY);
  const role = result.rows[0];
  if (result.rows.length !== 1 || !role)
    throw new Error("LUMEN database role security inspection returned no unique role");
  return role;
}

export async function assertLumenMigratorDatabaseSecurity(client: LumenSchemaClient): Promise<LumenRoleSecurityRow> {
  const role = await inspectLumenRoleSecurity(client);
  const issues: string[] = [];
  if (role.current_user !== LUMEN_SCHEMA_OWNER_ROLE) {
    issues.push(`migrator current_user must be ${LUMEN_SCHEMA_OWNER_ROLE}`);
  }
  if (!role.can_login) issues.push("migrator role must have LOGIN");
  if (role.unsafe_capabilities) issues.push("migrator role has an elevated capability");
  if (role.has_memberships) issues.push("migrator role has a direct or inherited membership");
  if (!role.owns_current_database) issues.push("migrator role must own the current logical database");
  if (role.owns_other_database) issues.push("migrator role owns another database");
  if (role.owns_non_lumen_objects) issues.push("migrator role owns objects outside the LUMEN boundary");
  if (!role.can_connect_database || !role.can_create_in_database) {
    issues.push("migrator role lacks CONNECT or CREATE on the current logical database");
  }
  if (role.public_database_privileges.length > 0) {
    issues.push("current logical database grants privileges to PUBLIC");
  }
  if (issues.length > 0) throw new Error(`LUMEN migrator security assertion failed: ${issues.join("; ")}`);
  return role;
}

export async function inspectLumenRuntimeSecurity(client: LumenSchemaClient): Promise<LumenRuntimeSecurityInspection> {
  const role = await inspectLumenRoleSecurity(client);
  const acl = await client.query<LumenAclRow>(LUMEN_RUNTIME_ACL_QUERY);
  const issues = evaluateLumenRuntimeSecurity(role, acl.rows);
  return { role, acl: acl.rows, issues };
}

export async function assertLumenRuntimeDatabaseSecurity(
  client: LumenSchemaClient
): Promise<LumenRuntimeSecurityInspection> {
  const inspection = await inspectLumenRuntimeSecurity(client);
  if (inspection.issues.length > 0) {
    throw new Error(`LUMEN runtime security assertion failed: ${inspection.issues.join("; ")}`);
  }
  return inspection;
}

export async function assertLumenRuntimeDatabaseBoundary(client: LumenSchemaClient): Promise<{
  schema: LumenSchemaInspection;
  security: LumenRuntimeSecurityInspection;
}> {
  const security = await assertLumenRuntimeDatabaseSecurity(client);
  const schema = await inspectLumenSchema(client, "runtime");
  assertLumenSchemaCompatible(schema);
  if (schema.state !== "managed") throw new Error(`LUMEN runtime requires managed schema, got ${schema.state}`);
  return { schema, security };
}

export function evaluateLumenRuntimeSecurity(role: LumenRoleSecurityRow, acl: LumenAclRow[]): string[] {
  const issues: string[] = [];
  if (role.current_user !== LUMEN_RUNTIME_ROLE) issues.push(`runtime current_user must be ${LUMEN_RUNTIME_ROLE}`);
  if (!role.can_login) issues.push("runtime role must have LOGIN");
  if (role.unsafe_capabilities) issues.push("runtime role has an elevated capability");
  if (role.has_memberships) issues.push("runtime role has a direct or inherited membership");
  if (
    role.owns_current_database ||
    role.owns_other_database ||
    role.owns_lumen_objects ||
    role.owns_non_lumen_objects
  ) {
    issues.push("runtime role owns a database or schema object");
  }
  if (!role.can_connect_database || role.can_create_in_database || role.can_create_temporary) {
    issues.push("runtime database privileges must be exactly CONNECT");
  }
  if (role.public_database_privileges.length > 0) issues.push("current logical database grants privileges to PUBLIC");

  const expected = new Map<string, string[]>();
  const databaseRows = acl.filter((row) => row.category === "database");
  if (databaseRows.length === 1) expected.set(`database:${databaseRows[0]!.identity}`, ["CONNECT"]);
  else issues.push(`runtime ACL catalog must contain one current database row, got ${databaseRows.length}`);
  expected.set("schema:lumen", ["USAGE"]);
  for (const [table, privileges] of Object.entries(LUMEN_RUNTIME_TABLE_PRIVILEGES)) {
    expected.set(`table:${table}`, [...privileges]);
  }
  for (const procedure of BASELINE_FUNCTIONS) expected.set(`function:${procedure}`, []);

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
  for (const key of expected.keys()) {
    if (!actualKeys.has(key)) issues.push(`runtime ACL object ${key} is missing`);
  }
  return issues;
}

export async function inspectLumenSchema(
  client: LumenSchemaClient,
  mode: LumenSchemaInspectionMode = "migrator",
  manifests: LumenSchemaManifestSet = LUMEN_SCHEMA_MANIFEST
): Promise<LumenSchemaInspection> {
  const catalog = await client.query<LumenSchemaCatalogRow>(LUMEN_SCHEMA_CATALOG_QUERY);
  const hasVersionTable = catalog.rows.some((row) => row.category === "table" && row.identity === "schema_version");
  const hasLedgerTable = catalog.rows.some((row) => row.category === "table" && row.identity === "migration_ledger");
  const versions = hasVersionTable
    ? await client.query<LumenSchemaVersionRow>(LUMEN_SCHEMA_VERSION_QUERY)
    : { rows: [] as LumenSchemaVersionRow[] };
  const ledger =
    hasLedgerTable && mode === "migrator"
      ? await client.query<LumenMigrationLedgerRow>(LUMEN_MIGRATION_LEDGER_QUERY)
      : { rows: [] as LumenMigrationLedgerRow[] };
  return evaluateLumenSchemaSnapshot(catalog.rows, versions.rows, ledger.rows, manifests, mode);
}

export function evaluateLumenSchemaSnapshot(
  catalog: LumenSchemaCatalogRow[],
  versions: LumenSchemaVersionRow[],
  ledgerEntries: LumenMigrationLedgerRow[],
  manifests: LumenSchemaManifestSet = LUMEN_SCHEMA_MANIFEST,
  mode: LumenSchemaInspectionMode = "migrator"
): LumenSchemaInspection {
  const schema = catalog.find((row) => row.category === "schema" && row.identity === LUMEN_SCHEMA_NAME);
  const objectRows = catalog.filter((row) => row.category !== "schema");
  const categorySummaries = summarizeLumenCatalog(catalog);
  const commonIssues = catalog.flatMap((row) => {
    const issues: string[] = [];
    if (mode === "migrator" && !row.owner_is_current_user) {
      issues.push(`${row.category} ${row.identity} is not owned by current_user`);
    }
    if (
      mode === "runtime" &&
      row.definition !== "absent" &&
      (row.owner_is_current_user || row.owner !== LUMEN_SCHEMA_SECURITY_POLICY.runtimeOwnerRole)
    ) {
      issues.push(
        `${row.category} ${row.identity} must be owned by ${LUMEN_SCHEMA_SECURITY_POLICY.runtimeOwnerRole} and not by runtime`
      );
    }
    if (row.public_privileged) issues.push(`${row.category} ${row.identity} grants a critical privilege to PUBLIC`);
    if (!row.valid) issues.push(`${row.category} ${row.identity} is not valid`);
    if (!row.ready) issues.push(`${row.category} ${row.identity} is not ready`);
    return issues;
  });

  if (objectRows.length === 0) {
    const freshIssues = [...commonIssues];
    if (!schema || !["absent", "present"].includes(schema.definition)) {
      freshIssues.push("lumen schema catalog marker is missing or invalid");
    }
    return {
      state: freshIssues.length === 0 ? "fresh" : "incompatible",
      issues: freshIssues,
      catalog,
      categorySummaries,
      ledgerEntries: []
    };
  }

  const hasLedgerTable = catalog.some((row) => row.category === "table" && row.identity === "migration_ledger");
  const expected = hasLedgerTable ? manifests.managed : manifests.legacy;
  const issues = [...commonIssues, ...compareLumenCatalogToManifest(catalog, expected)];
  const version = versions.length === 1 ? versions[0] : undefined;
  if (!version) issues.push("lumen.schema_version must contain exactly one row for service lumen");

  if (hasLedgerTable) {
    if (mode === "migrator") {
      const baselineEntries = ledgerEntries.filter((row) => row.name === LUMEN_BASELINE_MIGRATION);
      if (baselineEntries.length !== 1) {
        issues.push(`lumen.migration_ledger must contain exactly one ${LUMEN_BASELINE_MIGRATION} row`);
      }
    } else {
      if (!version || Number(version.current_version) !== LUMEN_CURRENT_SCHEMA_VERSION) {
        issues.push(`runtime requires LUMEN schema version ${LUMEN_CURRENT_SCHEMA_VERSION}`);
      }
      if (version?.migration_name !== LUMEN_CURRENT_MIGRATION) {
        issues.push(`runtime requires LUMEN migration ${LUMEN_CURRENT_MIGRATION}`);
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

  if (version && Number(version.current_version) !== LUMEN_LEGACY_SCHEMA_VERSION) {
    issues.push(
      `legacy lumen.schema_version must be exactly ${LUMEN_LEGACY_SCHEMA_VERSION}, got ${String(version.current_version)}`
    );
  }
  if (mode === "runtime") issues.push("runtime requires the provider-owned migration ledger");
  if (ledgerEntries.length > 0) issues.push("legacy LUMEN schema cannot have detached migration ledger rows");
  return {
    state: issues.length === 0 ? "legacy" : "incompatible",
    issues,
    catalog,
    categorySummaries,
    currentVersion: version ? Number(version.current_version) : undefined,
    migrationName: version?.migration_name,
    ledgerEntries
  };
}

export function summarizeLumenCatalog(catalog: LumenSchemaCatalogRow[]): Record<string, LumenCatalogCategoryManifest> {
  const result: Record<string, LumenCatalogCategoryManifest> = {};
  for (const category of ["table", "column", "function", "trigger", "index", "constraint", "other_relation"] as const) {
    const rows = catalog
      .filter((row) => row.category === category)
      .map((row) => ({
        identity: row.identity,
        definition: normalizeLumenCatalogDefinition(row.definition),
        valid: Boolean(row.valid),
        ready: Boolean(row.ready)
      }))
      .sort((left, right) => (left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0));
    result[category] = {
      count: rows.length,
      fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex")
    };
  }
  return result;
}

export function createLumenStructuralManifest(catalog: LumenSchemaCatalogRow[]): LumenStructuralManifest {
  const summaries = summarizeLumenCatalog(catalog);
  return {
    table: summaries.table!,
    column: summaries.column!,
    function: summaries.function!,
    trigger: summaries.trigger!,
    index: summaries.index!,
    constraint: summaries.constraint!,
    other_relation: summaries.other_relation!
  };
}

export function compareLumenCatalogToManifest(
  catalog: LumenSchemaCatalogRow[],
  manifest: LumenStructuralManifest
): string[] {
  const summaries = summarizeLumenCatalog(catalog);
  const issues: string[] = [];
  for (const category of Object.keys(manifest) as Array<keyof LumenStructuralManifest>) {
    const actual = summaries[category];
    const expected = manifest[category];
    if (!actual || actual.count !== expected.count) {
      issues.push(`${category} inventory count mismatch: expected ${expected.count}, got ${actual?.count ?? 0}`);
      continue;
    }
    if (actual.fingerprint !== expected.fingerprint) {
      issues.push(`${category} structural fingerprint mismatch`);
    }
    for (const identity of expected.identities ?? []) {
      if (!catalog.some((row) => row.category === category && row.identity === identity)) {
        issues.push(`${category} ${identity} is missing`);
      }
    }
  }
  return issues;
}

export function assertLumenSchemaCompatible(inspection: LumenSchemaInspection): void {
  if (inspection.state !== "incompatible") return;
  throw new Error(`LUMEN schema adoption refused: ${inspection.issues.join("; ")}`);
}

function normalizeLumenCatalogDefinition(definition: string): string {
  return definition
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function sameStringArray(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
