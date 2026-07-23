import { ACCESS_MIGRATOR_ROLE, type AccessRuntimeDatabaseRole } from "./role-manifest.js";

export const ACCESS_IDENTITY_RUNTIME_ROLE = "hyperion_identity" as const;
export const ACCESS_TENANT_RUNTIME_ROLE = "hyperion_tenant" as const;

const TABLE_PRIVILEGES = ["select", "insert", "update", "delete", "truncate", "references", "trigger"] as const;
type TablePrivilege = (typeof TABLE_PRIVILEGES)[number];

const IDENTITY_TABLE_PRIVILEGES = new Map<string, ReadonlySet<TablePrivilege>>([
  ["access_runtime.bootstrap_tenants", new Set(["select"])],
  ["access_runtime.lumen_projection_outbox", new Set(["select", "insert", "update"])],
  ["access_runtime.lumen_projection_state", new Set(["select", "insert", "update"])],
  ["access_runtime.migration_ledger", new Set(["select"])],
  ["access_runtime.product_grants", new Set(["select", "insert", "update", "delete"])],
  ["access_runtime.tenant_projection_outbox", new Set(["select", "insert", "update"])],
  ["access_runtime.tenant_projection_state", new Set(["select", "insert", "update"])],
  ["platform.access_token_denylist", new Set(["select", "insert", "delete"])],
  ["platform.operator_sessions", new Set(["select", "insert", "update"])],
  ["platform.operator_tenants", new Set(["select", "insert", "delete"])],
  ["platform.operators", new Set(["select", "insert", "update"])],
  ["platform.tenants", new Set(["select"])]
]);

const TENANT_TABLE_PRIVILEGES = new Map<string, ReadonlySet<TablePrivilege>>([
  ["access_runtime.bootstrap_tenants", new Set()],
  ["access_runtime.lumen_projection_outbox", new Set()],
  ["access_runtime.lumen_projection_state", new Set()],
  ["access_runtime.migration_ledger", new Set(["select"])],
  ["access_runtime.product_grants", new Set()],
  ["access_runtime.tenant_projection_outbox", new Set()],
  ["access_runtime.tenant_projection_state", new Set()],
  ["platform.access_token_denylist", new Set()],
  ["platform.operator_sessions", new Set()],
  ["platform.operator_tenants", new Set()],
  ["platform.operators", new Set()],
  ["platform.tenants", new Set(["select"])]
]);

const ROUTINE_EXECUTE_ROLES = new Map<string, ReadonlySet<AccessRuntimeDatabaseRole>>([
  ["access_runtime.enforce_tenant_lifecycle_v1()", new Set()],
  ["access_runtime.valid_grant_values(text[],text)", new Set([ACCESS_IDENTITY_RUNTIME_ROLE])]
]);
const ROUTINE_CONFIGURATIONS = new Map<string, readonly string[]>([
  ["access_runtime.enforce_tenant_lifecycle_v1()", ["search_path=pg_catalog"]],
  ["access_runtime.valid_grant_values(text[],text)", []]
]);

export interface AccessBoundaryClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

interface DatabaseBoundaryRow {
  can_connect: boolean;
  can_create: boolean;
  can_temporary: boolean;
  database_owner: string;
  runtime_role: string;
  session_role: string;
}

interface SchemaBoundaryRow {
  can_create: boolean;
  can_use: boolean;
  owner: string;
  schema_name: string;
}

type TableBoundaryRow = {
  [privilege in `can_${TablePrivilege}`]: boolean;
} & {
  owner: string;
  relation: string;
};

interface RoutineBoundaryRow {
  can_execute: boolean | null;
  configuration: string[] | null;
  owner: string | null;
  signature: string;
}

