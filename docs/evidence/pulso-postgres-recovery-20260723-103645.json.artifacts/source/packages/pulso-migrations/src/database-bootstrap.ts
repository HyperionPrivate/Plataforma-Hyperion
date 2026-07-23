import pg from "pg";
import { PULSO_MIGRATOR_ROLE, PULSO_RUNTIME_ROLE_DEFINITIONS } from "./config.js";

const { Client } = pg;
const DATABASE_BOOTSTRAP_LOCK = "pulso:logical-database-bootstrap";

export interface PulsoDatabaseBootstrapClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export async function bootstrapPulsoLogicalDatabase(
  adminUrl: string,
  databaseName: string,
  migratorPassword: string
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await applyPulsoLogicalDatabase(client, databaseName, migratorPassword);
  } finally {
    await client.end();
  }
}

export async function applyPulsoLogicalDatabase(
  client: PulsoDatabaseBootstrapClient,
  databaseName: string,
  migratorPassword: string
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe PULSO database name");
  await client.query("select pg_advisory_lock(hashtext($1))", [DATABASE_BOOTSTRAP_LOCK]);
  try {
    const database = await client.query<{ owner: string }>(
      `select pg_get_userbyid(datdba) as owner from pg_database where datname = $1`,
      [databaseName]
    );
    if (database.rows.length > 0 && database.rows[0]?.owner !== PULSO_MIGRATOR_ROLE) {
      throw new Error(`PULSO database ${databaseName} must be owned by ${PULSO_MIGRATOR_ROLE}`);
    }

    const existingRoles = await inspectPreexistingRoles(client, databaseName);
    await ensureRole(client, PULSO_MIGRATOR_ROLE, existingRoles.has(PULSO_MIGRATOR_ROLE), true, migratorPassword);
    for (const definition of PULSO_RUNTIME_ROLE_DEFINITIONS) {
      await ensureRole(client, definition.role, existingRoles.has(definition.role), false);
    }

    if (database.rows.length === 0) {
      await executeFormatted(client, "select format('create database %I owner %I', $1::text, $2::text) as statement", [
        databaseName,
        PULSO_MIGRATOR_ROLE
      ]);
    }

    await executeFormatted(client, "select format('revoke all on database %I from public', $1::text) as statement", [
      databaseName
    ]);
    await executeFormatted(
      client,
      "select format('grant connect, create, temporary on database %I to %I', $1::text, $2::text) as statement",
      [databaseName, PULSO_MIGRATOR_ROLE]
    );
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [DATABASE_BOOTSTRAP_LOCK]);
  }
}

async function inspectPreexistingRoles(
  client: PulsoDatabaseBootstrapClient,
  databaseName: string
): Promise<Set<string>> {
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
    [
      [PULSO_MIGRATOR_ROLE, ...PULSO_RUNTIME_ROLE_DEFINITIONS.map((definition) => definition.role)],
      databaseName,
      PULSO_MIGRATOR_ROLE
    ]
  );

  for (const role of roles.rows) {
    if (role.unsafe_capabilities || role.has_memberships || role.owns_out_of_scope_objects) {
      throw new Error(`PULSO database bootstrap refused pre-existing authority drift for ${role.rolname}`);
    }
  }
  return new Set(roles.rows.map((role) => role.rolname));
}

async function ensureRole(
  client: PulsoDatabaseBootstrapClient,
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

async function executeFormatted(client: PulsoDatabaseBootstrapClient, sql: string, values: unknown[]): Promise<void> {
  const formatted = await client.query<{ statement: string }>(sql, values);
  const statement = formatted.rows[0]?.statement;
  if (!statement) throw new Error("Could not prepare PULSO database bootstrap statement");
  await client.query(statement);
}
