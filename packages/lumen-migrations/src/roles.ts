import pg from "pg";
import { LUMEN_MIGRATOR_ROLE, LUMEN_RUNTIME_ROLE } from "./config.js";

const { Client } = pg;
const ROLE_LOCK = "lumen:database-role-bootstrap";

export interface LumenRoleBootstrapClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export async function bootstrapLumenDatabaseRole(
  adminUrl: string,
  databaseName: string,
  password: string
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await applyLumenRolePassword(client, databaseName, password);
  } finally {
    await client.end();
  }
}

export async function applyLumenRolePassword(
  client: LumenRoleBootstrapClient,
  databaseName: string,
  password: string
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe LUMEN database name");
  await client.query("select pg_advisory_lock(hashtext($1))", [ROLE_LOCK]);
  try {
    await client.query("begin");
    try {
      const database = await client.query<{ owner: string }>(
        "select pg_get_userbyid(datdba) as owner from pg_database where datname = $1",
        [databaseName]
      );
      if (database.rows.length !== 1 || database.rows[0]?.owner !== LUMEN_MIGRATOR_ROLE) {
        throw new Error(`LUMEN role bootstrap requires ${databaseName} to be owned by ${LUMEN_MIGRATOR_ROLE}`);
      }

      const result = await client.query<{
        rolname: string;
        unsafe_capabilities: boolean;
        has_memberships: boolean;
        owns_out_of_scope_objects: boolean;
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
        [[LUMEN_MIGRATOR_ROLE, LUMEN_RUNTIME_ROLE], databaseName, LUMEN_MIGRATOR_ROLE]
      );
      const expectedRoles = new Set<string>([LUMEN_MIGRATOR_ROLE, LUMEN_RUNTIME_ROLE]);
      if (result.rows.length !== expectedRoles.size || result.rows.some((role) => !expectedRoles.has(role.rolname))) {
        throw new Error("LUMEN role bootstrap requires the migrated LUMEN roles");
      }
      if (
        result.rows.some((role) => role.unsafe_capabilities || role.has_memberships || role.owns_out_of_scope_objects)
      ) {
        throw new Error("LUMEN role bootstrap refused an unsafe role privilege matrix");
      }

      await client.query(`alter role ${quoteIdentifier(LUMEN_RUNTIME_ROLE)} with nologin`);
      const formatted = await client.query<{ statement: string }>(
        "select format('alter role %I with login password %L', $1::text, $2::text) as statement",
        [LUMEN_RUNTIME_ROLE, password]
      );
      const statement = formatted.rows[0]?.statement;
      if (!statement) throw new Error("Could not prepare LUMEN password rotation");
      await client.query(statement);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [ROLE_LOCK]);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
