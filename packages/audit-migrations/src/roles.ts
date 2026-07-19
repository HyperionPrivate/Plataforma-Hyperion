import pg from "pg";
import { AUDIT_MIGRATOR_ROLE, AUDIT_RUNTIME_ROLE } from "./config.js";
import { AUDIT_BASELINE_MIGRATION } from "./schema-manifest.js";

const { Client } = pg;
const ROLE_LOCK = "audit:database-role-bootstrap";

export interface AuditRoleBootstrapClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export async function bootstrapAuditDatabaseRole(
  adminUrl: string,
  databaseName: string,
  password: string
): Promise<void> {
  const targetUrl = new URL(adminUrl);
  targetUrl.pathname = `/${databaseName}`;
  targetUrl.search = "";
  targetUrl.hash = "";
  const client = new Client({ connectionString: targetUrl.toString() });
  await client.connect();
  try {
    await applyAuditRolePassword(client, databaseName, password);
  } finally {
    await client.end();
  }
}

export async function applyAuditRolePassword(
  client: AuditRoleBootstrapClient,
  databaseName: string,
  password: string
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe Audit database name");
  await client.query("select pg_advisory_lock(hashtext($1))", [ROLE_LOCK]);
  try {
    await client.query("begin");
    try {
      await client.query(`alter role ${quoteIdentifier(AUDIT_RUNTIME_ROLE)} with nologin`);
      await client.query("commit");
    } catch (error) {
      await rollbackPreservingOriginalError(client);
      throw error;
    }

    await client.query("begin");
    try {
      await assertAuditRolePrerequisites(client, databaseName);
      const formatted = await client.query<{ statement: string }>(
        "select format('alter role %I with login password %L', $1::text, $2::text) as statement",
        [AUDIT_RUNTIME_ROLE, password]
      );
      const statement = formatted.rows[0]?.statement;
      if (!statement) throw new Error("Could not prepare Audit password rotation");
      await client.query(statement);
      await client.query("commit");
    } catch (error) {
      await rollbackPreservingOriginalError(client);
      throw error;
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [ROLE_LOCK]);
  }
}

async function assertAuditRolePrerequisites(client: AuditRoleBootstrapClient, databaseName: string): Promise<void> {
  const database = await client.query<{ owner: string }>(
    "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
    [databaseName]
  );
  if (database.rows.length !== 1 || database.rows[0]?.owner !== AUDIT_MIGRATOR_ROLE) {
    throw new Error(`Audit role bootstrap requires ${databaseName} to be owned by ${AUDIT_MIGRATOR_ROLE}`);
  }

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
    [[AUDIT_MIGRATOR_ROLE, AUDIT_RUNTIME_ROLE], databaseName, AUDIT_MIGRATOR_ROLE]
  );
  const expected = new Set<string>([AUDIT_MIGRATOR_ROLE, AUDIT_RUNTIME_ROLE]);
  if (roles.rows.length !== expected.size || roles.rows.some((role) => !expected.has(role.rolname))) {
    throw new Error("Audit role bootstrap requires the complete provider-owned role set");
  }
  if (roles.rows.some((role) => role.unsafe_capabilities || role.has_memberships || role.owns_out_of_scope_objects)) {
    throw new Error("Audit role bootstrap refused an unsafe role privilege matrix");
  }

  const sessions = await client.query<{ count: number }>(
    `select count(*)::int as count from pg_stat_activity
      where usename = $1 and pid <> pg_backend_pid() and backend_type = 'client backend'`,
    [AUDIT_RUNTIME_ROLE]
  );
  if ((sessions.rows[0]?.count ?? 0) !== 0) {
    throw new Error("Audit role bootstrap requires all runtime sessions to be drained");
  }

  const ledger = await client.query<{ name: string }>("select name from audit_runtime.migration_ledger order by name");
  if (ledger.rows.length !== 1 || ledger.rows[0]?.name !== AUDIT_BASELINE_MIGRATION) {
    throw new Error("Audit role bootstrap requires the terminal provider-owned migration ledger");
  }

  const acl = await client.query<{
    can_connect: boolean;
    can_create: boolean;
    can_temporary: boolean;
    can_use_platform: boolean;
    can_use_runtime: boolean;
    can_read_audit: boolean;
    can_insert_audit: boolean;
    can_mutate_audit: boolean;
    can_read_inbox: boolean;
    can_insert_inbox: boolean;
    can_mutate_inbox: boolean;
    can_read_ledger: boolean;
    can_write_ledger: boolean;
  }>(
    `select has_database_privilege($1, current_database(), 'CONNECT') as can_connect,
            has_database_privilege($1, current_database(), 'CREATE') as can_create,
            has_database_privilege($1, current_database(), 'TEMPORARY') as can_temporary,
            has_schema_privilege($1, 'platform', 'USAGE') as can_use_platform,
            has_schema_privilege($1, 'audit_runtime', 'USAGE') as can_use_runtime,
            has_table_privilege($1, 'platform.audit_events', 'SELECT') as can_read_audit,
            has_table_privilege($1, 'platform.audit_events', 'INSERT') as can_insert_audit,
            (has_table_privilege($1, 'platform.audit_events', 'UPDATE')
              or has_table_privilege($1, 'platform.audit_events', 'DELETE')) as can_mutate_audit,
            has_table_privilege($1, 'audit_runtime.inbox_events', 'SELECT') as can_read_inbox,
            has_table_privilege($1, 'audit_runtime.inbox_events', 'INSERT') as can_insert_inbox,
            (has_table_privilege($1, 'audit_runtime.inbox_events', 'UPDATE')
              or has_table_privilege($1, 'audit_runtime.inbox_events', 'DELETE')) as can_mutate_inbox,
            has_table_privilege($1, 'audit_runtime.migration_ledger', 'SELECT') as can_read_ledger,
            has_table_privilege($1, 'audit_runtime.migration_ledger', 'INSERT') as can_write_ledger`,
    [AUDIT_RUNTIME_ROLE]
  );
  const privileges = acl.rows[0];
  if (
    !privileges?.can_connect ||
    privileges.can_create ||
    privileges.can_temporary ||
    !privileges.can_use_platform ||
    !privileges.can_use_runtime ||
    !privileges.can_read_audit ||
    !privileges.can_insert_audit ||
    privileges.can_mutate_audit ||
    !privileges.can_read_inbox ||
    !privileges.can_insert_inbox ||
    privileges.can_mutate_inbox ||
    !privileges.can_read_ledger ||
    privileges.can_write_ledger
  ) {
    throw new Error("Audit role bootstrap refused an incomplete or excessive runtime ACL");
  }
}

async function rollbackPreservingOriginalError(client: AuditRoleBootstrapClient): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // Closing the session releases transaction state; preserve the first error.
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
