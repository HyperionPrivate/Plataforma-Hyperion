import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertNoPlaceholderSecrets } from "@hyperion/config";
import { createLogger } from "@hyperion/logger";
import pg from "pg";
import { readMigrationExecutionOptions, type MigrationExecutionOptions } from "./runner.js";
import { SERVICE_DATABASE_ROLES, type ServiceDatabaseRole } from "./service-database-roles.js";

export { SERVICE_DATABASE_ROLES } from "./service-database-roles.js";
export type { ServiceDatabaseRole } from "./service-database-roles.js";

const { Client } = pg;

export type ServiceRolePasswords = ReadonlyMap<ServiceDatabaseRole, string>;
type BootstrapClient = InstanceType<typeof Client>;

const logger = createLogger("database-role-bootstrap");
const PASSWORD_PATTERN = /^[A-Za-z0-9._~-]+$/;
const MINIMUM_PASSWORD_LENGTH = 24;
const SERVICE_ROLE_MATRIX_MIGRATION = fileURLToPath(new URL("../sql/024-service-database-roles.sql", import.meta.url));

/**
 * Compose embeds these values in PostgreSQL URIs, so accepting only RFC 3986
 * unreserved characters avoids ambiguous parsing without duplicating secrets
 * into separate raw and percent-encoded variables.
 */
export function readServiceRolePasswords(environment: NodeJS.ProcessEnv = process.env): ServiceRolePasswords {
  assertNoPlaceholderSecrets(environment);

  const passwords = new Map<ServiceDatabaseRole, string>();
  const seen = new Set<string>();

  for (const definition of SERVICE_DATABASE_ROLES) {
    const password = environment[definition.environmentVariable]?.trim() ?? "";
    if (password.length < MINIMUM_PASSWORD_LENGTH || !PASSWORD_PATTERN.test(password)) {
      throw new Error(
        `${definition.environmentVariable} must contain at least ${MINIMUM_PASSWORD_LENGTH} RFC 3986 unreserved characters`
      );
    }
    if (seen.has(password)) {
      throw new Error("service database passwords must be distinct");
    }
    seen.add(password);
    passwords.set(definition.role, password);
  }

  return passwords;
}

export async function bootstrapDatabaseRoles(
  databaseUrl: string,
  passwords: ServiceRolePasswords,
  executionOptions: MigrationExecutionOptions = readMigrationExecutionOptions()
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await applyServiceRolePasswords(client, passwords, executionOptions);
  } finally {
    await client.end();
  }
}

/**
 * Fences every service identity as NOLOGIN and then activates or rotates all
 * passwords in one final PostgreSQL transaction. Migration 024 remains the
 * authority for the privilege matrix; activation refuses to run before it.
 */
export async function applyServiceRolePasswords(
  client: BootstrapClient,
  passwords: ServiceRolePasswords,
  executionOptions: MigrationExecutionOptions = readMigrationExecutionOptions()
): Promise<void> {
  for (const definition of SERVICE_DATABASE_ROLES) {
    if (!passwords.get(definition.role)) {
      throw new Error(`missing password for ${definition.role}`);
    }
  }

  const authority = await client.query<{
    rolcreaterole: boolean;
    rolsuper: boolean;
  }>(
    `select rolsuper, rolcreaterole
       from pg_roles
      where rolname = current_user`
  );
  if (!authority.rows[0]?.rolsuper && !authority.rows[0]?.rolcreaterole) {
    throw new Error("database role bootstrap requires a PostgreSQL role with CREATEROLE");
  }

  let bootstrapLockAcquired = false;
  try {
    // Advisory locks ignore lock_timeout. Give the session-level bootstrap
    // mutex an explicit statement budget, then retain it across both
    // transactions so no second bootstrap can interleave with the fence.
    await client.query("select set_config('statement_timeout', $1, false)", [`${executionOptions.lockTimeoutMs}ms`]);
    try {
      await client.query("select pg_advisory_lock(hashtext('hyperion:service-role-bootstrap'))");
      bootstrapLockAcquired = true;
    } finally {
      await client.query("reset statement_timeout");
    }

    // Rotation is deliberately two-phase. Fence every fixed identity that
    // currently exists before validating any drift. A missing role, unsafe
    // capability, ownership or membership must never leave the other service
    // identities able to accept new sessions after bootstrap has refused to
    // continue.
    const existingRoles = await client.query<{ rolname: ServiceDatabaseRole }>(
      `select rolname
         from pg_roles
        where rolname = any($1::text[])`,
      [SERVICE_DATABASE_ROLES.map((definition) => definition.role)]
    );
    const existingRoleNames = new Set(existingRoles.rows.map((row) => row.rolname));

    await client.query("begin");
    try {
      await configureBootstrapTimeouts(client, executionOptions);
      for (const definition of SERVICE_DATABASE_ROLES) {
        if (existingRoleNames.has(definition.role)) {
          await client.query(`alter role "${definition.role}" with nologin`);
        }
      }
      await client.query("commit");
    } catch (error) {
      await rollbackPreservingOriginalError(client);
      throw error;
    }

    // Validate immutable prerequisites only after the durable fence. Unsafe
    // capabilities, ownership or memberships are not repaired implicitly.
    await assertValidatedRoleMatrix(client, false);

    await client.query("begin");
    try {
      await configureBootstrapTimeouts(client, executionOptions);
      // Migration ledgers are one-shot. Reapply the exact, idempotent allow-list
      // inside every password transaction so privilege drift can never survive a
      // rotation or turn a successful bootstrap into a false validation.
      await applyServiceRolePrivilegeMatrix(client);
      await assertValidatedRoleMatrix(client, true);

      for (const definition of SERVICE_DATABASE_ROLES) {
        const password = passwords.get(definition.role)!;
        const rendered = await client.query<{ statement: string }>(
          `select format(
             'alter role %I with login nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls password %L valid until %L',
             $1::text,
             $2::text,
             'infinity'
           ) as statement`,
          [definition.role, password]
        );
        const statement = rendered.rows[0]?.statement;
        if (!statement) {
          throw new Error(`could not prepare role bootstrap statement for ${definition.role}`);
        }
        try {
          await client.query(statement);
        } catch {
          // Never propagate a driver diagnostic that could echo the rendered
          // PASSWORD clause. The fixed role name is sufficient for operators.
          throw new Error(`could not create or rotate service role ${definition.role}`);
        }
      }

      await client.query("commit");
    } catch (error) {
      await rollbackPreservingOriginalError(client);
      throw error;
    }
  } finally {
    if (bootstrapLockAcquired) {
      try {
        await client.query("select pg_advisory_unlock(hashtext('hyperion:service-role-bootstrap'))");
      } catch {
        // Closing the client releases a session-level lock. Preserve the
        // original bootstrap result rather than masking it during cleanup.
      }
    }
  }
}

