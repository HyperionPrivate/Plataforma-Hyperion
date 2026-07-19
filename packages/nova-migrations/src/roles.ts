import pg from "pg";
import { NOVA_CELL_DATABASE_ROLES, NOVA_MIGRATOR_ROLE, type NovaRolePasswords } from "./config.js";
import { assertNovaRuntimeDatabaseBoundary, type NovaBoundaryClient } from "./runtime-boundary.js";

const { Client } = pg;
const ROLE_LOCK = "nova:database-role-bootstrap";

export type RoleBootstrapClient = NovaBoundaryClient;

export async function fenceNovaRuntimeDatabaseRoles(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await fenceNovaRuntimeRolesWithClient(client);
  } finally {
    await client.end();
  }
}

export async function fenceNovaRuntimeRolesWithClient(client: RoleBootstrapClient): Promise<void> {
  await pinSearchPath(client, "NOVA runtime-role fence");
  await assertAdministratorSession(client);
  await client.query("select pg_catalog.set_config('statement_timeout', '30s', false)");
  await client.query("select pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", [ROLE_LOCK]);
  await client.query("select pg_catalog.set_config('statement_timeout', '0', false)");
  try {
    await fenceExistingRuntimeRoles(client);
  } finally {
    await client.query("select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", [ROLE_LOCK]);
  }
}

export async function bootstrapNovaDatabaseRoles(
  adminUrl: string,
  databaseName: string,
  passwords: NovaRolePasswords
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe NOVA database name");
  const admin = new Client({ connectionString: adminUrl });
  const targetUrl = new URL(adminUrl);
  targetUrl.pathname = `/${databaseName}`;
  const target = new Client({ connectionString: targetUrl.toString() });
  await admin.connect();
  try {
    await pinSearchPath(admin, "NOVA role bootstrap administrator");
    const administrator = await assertAdministratorSession(admin);
    await admin.query("select pg_catalog.set_config('statement_timeout', '30s', false)");
    await admin.query("select pg_catalog.pg_advisory_lock(pg_catalog.hashtext($1))", [ROLE_LOCK]);
    await admin.query("select pg_catalog.set_config('statement_timeout', '0', false)");
    try {
      await fenceExistingRuntimeRoles(admin);
      assertPasswordMatrix(passwords);
      await target.connect();
      try {
        await applyNovaRolePasswords(admin, target, databaseName, administrator, passwords);
      } finally {
        await target.end();
      }
    } finally {
      await admin.query("select pg_catalog.pg_advisory_unlock(pg_catalog.hashtext($1))", [ROLE_LOCK]);
    }
  } finally {
    await admin.end();
  }
}

export async function applyNovaRolePasswords(
  admin: RoleBootstrapClient,
  target: RoleBootstrapClient,
  databaseName: string,
  administrator: string,
  passwords: NovaRolePasswords,
  verifyBoundary: (client: NovaBoundaryClient) => Promise<void> = assertNovaRuntimeDatabaseBoundary
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe NOVA database name");
  assertPasswordMatrix(passwords);
  await pinSearchPath(admin, "NOVA role bootstrap administrator");
  await pinSearchPath(target, "NOVA role bootstrap target");
  await assertTargetAdministratorSession(target, administrator, databaseName);

  const database = await admin.query<{ owner: string }>(
    "select pg_catalog.pg_get_userbyid(datdba) as owner from pg_catalog.pg_database where datname = $1",
    [databaseName]
  );
  if (database.rows.length !== 1 || database.rows[0]?.owner !== NOVA_MIGRATOR_ROLE) {
    throw new Error(`NOVA role bootstrap requires ${databaseName} to be owned by ${NOVA_MIGRATOR_ROLE}`);
  }

  const result = await admin.query<{
    has_memberships: boolean;
    has_out_of_scope_acl: boolean;
    owns_objects: boolean;
    rolname: string;
    unsafe_capabilities: boolean;
  }>(
    `select role.rolname,
            (role.rolsuper or role.rolcreatedb or role.rolcreaterole or role.rolinherit
              or role.rolreplication or role.rolbypassrls or role.rolconnlimit <> -1
              or role.rolvaliduntil is not null or role.rolconfig is not null) as unsafe_capabilities,
            exists (
              select 1 from pg_catalog.pg_auth_members membership
               where membership.member = role.oid or membership.roleid = role.oid
            ) as has_memberships,
            exists (
              select 1 from pg_catalog.pg_shdepend dependency
               where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                 and dependency.refobjid = role.oid and dependency.deptype = 'o'
            ) as owns_objects,
            exists (
              select 1 from pg_catalog.pg_shdepend dependency
              left join pg_catalog.pg_database target_database on target_database.datname = $2
               where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                 and dependency.refobjid = role.oid
                 and dependency.deptype = 'a'
                 and (
                   target_database.oid is null
                   or not (
                     dependency.dbid = target_database.oid
                     or (dependency.dbid = 0
                         and dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
                         and dependency.objid = target_database.oid)
                   )
                 )
            ) as has_out_of_scope_acl
       from pg_catalog.pg_roles role
      where role.rolname = any($1::text[])
      order by role.rolname`,
    [NOVA_CELL_DATABASE_ROLES.map(({ role }) => role), databaseName]
  );
  const expected = new Set<string>(NOVA_CELL_DATABASE_ROLES.map(({ role }) => role));
  if (result.rows.length !== expected.size || result.rows.some((row) => !expected.has(row.rolname))) {
    throw new Error("NOVA role bootstrap requires all four cell roles to be migrated first");
  }
  if (
    result.rows.some(
      (row) => row.unsafe_capabilities || row.has_memberships || row.owns_objects || row.has_out_of_scope_acl
    )
  ) {
    throw new Error("NOVA role bootstrap refused an unsafe role privilege matrix");
  }

  await verifyBoundary(target);

  await admin.query("begin");
  try {
    for (const { role } of NOVA_CELL_DATABASE_ROLES) {
      const formatted = await admin.query<{ statement: string }>(
        "select pg_catalog.format('alter role %I with login password %L', $1::text, $2::text) as statement",
        [role, passwords.get(role)]
      );
      const statement = formatted.rows[0]?.statement;
      if (!statement) throw new Error(`Could not prepare password rotation for ${role}`);
      await admin.query(statement);
    }
    await admin.query("commit");
  } catch (error) {
    await admin.query("rollback");
    throw error;
  }
}

