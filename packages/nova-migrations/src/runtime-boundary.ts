import { NOVA_CELL_DATABASE_ROLES, NOVA_MIGRATOR_ROLE, type NovaCellDatabaseRole } from "./config.js";
import {
  NOVA_PROVIDER_LEDGER,
  NOVA_PROVIDER_ROUTINES,
  NOVA_PROVIDER_TABLES,
  NOVA_RUNTIME_NO_DELETE_TABLES,
  NOVA_RUNTIME_READ_ONLY_TABLES
} from "./schema-manifest.js";

const PROVIDER_SCHEMAS = ["documents", "liwa", "nova", "voice"] as const;
const TABLE_PRIVILEGES = ["select", "insert", "update", "delete", "truncate", "references", "trigger"] as const;

const ROLE_SCHEMA = new Map<NovaCellDatabaseRole, (typeof PROVIDER_SCHEMAS)[number]>([
  ["hyperion_nova", "nova"],
  ["hyperion_voice", "voice"],
  ["hyperion_liwa", "liwa"],
  ["hyperion_documents", "documents"]
]);

export interface NovaBoundaryClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];
type TableBoundaryRow = { [privilege in `can_${TablePrivilege}`]: boolean } & {
  owner: string;
  relation: string;
  schema_name: string;
};

