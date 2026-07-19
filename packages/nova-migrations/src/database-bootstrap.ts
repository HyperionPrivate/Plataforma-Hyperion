import pg from "pg";
import { NOVA_CELL_DATABASE_ROLES, NOVA_MIGRATOR_ROLE } from "./config.js";

const { Client } = pg;
const DATABASE_BOOTSTRAP_LOCK = "nova:logical-database-bootstrap";

export interface DatabaseBootstrapClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export async function bootstrapNovaLogicalDatabase(
  adminUrl: string,
  databaseName: string,
  migratorPassword: string
): Promise<void> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await applyNovaLogicalDatabase(client, databaseName, migratorPassword);
  } finally {
    await client.end();
  }
}

export async function applyNovaLogicalDatabase(
  client: DatabaseBootstrapClient,
  databaseName: string,
  migratorPassword: string
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error("Unsafe NOVA database name");
  await client.query("select pg_advisory_lock(hashtext($1))", [DATABASE_BOOTSTRAP_LOCK]);
  try {
    await ensureRole(client, NOVA_MIGRATOR_ROLE, true, migratorPassword);
    for (const { role } of NOVA_CELL_DATABASE_ROLES) await ensureRole(client, role, false);

    const database = await client.query<{ owner: string }>(
      `select pg_get_userbyid(datdba) as owner from pg_database where datname = $1`,
      [databaseName]
    );
    if (database.rows.length === 0) {
      await executeFormatted(client, "select format('create database %I owner %I', $1::text, $2::text) as statement", [
        databaseName,
        NOVA_MIGRATOR_ROLE
      ]);
    } else if (database.rows[0]?.owner !== NOVA_MIGRATOR_ROLE) {
      throw new Error(`NOVA database ${databaseName} must be owned by ${NOVA_MIGRATOR_ROLE}`);
    }

    await executeFormatted(client, "select format('revoke all on database %I from public', $1::text) as statement", [
      databaseName
    ]);
    await executeFormatted(
      client,
      "select format('grant connect, create, temporary on database %I to %I', $1::text, $2::text) as statement",
      [databaseName, NOVA_MIGRATOR_ROLE]
    );
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [DATABASE_BOOTSTRAP_LOCK]);
  }
}

async function ensureRole(
  client: DatabaseBootstrapClient,
  role: string,
  login: boolean,
  password?: string
): Promise<void> {
  const existing = await client.query<{ present: boolean }>(
    "select exists(select 1 from pg_roles where rolname = $1) as present",
    [role]
  );
  const action = existing.rows[0]?.present ? "alter" : "create";
  const loginClause = login ? "login password %L" : "nologin";
  const formatSql = `select format('${action} role %I with ${loginClause} nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls', $1::text${login ? ", $2::text" : ""}) as statement`;
  await executeFormatted(client, formatSql, login ? [role, password] : [role]);
}

async function executeFormatted(client: DatabaseBootstrapClient, sql: string, values: unknown[]): Promise<void> {
  const formatted = await client.query<{ statement: string }>(sql, values);
  const statement = formatted.rows[0]?.statement;
  if (!statement) throw new Error("Could not prepare NOVA database bootstrap statement");
  await client.query(statement);
}
