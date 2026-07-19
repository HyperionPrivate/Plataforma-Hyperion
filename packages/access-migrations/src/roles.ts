import pg from "pg";
import {
  ACCESS_MIGRATOR_ROLE,
  ACCESS_RUNTIME_DATABASE_ROLES,
  type AccessRolePasswords,
  type AccessRuntimeDatabaseRole
} from "./config.js";
import { assertAccessRuntimeDatabaseBoundary } from "./runtime-boundary.js";
import { ACCESS_FRESH_PROVIDER_LEDGER } from "./schema-manifest.js";

const { Client } = pg;
const ROLE_BOOTSTRAP_LOCK = "access:database-role-bootstrap";

export interface AccessRoleBootstrapClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export async function fenceAccessRuntimeDatabaseRoles(adminUrl: string): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await fenceAccessRuntimeRolesWithClient(client);
  } finally {
    await client.end();
  }
}

export async function fenceAccessRuntimeRolesWithClient(client: AccessRoleBootstrapClient): Promise<void> {
  const hardenedSession = await client.query<{ search_path: string }>(
    "select pg_catalog.set_config('search_path', 'pg_catalog', false) as search_path"
  );
  if (hardenedSession.rows[0]?.search_path !== "pg_catalog") {
    throw new Error("Access runtime-role fence could not pin the administrator search_path");
  }
  await assertAdministratorSession(client);
  await client.query("select set_config('statement_timeout', '30s', false)");
  await client.query("select pg_advisory_lock(hashtext($1))", [ROLE_BOOTSTRAP_LOCK]);
  await client.query("select set_config('statement_timeout', '0', false)");
  try {
    await fenceExistingRuntimeRoles(client);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [ROLE_BOOTSTRAP_LOCK]);
  }
}

export async function bootstrapAccessDatabaseRoles(
  adminUrl: string,
  databaseName: string,
  passwords: AccessRolePasswords
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  const targetUrl = new URL(adminUrl);
  targetUrl.pathname = `/${databaseName}`;
  const targetClient = new Client({ connectionString: targetUrl.toString() });
  await client.connect();
  try {
    await fenceAccessRuntimeRolesWithClient(client);
    await targetClient.connect();
    try {
      await applyAccessRolePasswords(client, targetClient, databaseName, passwords);
    } finally {
      await targetClient.end();
    }
  } finally {
    await client.end();
  }
}

export type AccessRoleBoundaryVerifier = (
  client: AccessRoleBootstrapClient,
  role: AccessRuntimeDatabaseRole,
  options: { requireCurrentRole: false }
) => Promise<void>;

