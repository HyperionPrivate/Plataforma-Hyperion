import pg from "pg";
import { ACCESS_MIGRATOR_ROLE, ACCESS_RUNTIME_DATABASE_ROLES } from "./config.js";

const { Client } = pg;
const DATABASE_BOOTSTRAP_LOCK = "access:logical-database-bootstrap";

export interface AccessDatabaseBootstrapClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export async function bootstrapAccessLogicalDatabase(
  adminUrl: string,
  databaseName: string,
  migratorPassword: string
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await applyAccessLogicalDatabase(client, databaseName, migratorPassword);
  } finally {
    await client.end();
  }
}

export async function applyAccessLogicalDatabase(
  client: AccessDatabaseBootstrapClient,
  databaseName: string,
  migratorPassword: string
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe Access database name");
  const hardenedSession = await client.query<{ search_path: string }>(
    "select pg_catalog.set_config('search_path', 'pg_catalog', false) as search_path"
  );
  if (hardenedSession.rows[0]?.search_path !== "pg_catalog") {
    throw new Error("Access database bootstrap could not pin the administrator search_path");
  }
  const administrator = await client.query<{
    can_create_database: boolean;
    can_create_role: boolean;
    current_role: string;
    is_superuser: boolean;
    session_role: string;
  }>(`
    select current_user as current_role,
           session_user as session_role,
           role.rolsuper as is_superuser,
           role.rolcreatedb as can_create_database,
           role.rolcreaterole as can_create_role
      from pg_roles role
     where role.rolname = current_user
  `);
  const admin = administrator.rows[0];
  if (
    !admin ||
    admin.current_role !== admin.session_role ||
    new Set<string>([ACCESS_MIGRATOR_ROLE, ...ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role)]).has(
      admin.current_role
    ) ||
    (!admin.is_superuser && (!admin.can_create_database || !admin.can_create_role))
  ) {
    throw new Error("Access database bootstrap requires a separate CREATEROLE and CREATEDB administrator session");
  }
  await client.query("select set_config('statement_timeout', '30s', false)");
  await client.query("select pg_advisory_lock(hashtext($1))", [DATABASE_BOOTSTRAP_LOCK]);
  await client.query("select set_config('statement_timeout', '0', false)");
  try {
    await fenceExistingRuntimeRoles(client);
    const database = await client.query<{ allow_connections: boolean; owner: string }>(
      "select pg_get_userbyid(datdba) as owner, datallowconn as allow_connections from pg_database where datname = $1",
      [databaseName]
    );
    if (database.rows.length > 0 && database.rows[0]?.owner !== ACCESS_MIGRATOR_ROLE) {
      throw new Error(`Access database ${databaseName} must be owned by ${ACCESS_MIGRATOR_ROLE}`);
    }

    const existingRoles = await inspectPreexistingRoles(client, databaseName);
    await ensureRole(client, ACCESS_MIGRATOR_ROLE, existingRoles.has(ACCESS_MIGRATOR_ROLE), true, migratorPassword);
    for (const { role } of ACCESS_RUNTIME_DATABASE_ROLES) {
      await ensureRole(client, role, existingRoles.has(role), false);
    }

    if (database.rows.length === 0) {
      await executeFormatted(
        client,
        "select format('create database %I owner %I template template0 allow_connections false', $1::text, $2::text) as statement",
        [databaseName, ACCESS_MIGRATOR_ROLE]
      );
    }
    await executeFormatted(client, "select format('revoke all on database %I from public', $1::text) as statement", [
      databaseName
    ]);
    await executeFormatted(
      client,
      "select format('grant connect, create, temporary on database %I to %I', $1::text, $2::text) as statement",
      [databaseName, ACCESS_MIGRATOR_ROLE]
    );
    await executeFormatted(client, "select format('alter database %I allow_connections true', $1::text) as statement", [
      databaseName
    ]);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [DATABASE_BOOTSTRAP_LOCK]);
  }
}