async function configureBootstrapTimeouts(
  client: BootstrapClient,
  executionOptions: MigrationExecutionOptions
): Promise<void> {
  await client.query("select set_config('lock_timeout', $1, true)", [`${executionOptions.lockTimeoutMs}ms`]);
  await client.query("select set_config('statement_timeout', $1, true)", [`${executionOptions.statementTimeoutMs}ms`]);
}

async function rollbackPreservingOriginalError(client: BootstrapClient): Promise<void> {
  try {
    await client.query("rollback");
  } catch {
    // Preserve the original, already-sanitized failure. A broken connection
    // cannot commit an open PostgreSQL transaction.
  }
}

export async function applyServiceRolePrivilegeMatrix(client: BootstrapClient): Promise<void> {
  const matrix = await readFile(SERVICE_ROLE_MATRIX_MIGRATION, "utf8");
  // Tables introduced after immutable migration 024 are deliberately listed
  // here. Replaying 024 first revokes every managed-schema grant, so this
  // current contract must explicitly restore each later owner table. Keep the
  // replay, later grants and compatibility-window reconciliation in one query:
  // PostgreSQL executes the batch atomically both inside the bootstrap's
  // explicit transaction and when this helper is used by a focused test.
  await client.query(`select pg_advisory_xact_lock(hashtext('hyperion:service-role-bootstrap'));
    ${matrix}
    grant select, insert, update, delete
      on table channel_runtime.outbox_stream_positions,
               channel_runtime.outbox_event_positions
      to hyperion_channel;
    grant select, insert, update, delete
      on table pulso_iris.outbox_stream_positions,
               pulso_iris.outbox_event_positions
      to hyperion_pulso;
    grant select, insert, update, delete
      on table agent_runtime.pulso_stream_positions,
               agent_runtime.job_stream_positions
      to hyperion_sofia;
    grant select, insert, update, delete
      on table lumen.audio_cleanup_owner_leases
      to hyperion_lumen;

    do $nova_grants$
    begin
      if to_regnamespace('nova') is not null then
        execute 'grant usage on schema nova to hyperion_nova';
        execute 'grant select, insert, update, delete on all tables in schema nova to hyperion_nova';
        execute format('grant connect on database %I to hyperion_nova', current_database());
      end if;
      if to_regnamespace('voice') is not null then
        execute 'grant usage on schema voice to hyperion_voice';
        execute 'grant select, insert, update, delete on all tables in schema voice to hyperion_voice';
        execute format('grant connect on database %I to hyperion_voice', current_database());
      end if;
      if to_regnamespace('liwa') is not null then
        execute 'grant usage on schema liwa to hyperion_liwa';
        execute 'grant select, insert, update, delete on all tables in schema liwa to hyperion_liwa';
        execute format('grant connect on database %I to hyperion_liwa', current_database());
      end if;
      if to_regnamespace('documents') is not null then
        execute 'grant usage on schema documents to hyperion_documents';
        execute 'grant select, insert, update, delete on all tables in schema documents to hyperion_documents';
        execute format('grant connect on database %I to hyperion_documents', current_database());
      end if;
    end
    $nova_grants$;
    revoke all privileges
      on table lumen.n_minus_one_compatibility_windows,
               lumen.legacy_audio_scope_attestations
      from hyperion_lumen;
    revoke all privileges
      on function lumen.require_open_n1_compatibility_window(),
                  lumen.require_attested_legacy_cleanup_terminal()
      from hyperion_lumen;
    revoke all privileges
      on function pulso_iris.resolve_legacy_channel_inbox_position(),
                  pulso_iris.prepare_legacy_message_source_position()
      from hyperion_pulso;
    revoke all privileges
      on function agent_runtime.resolve_legacy_pulso_inbox_position()
      from hyperion_sofia;

    do $bootstrap_reconcile$
    begin
      if to_regclass('lumen.n_minus_one_compatibility_windows') is not null then
        update lumen.n_minus_one_compatibility_windows
           set closed_at = now(),
               closed_by = session_user,
               close_reason = 'bootstrap_reconciled'
         where closed_at is null;
      end if;
    end
    $bootstrap_reconcile$;
  `);
}