export async function applyAccessRolePasswords(
  client: AccessRoleBootstrapClient,
  targetClient: AccessRoleBootstrapClient,
  databaseName: string,
  passwords: AccessRolePasswords,
  verifyBoundary: AccessRoleBoundaryVerifier = assertAccessRuntimeDatabaseBoundary
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe Access database name");
  const hardenedAdministrator = await client.query<{ search_path: string }>(
    "select pg_catalog.set_config('search_path', 'pg_catalog', false) as search_path"
  );
  if (hardenedAdministrator.rows[0]?.search_path !== "pg_catalog") {
    throw new Error("Access role bootstrap could not pin the administrator search_path");
  }
  const administrator = await assertAdministratorSession(client);
  await client.query("select set_config('statement_timeout', '30s', false)");
  await client.query("select pg_advisory_lock(hashtext($1))", [ROLE_BOOTSTRAP_LOCK]);
  await client.query("select set_config('statement_timeout', '0', false)");
  try {
    await fenceExistingRuntimeRoles(client);
    assertPasswordMatrix(passwords);
    const hardenedTarget = await targetClient.query<{ search_path: string }>(
      "select pg_catalog.set_config('search_path', 'pg_catalog', false) as search_path"
    );
    if (hardenedTarget.rows[0]?.search_path !== "pg_catalog") {
      throw new Error("Access role bootstrap could not pin the target search_path");
    }
    await assertTargetAdministratorSession(targetClient, administrator, databaseName);
    const database = await client.query<{ owner: string }>(
      "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
      [databaseName]
    );
    if (database.rows.length !== 1 || database.rows[0]?.owner !== ACCESS_MIGRATOR_ROLE) {
      throw new Error(`Access role bootstrap requires ${databaseName} to be owned by ${ACCESS_MIGRATOR_ROLE}`);
    }

    const expectedRoles = [ACCESS_MIGRATOR_ROLE, ...ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role)];
    const result = await client.query<{
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
      [expectedRoles, databaseName, ACCESS_MIGRATOR_ROLE]
    );
    const expected = new Set<string>(expectedRoles);
    if (result.rows.length !== expected.size || result.rows.some((role) => !expected.has(role.rolname))) {
      throw new Error("Access role bootstrap requires all provider-owned Access roles");
    }
    if (
      result.rows.some(
        (role) =>
          role.unsafe_capabilities ||
          role.has_memberships ||
          role.has_out_of_scope_acl ||
          role.owns_out_of_scope_objects
      )
    ) {
      throw new Error("Access role bootstrap refused an unsafe role privilege matrix");
    }

    const ledger = await targetClient.query<{ checksum: string; name: string }>(
      "select name, checksum from access_runtime.migration_ledger order by name"
    );
    if (
      ledger.rows.length !== ACCESS_FRESH_PROVIDER_LEDGER.length ||
      ledger.rows.some(
        (row, index) =>
          row.name !== ACCESS_FRESH_PROVIDER_LEDGER[index]?.name ||
          row.checksum !== ACCESS_FRESH_PROVIDER_LEDGER[index]?.checksum
      )
    ) {
      throw new Error("Access role bootstrap requires the exact fresh provider ledger before LOGIN activation");
    }
    for (const { role } of ACCESS_RUNTIME_DATABASE_ROLES) {
      await verifyBoundary(targetClient, role, { requireCurrentRole: false });
    }

    await client.query("begin");
    try {
      for (const { role } of ACCESS_RUNTIME_DATABASE_ROLES) {
        const formatted = await client.query<{ statement: string }>(
          "select format('alter role %I with login password %L', $1::text, $2::text) as statement",
          [role, passwords.get(role)]
        );
        const statement = formatted.rows[0]?.statement;
        if (!statement) throw new Error(`Could not prepare Access password rotation for ${role}`);
        await client.query(statement);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [ROLE_BOOTSTRAP_LOCK]);
  }
}

async function fenceExistingRuntimeRoles(client: AccessRoleBootstrapClient): Promise<void> {
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
    // Autocommit is deliberate: any later owner, drift, ledger or ACL failure
    // leaves every pre-existing runtime identity unable to establish sessions.
    await client.query(`alter role ${quoteIdentifier(rolname)} with nologin`);
  }
}

async function assertAdministratorSession(client: AccessRoleBootstrapClient): Promise<string> {
  const result = await client.query<{
    can_create_role: boolean;
    current_role: string;
    is_superuser: boolean;
    session_role: string;
  }>(`
    select current_user as current_role,
           session_user as session_role,
           role.rolsuper as is_superuser,
           role.rolcreaterole as can_create_role
      from pg_roles role
     where role.rolname = current_user
  `);
  const administrator = result.rows[0];
  const providerRoles = new Set<string>([
    ACCESS_MIGRATOR_ROLE,
    ...ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role)
  ]);
  if (
    !administrator ||
    administrator.current_role !== administrator.session_role ||
    providerRoles.has(administrator.current_role) ||
    (!administrator.is_superuser && !administrator.can_create_role)
  ) {
    throw new Error("Access role bootstrap requires a separate CREATEROLE administrator session");
  }
  return administrator.current_role;
}

async function assertTargetAdministratorSession(
  client: AccessRoleBootstrapClient,
  administratorRole: string,
  databaseName: string
): Promise<void> {
  const result = await client.query<{
    current_database: string;
    current_role: string;
    session_role: string;
  }>("select current_user as current_role, session_user as session_role, current_database() as current_database");
  const target = result.rows[0];
  if (
    !target ||
    target.current_role !== administratorRole ||
    target.session_role !== administratorRole ||
    target.current_database !== databaseName
  ) {
    throw new Error("Access role bootstrap target session identity or database is invalid");
  }
}

function assertPasswordMatrix(passwords: AccessRolePasswords): void {
  const expectedRoles = ACCESS_RUNTIME_DATABASE_ROLES.map(({ role }) => role);
  if (passwords.size !== expectedRoles.length || expectedRoles.some((role) => !passwords.has(role))) {
    throw new Error("Access role bootstrap requires exactly the Identity and Tenant passwords");
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