async function fenceExistingRuntimeRoles(client: AccessDatabaseBootstrapClient): Promise<void> {
  const runtimeRoles = ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role);
  const existing = await client.query<{ rolname: string }>(
    `select runtime_role.rolname
       from pg_roles runtime_role
      where runtime_role.rolname = any($1::text[])
      order by runtime_role.rolname`,
    [runtimeRoles]
  );
  const allowed = new Set<string>(runtimeRoles);
  for (const { rolname } of existing.rows) {
    if (!allowed.has(rolname)) throw new Error("Access runtime-role fence returned an unexpected role");
    await executeFormatted(client, "select format('alter role %I with nologin', $1::text) as statement", [rolname]);
  }
}

async function inspectPreexistingRoles(
  client: AccessDatabaseBootstrapClient,
  databaseName: string
): Promise<Set<string>> {
  const roleNames = [ACCESS_MIGRATOR_ROLE, ...ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role)];
  const roles = await client.query<{
    has_memberships: boolean;
    has_out_of_scope_acl: boolean;
    owns_out_of_scope_objects: boolean;
    rolname: string;
    unsafe_capabilities: boolean;
  }>(
    `select role.rolname,
            (role.rolsuper or role.rolcreatedb or role.rolcreaterole or role.rolinherit
              or role.rolreplication or role.rolbypassrls or role.rolconnlimit <> -1
              or role.rolvaliduntil is not null or role.rolconfig is not null) as unsafe_capabilities,
            exists (
              select 1 from pg_auth_members membership
               where membership.member = role.oid or membership.roleid = role.oid
            ) as has_memberships,
            exists (
              select 1
                from pg_shdepend dependency
                left join pg_database target_database on target_database.datname = $2
               where dependency.refclassid = 'pg_authid'::regclass
                 and dependency.refobjid = role.oid
                 and dependency.deptype = 'a'
                 and (
                   target_database.oid is null
                   or not (
                     dependency.dbid = target_database.oid
                     or (
                       dependency.dbid = 0
                       and dependency.classid = 'pg_database'::regclass
                       and dependency.objid = target_database.oid
                     )
                   )
                 )
            ) as has_out_of_scope_acl,
            exists (
              select 1 from pg_database owned_database
               where owned_database.datdba = role.oid
                 and (role.rolname <> $3 or owned_database.datname <> $2)
            ) or exists (
              select 1
                from pg_shdepend dependency
                left join pg_database target_database on target_database.datname = $2
               where dependency.refclassid = 'pg_authid'::regclass
                 and dependency.refobjid = role.oid
                 and dependency.deptype = 'o'
                 and (
                   role.rolname <> $3
                   or target_database.oid is null
                   or not (
                     dependency.dbid = target_database.oid
                     or (
                       dependency.dbid = 0
                       and dependency.classid = 'pg_database'::regclass
                       and dependency.objid = target_database.oid
                     )
                   )
                 )
            ) as owns_out_of_scope_objects
       from pg_roles role
      where role.rolname = any($1::text[])
      order by role.rolname`,
    [roleNames, databaseName, ACCESS_MIGRATOR_ROLE]
  );
  for (const role of roles.rows) {
    if (
      role.unsafe_capabilities ||
      role.has_memberships ||
      role.has_out_of_scope_acl ||
      role.owns_out_of_scope_objects
    ) {
      throw new Error(`Access database bootstrap refused pre-existing authority drift for ${role.rolname}`);
    }
  }
  return new Set(roles.rows.map((role) => role.rolname));
}

async function ensureRole(
  client: AccessDatabaseBootstrapClient,
  role: string,
  exists: boolean,
  login: boolean,
  password?: string
): Promise<void> {
  const action = exists ? "alter" : "create";
  const loginClause = login ? "login password %L" : "nologin";
  const capabilityClause = exists ? "" : " nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls";
  const formatSql = `select format('${action} role %I with ${loginClause}${capabilityClause}', $1::text${login ? ", $2::text" : ""}) as statement`;
  await executeFormatted(client, formatSql, login ? [role, password] : [role]);
}

async function executeFormatted(client: AccessDatabaseBootstrapClient, sql: string, values: unknown[]): Promise<void> {
  const formatted = await client.query<{ statement: string }>(sql, values);
  const statement = formatted.rows[0]?.statement;
  if (!statement) throw new Error("Could not prepare Access database bootstrap statement");
  await client.query(statement);
}