async function assertValidatedRoleMatrix(client: BootstrapClient, requireNoActiveSessions: boolean): Promise<void> {
  const prerequisites = await client.query<{
    allRolesPresent: boolean;
    migrationApplied: boolean;
    noMemberships: boolean;
    noOwnedObjects: boolean;
    noActiveSessions: boolean;
    safeCapabilities: boolean;
    uniformLoginState: boolean;
  }>(
    `select
       exists (
         select 1 from platform.schema_migrations
          where name = '024-service-database-roles.sql'
       ) and exists (
         select 1 from platform.schema_migrations
          where name = '020-service-role-nologin-fence.sql'
       ) and exists (
         select 1 from platform.schema_migrations
          where name = '024-service-role-membership-fence.sql'
       ) as "migrationApplied",
       (select count(*) = $2::int from pg_roles where rolname = any($1::text[])) as "allRolesPresent",
       not (
         exists (select 1 from pg_roles where rolname = any($1::text[]) and rolcanlogin)
         and exists (select 1 from pg_roles where rolname = any($1::text[]) and not rolcanlogin)
       ) as "uniformLoginState",
       not exists (
         select 1 from pg_roles
          where rolname = any($1::text[])
            and (rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolreplication or rolbypassrls)
       ) as "safeCapabilities",
       not exists (
         select 1
           from pg_auth_members membership
           join pg_roles member_role on member_role.oid = membership.member
           join pg_roles granted_role on granted_role.oid = membership.roleid
          where member_role.rolname = any($1::text[])
             or granted_role.rolname = any($1::text[])
       ) as "noMemberships",
       not exists (
         select 1
           from pg_stat_activity activity
          where activity.usename = any($1::text[])
            and activity.pid <> pg_backend_pid()
            and activity.backend_type = 'client backend'
       ) as "noActiveSessions",
       not exists (
         select 1
           from pg_shdepend dependency
           join pg_roles owner_role on owner_role.oid = dependency.refobjid
          where dependency.refclassid = 'pg_authid'::regclass
            and dependency.deptype = 'o'
            and owner_role.rolname = any($1::text[])
       )
       and not exists (
         select 1 from pg_class object
           join pg_roles owner_role on owner_role.oid = object.relowner
          where owner_role.rolname = any($1::text[])
       )
       and not exists (
         select 1 from pg_namespace object
           join pg_roles owner_role on owner_role.oid = object.nspowner
          where owner_role.rolname = any($1::text[])
       )
       and not exists (
         select 1 from pg_proc object
           join pg_roles owner_role on owner_role.oid = object.proowner
          where owner_role.rolname = any($1::text[])
       )
       and not exists (
         select 1 from pg_database object
           join pg_roles owner_role on owner_role.oid = object.datdba
          where owner_role.rolname = any($1::text[])
       )
       and not exists (
         select 1 from pg_type object
           join pg_roles owner_role on owner_role.oid = object.typowner
          where owner_role.rolname = any($1::text[])
       )
       and not exists (
         select 1 from pg_extension object
           join pg_roles owner_role on owner_role.oid = object.extowner
          where owner_role.rolname = any($1::text[])
       ) as "noOwnedObjects"`,
    [SERVICE_DATABASE_ROLES.map((definition) => definition.role), SERVICE_DATABASE_ROLES.length]
  );
  const state = prerequisites.rows[0];
  if (!state?.migrationApplied) {
    throw new Error("service database role bootstrap requires validated migration 024");
  }
  if (!state.allRolesPresent) {
    throw new Error("service database role bootstrap requires all fixed NOLOGIN roles");
  }
  if (requireNoActiveSessions && !state.uniformLoginState) {
    throw new Error("service database role bootstrap refused a partially activated role set");
  }
  if (requireNoActiveSessions && !state.noActiveSessions) {
    throw new Error("service database role bootstrap requires all service sessions to be drained");
  }
  if (!state.safeCapabilities || !state.noMemberships || !state.noOwnedObjects) {
    throw new Error("service database role bootstrap refused an unsafe role privilege matrix");
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const passwords = readServiceRolePasswords();
  await bootstrapDatabaseRoles(databaseUrl, passwords);
  logger.info("service database roles are ready", { roleCount: SERVICE_DATABASE_ROLES.length });
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    logger.error("service database role bootstrap failed", {
      error: error instanceof Error ? error.message : "unknown error"
    });
    process.exitCode = 1;
  }
}
