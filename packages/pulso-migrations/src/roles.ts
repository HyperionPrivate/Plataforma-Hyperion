import pg from "pg";
import {
  PULSO_MIGRATOR_ROLE,
  PULSO_RUNTIME_ROLE_DEFINITIONS,
  type PulsoRuntimePasswords,
  type PulsoRuntimeRole
} from "./config.js";
import { assertPulsoRuntimeDatabaseSecurity, PULSO_RUNTIME_SCHEMA_REQUIREMENTS } from "./schema-manifest.js";

const { Client } = pg;
const ROLE_LOCK = "pulso:database-role-bootstrap";

export interface PulsoRoleBootstrapClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export async function bootstrapPulsoDatabaseRoles(
  adminUrl: string,
  databaseName: string,
  passwords: PulsoRuntimePasswords
): Promise<void> {
  const targetUrl = new URL(adminUrl);
  targetUrl.pathname = `/${databaseName}`;
  targetUrl.search = "";
  targetUrl.hash = "";
  const client = new Client({ connectionString: targetUrl.toString() });
  await client.connect();
  try {
    await applyPulsoRolePasswords(client, databaseName, passwords);
  } finally {
    await client.end();
  }
}

export async function applyPulsoRolePasswords(
  client: PulsoRoleBootstrapClient,
  databaseName: string,
  passwords: PulsoRuntimePasswords
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe PULSO database name");
  for (const definition of PULSO_RUNTIME_ROLE_DEFINITIONS) {
    if (!passwords.get(definition.role)) throw new Error(`Missing password for ${definition.role}`);
  }

  await client.query("select pg_advisory_lock(hashtext($1))", [ROLE_LOCK]);
  try {
    // Commit the safety fence first. Any later validation/rotation failure
    // leaves every workload unable to establish a new database session.
    await client.query("begin");
    try {
      for (const definition of PULSO_RUNTIME_ROLE_DEFINITIONS) {
        await client.query(`alter role ${quoteIdentifier(definition.role)} with nologin`);
      }
      await client.query("commit");
    } catch (error) {
      await rollbackPreservingOriginalError(client);
      throw error;
    }

    await client.query("begin");
    try {
      await assertRolePrerequisites(client, databaseName);
      for (const definition of PULSO_RUNTIME_ROLE_DEFINITIONS) {
        await activateRole(client, definition.role, passwords.get(definition.role)!);
      }
      for (const definition of PULSO_RUNTIME_ROLE_DEFINITIONS) {
        await setLocalRole(client, definition.role);
        try {
          await assertPulsoRuntimeDatabaseSecurity(client);
        } finally {
          await client.query("reset role");
        }
      }
      await client.query("commit");
    } catch (error) {
      await rollbackPreservingOriginalError(client);
      throw error;
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [ROLE_LOCK]);
  }
}

async function assertRolePrerequisites(client: PulsoRoleBootstrapClient, databaseName: string): Promise<void> {
  const database = await client.query<{ owner: string }>(
    "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
    [databaseName]
  );
  if (database.rows.length !== 1 || database.rows[0]?.owner !== PULSO_MIGRATOR_ROLE) {
    throw new Error(`PULSO role bootstrap requires ${databaseName} to be owned by ${PULSO_MIGRATOR_ROLE}`);
  }

  const expectedRoles = [PULSO_MIGRATOR_ROLE, ...PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition) => definition.role)];
  const expected = new Set<string>(expectedRoles);
  const roles = await client.query<{
    has_memberships: boolean;
    owns_out_of_scope_objects: boolean;
    rolname: string;
    unsafe_capabilities: boolean;
  }>(
    `select role.rolname,
            (role.rolsuper or role.rolcreatedb or role.rolcreaterole or role.rolinherit
              or role.rolreplication or role.rolbypassrls) as unsafe_capabilities,
            exists (
              select 1 from pg_auth_members membership
               where membership.member = role.oid or membership.roleid = role.oid
            ) as has_memberships,
            exists (
              select 1 from pg_database owned_database
               where owned_database.datdba = role.oid
                 and (role.rolname <> $3 or owned_database.datname <> $2)
            ) or exists (
              select 1 from pg_shdepend dependency
               where dependency.refclassid = 'pg_authid'::regclass
                 and dependency.refobjid = role.oid
                 and dependency.deptype = 'o'
                 and role.rolname <> $3
            ) as owns_out_of_scope_objects
       from pg_roles role
      where role.rolname = any($1::text[])
      order by role.rolname`,
    [expectedRoles, databaseName, PULSO_MIGRATOR_ROLE]
  );
  if (roles.rows.length !== expected.size || roles.rows.some((role) => !expected.has(role.rolname))) {
    throw new Error("PULSO role bootstrap requires the complete provider-owned role set");
  }
  if (roles.rows.some((role) => role.unsafe_capabilities || role.has_memberships || role.owns_out_of_scope_objects)) {
    throw new Error("PULSO role bootstrap refused an unsafe role privilege matrix");
  }

  const activeSessions = await client.query<{ count: number }>(
    `select count(*)::int as count
       from pg_stat_activity
      where usename = any($1::text[])
        and pid <> pg_backend_pid()
        and backend_type = 'client backend'`,
    [PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition) => definition.role)]
  );
  if ((activeSessions.rows[0]?.count ?? 0) !== 0) {
    throw new Error("PULSO role bootstrap requires all runtime sessions to be drained");
  }

  await assertReadinessMarker(
    client,
    "PULSO",
    `select current_version::int, migration_name
       from pulso_iris.schema_version
      where service_name = $1`,
    PULSO_RUNTIME_SCHEMA_REQUIREMENTS.pulso
  );
  await assertReadinessMarker(
    client,
    "SOFIA",
    `select current_version::int, migration_name
       from agent_runtime.schema_version
      where service_name = $1`,
    PULSO_RUNTIME_SCHEMA_REQUIREMENTS.sofia
  );
}

async function assertReadinessMarker(
  client: PulsoRoleBootstrapClient,
  owner: string,
  sql: string,
  requirement: {
    serviceName: string;
    minimumVersion: number;
    migrationName: string;
  }
): Promise<void> {
  const version = await client.query<{ current_version: number; migration_name: string }>(sql, [
    requirement.serviceName
  ]);
  if (
    version.rows.length !== 1 ||
    version.rows[0]?.current_version !== requirement.minimumVersion ||
    version.rows[0]?.migration_name !== requirement.migrationName
  ) {
    throw new Error(`${owner} role bootstrap requires its terminal provider-owned schema version`);
  }
}

async function activateRole(client: PulsoRoleBootstrapClient, role: PulsoRuntimeRole, password: string): Promise<void> {
  const rendered = await client.query<{ statement: string }>(
    "select format('alter role %I with login password %L', $1::text, $2::text) as statement",
    [role, password]
  );
  const statement = rendered.rows[0]?.statement;
  if (!statement) throw new Error(`Could not prepare password rotation for ${role}`);
  try {
    await client.query(statement);
  } catch {
    throw new Error(`Could not create or rotate PULSO runtime role ${role}`);
  }
}

async function setLocalRole(client: PulsoRoleBootstrapClient, role: PulsoRuntimeRole): Promise<void> {
  const rendered = await client.query<{ statement: string }>(
    "select format('set local role %I', $1::text) as statement",
    [role]
  );
  const statement = rendered.rows[0]?.statement;
  if (!statement) throw new Error(`Could not prepare PULSO ACL validation for ${role}`);
  await client.query(statement);
}

async function rollbackPreservingOriginalError(client: PulsoRoleBootstrapClient): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // Closing the session releases transaction state; preserve the first error.
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