async function fenceExistingRuntimeRoles(client: RoleBootstrapClient): Promise<void> {
  const runtimeRoles = NOVA_CELL_DATABASE_ROLES.map(({ role }) => role);
  const existing = await client.query<{ rolname: string }>(
    `select role.rolname from pg_catalog.pg_roles role
      where role.rolname = any($1::text[]) order by role.rolname`,
    [runtimeRoles]
  );
  const expected = new Set<string>(runtimeRoles);
  for (const { rolname } of existing.rows) {
    if (!expected.has(rolname)) throw new Error("NOVA role fence returned an unexpected role");
    await client.query(`alter role ${quoteIdentifier(rolname)} with nologin`);
  }
}

async function assertAdministratorSession(client: RoleBootstrapClient): Promise<string> {
  const result = await client.query<{
    can_create_role: boolean;
    current_role: string;
    is_superuser: boolean;
    session_role: string;
  }>(
    `select current_user as current_role, session_user as session_role,
            role.rolsuper as is_superuser, role.rolcreaterole as can_create_role
       from pg_catalog.pg_roles role where role.rolname = current_user`
  );
  const row = result.rows[0];
  const providerRoles = new Set<string>([NOVA_MIGRATOR_ROLE, ...NOVA_CELL_DATABASE_ROLES.map(({ role }) => role)]);
  if (
    !row ||
    row.current_role !== row.session_role ||
    providerRoles.has(row.current_role) ||
    (!row.is_superuser && !row.can_create_role)
  ) {
    throw new Error("NOVA role bootstrap requires a separate CREATEROLE administrator session");
  }
  return row.current_role;
}

async function assertTargetAdministratorSession(
  client: RoleBootstrapClient,
  administrator: string,
  databaseName: string
): Promise<void> {
  const result = await client.query<{ database: string; current_role: string; session_role: string }>(
    "select current_user as current_role, session_user as session_role, current_database() as database"
  );
  const row = result.rows[0];
  if (
    !row ||
    row.current_role !== administrator ||
    row.session_role !== administrator ||
    row.database !== databaseName
  ) {
    throw new Error("NOVA role bootstrap target session identity or database is invalid");
  }
}

async function pinSearchPath(client: RoleBootstrapClient, context: string): Promise<void> {
  const hardened = await client.query<{ search_path: string }>(
    "select pg_catalog.set_config('search_path', 'pg_catalog', false) as search_path"
  );
  if (hardened.rows[0]?.search_path !== "pg_catalog") throw new Error(`${context} could not pin search_path`);
}

function assertPasswordMatrix(passwords: NovaRolePasswords): void {
  const expected = NOVA_CELL_DATABASE_ROLES.map(({ role }) => role);
  if (passwords.size !== expected.length || expected.some((role) => !passwords.has(role))) {
    throw new Error("NOVA role bootstrap requires exactly the four NOVA cell passwords");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