export async function assertNovaRuntimeDatabaseBoundary(client: NovaBoundaryClient): Promise<void> {
  const hardened = await client.query<{ search_path: string }>(
    "select pg_catalog.set_config('search_path', 'pg_catalog', false) as search_path"
  );
  if (hardened.rows[0]?.search_path !== "pg_catalog") {
    throw new Error("NOVA runtime boundary could not pin target search_path");
  }

  const issues: string[] = [];
  const database = await client.query<{ database: string; owner: string }>(
    `select current_database() as database,
            pg_catalog.pg_get_userbyid(database_catalog.datdba) as owner
       from pg_catalog.pg_database database_catalog
      where database_catalog.datname = current_database()`
  );
  if (database.rows.length !== 1 || database.rows[0]?.owner !== NOVA_MIGRATOR_ROLE) {
    issues.push("database owner is not the NOVA migrator");
  }

  const ledger = await client.query<{ checksum: string; name: string }>(
    "select name, checksum from nova.migration_ledger order by name"
  );
  if (
    ledger.rows.length !== NOVA_PROVIDER_LEDGER.length ||
    ledger.rows.some(
      (row, index) =>
        row.name !== NOVA_PROVIDER_LEDGER[index]?.name || row.checksum !== NOVA_PROVIDER_LEDGER[index]?.checksum
    )
  ) {
    issues.push("provider ledger is not exact");
  }

  const schemas = await client.query<{
    can_create: boolean;
    can_use: boolean;
    owner: string;
    role_name: NovaCellDatabaseRole;
    schema_name: string;
  }>(
    `select provider_schema.nspname as schema_name,
            runtime_role.rolname as role_name,
            pg_catalog.pg_get_userbyid(provider_schema.nspowner) as owner,
            pg_catalog.has_schema_privilege(runtime_role.rolname, provider_schema.oid, 'usage') as can_use,
            pg_catalog.has_schema_privilege(runtime_role.rolname, provider_schema.oid, 'create') as can_create
       from pg_catalog.pg_namespace provider_schema
       cross join pg_catalog.pg_roles runtime_role
      where provider_schema.nspname = any($1::text[])
        and runtime_role.rolname = any($2::text[])
      order by schema_name, role_name`,
    [PROVIDER_SCHEMAS, NOVA_CELL_DATABASE_ROLES.map(({ role }) => role)]
  );
  if (schemas.rows.length !== PROVIDER_SCHEMAS.length * NOVA_CELL_DATABASE_ROLES.length) {
    issues.push("provider schema matrix is incomplete");
  }
  for (const row of schemas.rows) {
    if (row.owner !== NOVA_MIGRATOR_ROLE) issues.push(`${row.schema_name} has a foreign owner`);
    if (row.can_create || row.can_use !== (ROLE_SCHEMA.get(row.role_name) === row.schema_name)) {
      issues.push(`${row.role_name} schema privileges drifted for ${row.schema_name}`);
    }
  }

  const tablesByRole = new Map<NovaCellDatabaseRole, TableBoundaryRow[]>();
  for (const { role } of NOVA_CELL_DATABASE_ROLES) {
    const tables = await client.query<TableBoundaryRow>(
      `select namespace.nspname as schema_name,
              namespace.nspname || '.' || relation.relname as relation,
              pg_catalog.pg_get_userbyid(relation.relowner) as owner,
              pg_catalog.has_table_privilege($2, relation.oid, 'select') as can_select,
              pg_catalog.has_table_privilege($2, relation.oid, 'insert') as can_insert,
              pg_catalog.has_table_privilege($2, relation.oid, 'update') as can_update,
              pg_catalog.has_table_privilege($2, relation.oid, 'delete') as can_delete,
              pg_catalog.has_table_privilege($2, relation.oid, 'truncate') as can_truncate,
              pg_catalog.has_table_privilege($2, relation.oid, 'references') as can_references,
              pg_catalog.has_table_privilege($2, relation.oid, 'trigger') as can_trigger
         from pg_catalog.pg_class relation
         join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = any($1::text[])
          and relation.relkind in ('r', 'p', 'v', 'm', 'f')
        order by relation`,
      [PROVIDER_SCHEMAS, role]
    );
    tablesByRole.set(role, tables.rows);
  }

  const expectedTables = new Set<string>(NOVA_PROVIDER_TABLES);
  const readOnlyTables = new Set<string>(NOVA_RUNTIME_READ_ONLY_TABLES);
  const noDeleteTables = new Set<string>(NOVA_RUNTIME_NO_DELETE_TABLES);
  for (const [role, tables] of tablesByRole) {
    if (tables.length !== expectedTables.size || tables.some(({ relation }) => !expectedTables.has(relation))) {
      issues.push(`${role} sees an unexpected provider relation inventory`);
    }
    const ownedSchema = ROLE_SCHEMA.get(role);
    for (const table of tables) {
      if (table.owner !== NOVA_MIGRATOR_ROLE) issues.push(`${table.relation} has a foreign owner`);
      const ownsRuntimeSchema = table.schema_name === ownedSchema;
      for (const privilege of TABLE_PRIVILEGES) {
        const expected =
          ownsRuntimeSchema &&
          (privilege === "select" ||
            (!readOnlyTables.has(table.relation) &&
              ["insert", "update", "delete"].includes(privilege) &&
              !(privilege === "delete" && noDeleteTables.has(table.relation))));
        if (table[`can_${privilege}`] !== expected) {
          issues.push(`${role} ${table.relation} ${privilege} privilege drifted`);
        }
      }
    }
  }

  const extraObjects = await client.query<{ object_count: string }>(
    `select count(*)::text as object_count
       from pg_catalog.pg_class relation
       join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = any($1::text[]) and relation.relkind in ('S', 'c')`,
    [PROVIDER_SCHEMAS]
  );
  if (extraObjects.rows[0]?.object_count !== "0")
    issues.push("provider schemas contain unmanaged sequences or composite types");

  const routines = await client.query<{ routine: string; owner: string; security_definer: boolean }>(
    `select namespace.nspname || '.' || routine.proname as routine,
            pg_catalog.pg_get_userbyid(routine.proowner) as owner,
            routine.prosecdef as security_definer
       from pg_catalog.pg_proc routine
       join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
      where namespace.nspname = any($1::text[])
      order by routine`,
    [PROVIDER_SCHEMAS]
  );
  if (
    routines.rows.length !== NOVA_PROVIDER_ROUTINES.length ||
    routines.rows.some(
      (row, index) =>
        row.routine !== NOVA_PROVIDER_ROUTINES[index] || row.owner !== NOVA_MIGRATOR_ROLE || row.security_definer
    )
  ) {
    issues.push("provider routine inventory or ownership drifted");
  }

  const databasePrivileges = await client.query<{
    can_connect: boolean;
    can_create: boolean;
    can_temporary: boolean;
    role_name: NovaCellDatabaseRole;
  }>(
    `select runtime_role.rolname as role_name,
            pg_catalog.has_database_privilege(runtime_role.rolname, current_database(), 'connect') as can_connect,
            pg_catalog.has_database_privilege(runtime_role.rolname, current_database(), 'create') as can_create,
            pg_catalog.has_database_privilege(runtime_role.rolname, current_database(), 'temporary') as can_temporary
       from pg_catalog.pg_roles runtime_role
      where runtime_role.rolname = any($1::text[])
      order by role_name`,
    [NOVA_CELL_DATABASE_ROLES.map(({ role }) => role)]
  );
  if (
    databasePrivileges.rows.length !== NOVA_CELL_DATABASE_ROLES.length ||
    databasePrivileges.rows.some((row) => !row.can_connect || row.can_create || row.can_temporary)
  ) {
    issues.push("runtime database privileges are not connect-only");
  }

  if (issues.length > 0) throw new Error(`NOVA runtime database boundary invalid: ${issues.join("; ")}`);
}
