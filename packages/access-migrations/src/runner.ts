import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { ACCESS_MIGRATOR_ROLE } from "./config.js";
import { assertAccessProviderSqlUsesAllowedSchemas } from "./sql-policy.js";

const { Client } = pg;
const MIGRATION_LOCK = "access:provider-migrations";

export interface AccessMigrationClient {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

export interface AccessMigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runAccessMigrations(databaseUrl: string, sqlDirectory: string): Promise<AccessMigrationResult> {
  const parsed = new URL(databaseUrl);
  const targetDatabase = decodeURIComponent(parsed.pathname.slice(1));
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await runAccessMigrationsWithClient(client, sqlDirectory, targetDatabase);
  } finally {
    await client.end();
  }
}

export async function runAccessMigrationsWithClient(
  client: AccessMigrationClient,
  sqlDirectory: string,
  targetDatabase: string
): Promise<AccessMigrationResult> {
  const hardenedSession = await client.query<{ search_path: string }>(
    "select pg_catalog.set_config('search_path', 'pg_catalog', false) as search_path"
  );
  if (hardenedSession.rows[0]?.search_path !== "pg_catalog") {
    throw new Error("Access migrator could not pin its session search_path");
  }
  const identity = await client.query<{
    current_database: string;
    current_role: string;
    database_owner: string;
    has_memberships: boolean;
    has_out_of_scope_authority: boolean;
    owns_other_database: boolean;
    session_role: string;
    unsafe_capabilities: boolean;
  }>(`
    select current_user as current_role,
           session_user as session_role,
           current_database() as current_database,
           pg_catalog.pg_get_userbyid(database_catalog.datdba) as database_owner,
           (active_role.rolsuper or active_role.rolcreatedb or active_role.rolcreaterole
             or active_role.rolinherit or active_role.rolreplication or active_role.rolbypassrls
             or active_role.rolconnlimit <> -1 or active_role.rolvaliduntil is not null
             or active_role.rolconfig is not null) as unsafe_capabilities,
           exists (
             select 1 from pg_catalog.pg_auth_members membership
              where membership.member = active_role.oid or membership.roleid = active_role.oid
           ) as has_memberships,
           exists (
             select 1 from pg_catalog.pg_database sibling
              where sibling.datdba = active_role.oid and sibling.oid <> database_catalog.oid
           ) as owns_other_database,
           exists (
             select 1 from pg_catalog.pg_shdepend dependency
              where dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
                and dependency.refobjid = active_role.oid
                and dependency.deptype in ('a', 'o')
                and not (
                  dependency.dbid = database_catalog.oid
                  or (
                    dependency.dbid = 0
                    and dependency.classid = 'pg_catalog.pg_database'::pg_catalog.regclass
                    and dependency.objid = database_catalog.oid
                  )
                )
           ) as has_out_of_scope_authority
      from pg_catalog.pg_database database_catalog
      join pg_catalog.pg_roles active_role on active_role.rolname = current_user
     where database_catalog.datname = current_database()
  `);
  const connected = identity.rows[0];
  if (
    !connected ||
    connected.current_role !== ACCESS_MIGRATOR_ROLE ||
    connected.session_role !== ACCESS_MIGRATOR_ROLE ||
    connected.current_database !== targetDatabase ||
    connected.database_owner !== ACCESS_MIGRATOR_ROLE ||
    connected.unsafe_capabilities ||
    connected.has_memberships ||
    connected.owns_other_database ||
    connected.has_out_of_scope_authority
  ) {
    throw new Error("Access migrator session identity, ownership or authority closure is invalid");
  }
  await client.query("select pg_catalog.set_config('statement_timeout', '30s', false)");
  await client.query("select pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK]);
  await client.query("select set_config('statement_timeout', '0', false)");
  try {
    await client.query("create schema if not exists access_runtime");
    await client.query(`
      create table if not exists access_runtime.migration_ledger (
        name text primary key,
        checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
        applied_at timestamptz not null default now()
      )
    `);
    const files = (await readdir(sqlDirectory)).filter((file) => file.endsWith(".sql")).sort();
    const existing = await client.query<{ name: string; checksum: string }>(
      "select name, checksum from access_runtime.migration_ledger"
    );
    const providerFiles = new Set(files);
    const unexpected = existing.rows.map(({ name }) => name).filter((name) => !providerFiles.has(name));
    if (unexpected.length > 0) {
      throw new Error(`Access migration ledger contains mixed or foreign rows: ${unexpected.sort().join(", ")}`);
    }
    const appliedChecksums = new Map(existing.rows.map((row) => [row.name, row.checksum]));
    const result: AccessMigrationResult = { applied: [], skipped: [] };

    for (const file of files) {
      const sql = await readFile(path.join(sqlDirectory, file), "utf8");
      assertAccessProviderSqlUsesAllowedSchemas(file, sql);
      const checksum = computeAccessMigrationChecksum(sql);
      const previous = appliedChecksums.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`Access migration ${file} checksum mismatch`);
        result.skipped.push(file);
        continue;
      }

      await client.query("begin");
      try {
        await client.query("select set_config('lock_timeout', '10s', true)");
        await client.query("select set_config('statement_timeout', '300s', true)");
        await client.query(sql);
        await client.query("insert into access_runtime.migration_ledger(name, checksum) values ($1, $2)", [
          file,
          checksum
        ]);
        await client.query("commit");
        result.applied.push(file);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
    return result;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]);
  }
}

export function computeAccessMigrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
}