export async function assertAccessRuntimeDatabaseBoundary(
  client: AccessBoundaryClient,
  expectedRole: AccessRuntimeDatabaseRole,
  options: { requireCurrentRole?: boolean } = {}
): Promise<void> {
  const hardenedSession = await client.query<{ search_path: string }>(
    "select pg_catalog.set_config('search_path', 'pg_catalog', false) as search_path"
  );
  if (hardenedSession.rows[0]?.search_path !== "pg_catalog") {
    throw new Error("Access runtime database boundary could not pin search_path");
  }
  const expectedPrivileges =
    expectedRole === ACCESS_IDENTITY_RUNTIME_ROLE ? IDENTITY_TABLE_PRIVILEGES : TENANT_TABLE_PRIVILEGES;
  const issues: string[] = [];

  const database = await client.query<DatabaseBoundaryRow>(
    `
    select current_user as runtime_role,
           session_user as session_role,
           pg_get_userbyid(database_catalog.datdba) as database_owner,
           has_database_privilege($1, current_database(), 'connect') as can_connect,
           has_database_privilege($1, current_database(), 'create') as can_create,
           has_database_privilege($1, current_database(), 'temporary') as can_temporary
      from pg_database database_catalog
     where database_catalog.datname = current_database()
  `,
    [expectedRole]
  );
  const databaseRow = database.rows[0];
  if (!databaseRow) issues.push("database identity is missing");
  else {
    if (databaseRow.runtime_role !== databaseRow.session_role) issues.push("session uses SET ROLE");
    if (options.requireCurrentRole !== false && databaseRow.runtime_role !== expectedRole) {
      issues.push(`connected as ${databaseRow.runtime_role}`);
    }
    if (databaseRow.database_owner !== ACCESS_MIGRATOR_ROLE) issues.push("database has a foreign owner");
    if (!databaseRow.can_connect || databaseRow.can_create || databaseRow.can_temporary) {
      issues.push("database privileges are not runtime-only");
    }
  }

  const schemas = await client.query<SchemaBoundaryRow>(
    `select namespace.nspname as schema_name,
            pg_get_userbyid(namespace.nspowner) as owner,
            has_schema_privilege($2, namespace.oid, 'usage') as can_use,
            has_schema_privilege($2, namespace.oid, 'create') as can_create
       from pg_namespace namespace
      where namespace.nspname = any($1::text[])
      order by schema_name`,
    [["access_runtime", "platform"], expectedRole]
  );
  if (schemas.rows.length !== 2) issues.push("provider schemas are incomplete");
  for (const schema of schemas.rows) {
    if (schema.owner !== ACCESS_MIGRATOR_ROLE) issues.push(`${schema.schema_name} has a foreign owner`);
    if (!schema.can_use || schema.can_create) issues.push(`${schema.schema_name} schema privileges drifted`);
  }

  const tables = await client.query<TableBoundaryRow>(
    `select namespace.nspname || '.' || relation.relname as relation,
            pg_get_userbyid(relation.relowner) as owner,
            has_table_privilege($2, relation.oid, 'select') as can_select,
            has_table_privilege($2, relation.oid, 'insert') as can_insert,
            has_table_privilege($2, relation.oid, 'update') as can_update,
            has_table_privilege($2, relation.oid, 'delete') as can_delete,
            has_table_privilege($2, relation.oid, 'truncate') as can_truncate,
            has_table_privilege($2, relation.oid, 'references') as can_references,
            has_table_privilege($2, relation.oid, 'trigger') as can_trigger
       from pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = any($1::text[])
        and relation.relkind = 'r'
      order by relation`,
    [["access_runtime", "platform"], expectedRole]
  );
  const observedRelations = new Set(tables.rows.map(({ relation }) => relation));
  for (const relation of expectedPrivileges.keys()) {
    if (!observedRelations.has(relation)) issues.push(`${relation} is missing`);
  }
  for (const table of tables.rows) {
    const allowed = expectedPrivileges.get(table.relation);
    if (!allowed) {
      issues.push(`${table.relation} is outside the runtime manifest`);
      continue;
    }
    if (table.owner !== ACCESS_MIGRATOR_ROLE) issues.push(`${table.relation} has a foreign owner`);
    for (const privilege of TABLE_PRIVILEGES) {
      if (table[`can_${privilege}`] !== allowed.has(privilege)) {
        issues.push(`${table.relation} ${privilege} privilege drifted`);
      }
    }
  }

  const routines = await client.query<RoutineBoundaryRow>(
    `
    select expected.signature,
           pg_get_userbyid(routine_catalog.proowner) as owner,
           routine_catalog.proconfig as configuration,
           case when routine_catalog.oid is null then null
                else has_function_privilege($2, routine_catalog.oid, 'execute')
            end as can_execute
      from unnest($1::text[]) expected(signature)
      left join pg_proc routine_catalog
        on routine_catalog.oid = to_regprocedure(expected.signature)
     order by expected.signature
  `,
    [[...ROUTINE_EXECUTE_ROLES.keys()], expectedRole]
  );
  for (const routine of routines.rows) {
    const allowedRoles = ROUTINE_EXECUTE_ROLES.get(routine.signature);
    if (!allowedRoles) {
      issues.push(`${routine.signature} is outside the runtime routine manifest`);
      continue;
    }
    if (!routine.owner) {
      issues.push(`${routine.signature} is missing`);
      continue;
    }
    if (routine.owner !== ACCESS_MIGRATOR_ROLE) issues.push(`${routine.signature} has a foreign owner`);
    const expectedConfiguration = ROUTINE_CONFIGURATIONS.get(routine.signature) ?? [];
    if (JSON.stringify(routine.configuration ?? []) !== JSON.stringify(expectedConfiguration)) {
      issues.push(`${routine.signature} configuration drifted`);
    }
    if (routine.can_execute !== allowedRoles.has(expectedRole)) {
      issues.push(`${routine.signature} execute privilege drifted`);
    }
  }
  if (routines.rows.length !== ROUTINE_EXECUTE_ROLES.size) issues.push("provider routines are incomplete");

  const publicSchema = await client.query<{ can_create: boolean }>(
    "select has_schema_privilege($1, 'public', 'create') as can_create",
    [expectedRole]
  );
  if (publicSchema.rows[0]?.can_create !== false) issues.push("public schema CREATE is not fenced");

  if (issues.length > 0) {
    throw new Error(`Access runtime database boundary invalid: ${issues.join("; ")}`);
  }
}
