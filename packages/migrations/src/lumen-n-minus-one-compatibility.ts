import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createLogger } from "@hyperion/logger";
import pg from "pg";
import { readMigrationExecutionOptions, type MigrationExecutionOptions } from "./runner.js";
import { SERVICE_DATABASE_ROLES } from "./service-database-roles.js";

const { Client } = pg;
const logger = createLogger("lumen-n-minus-one-compatibility");
const SCOPE_PATTERN = /^lumen-n1-[A-Za-z0-9][A-Za-z0-9_.-]{7,47}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ATTESTATION_CLOCK_SKEW_MS = 5_000;
// Reuse the exact bootstrap mutex so credential rotation and temporary ACL
// transitions cannot interleave. The lock is global across every N-1 scope.
const COMPATIBILITY_LOCK_KEY = "hyperion:service-role-bootstrap";

export interface LumenNMinusOneWindowInput {
  readonly cleanupScopeId: string;
  readonly rollbackEvidenceSha256: string;
}

export interface DestroyedLegacyScopeAttestationInput {
  readonly cleanupScopeId: string;
  readonly attestationId: string;
  readonly destroyedAt: string;
  readonly evidenceSha256: string;
}

export interface DestroyedLegacyScopeAttestationResult {
  readonly finalizedAttemptCount: number;
  readonly replay: boolean;
}

type CompatibilityClient = InstanceType<typeof Client>;

interface LumenRuntimeRoleState {
  readonly canLogin: boolean;
  readonly noMemberships: boolean;
  readonly noOwnedObjects: boolean;
  readonly safeCapabilities: boolean;
}

interface LumenNMinusOnePrivilegeState {
  readonly adminLedgerInaccessible: boolean;
  readonly auditInsert: boolean;
  readonly auditOtherDenied: boolean;
  readonly guardExecuteDenied: boolean;
  readonly platformCreateDenied: boolean;
  readonly platformUsage: boolean;
  readonly pulsoCreateDenied: boolean;
  readonly pulsoReferenceSelect: boolean;
  readonly pulsoReferenceWritesDenied: boolean;
  readonly pulsoUsage: boolean;
  readonly schemaLedgerSelect: boolean;
  readonly schemaLedgerWritesDenied: boolean;
}

/**
 * Opens the smallest database-compatibility window needed by the exact LUMEN
 * image from origin/main. These grants are deliberately absent from migration
 * 024, so the normal role bootstrap also revokes them when current returns.
 */
export async function openLumenNMinusOneCompatibilityWindow(
  databaseUrl: string,
  input: LumenNMinusOneWindowInput,
  executionOptions: MigrationExecutionOptions = readMigrationExecutionOptions()
): Promise<void> {
  assertLumenNMinusOneCompatEnabled();
  validateScopeId(input.cleanupScopeId);
  validateSha256(input.rollbackEvidenceSha256, "rollback evidence");
  await withCompatibilitySessionLock(databaseUrl, executionOptions, async (client) => {
    await assertCompatibilitySchema(client);
    if (await isHealthyOpenWindow(client, input)) return;
    await assertScopeCanStartOpening(client, input.cleanupScopeId);
    await assertAllServiceRolesActivatedAndSafe(client);
    await assertNoActiveLumenSessions(client);
    await assertLumenNMinusOnePrivilegeState(client, false);

    // Phase 1 is committed independently. New runtime connections are fenced
    // before any temporary ACL is created; every later error leaves NOLOGIN.
    await fenceLumenRuntimeRole(client, executionOptions);

    await withClientTransaction(client, executionOptions, async () => {
      await assertCompatibilitySchema(client);
      await assertNoActiveLumenSessions(client);
      await assertSafeLumenRuntimeRole(client, false);

      const openWindows = await client.query<{
        cleanupScopeId: string;
        rollbackEvidenceSha256: string;
      }>(
        `select cleanup_scope_id as "cleanupScopeId",
                rollback_evidence_sha256 as "rollbackEvidenceSha256"
           from lumen.n_minus_one_compatibility_windows
          where closed_at is null
          for update`
      );
      const openWindowCount = openWindows.rowCount ?? 0;
      if (openWindowCount > 1) {
        throw new Error("multiple open LUMEN N-1 compatibility windows require administrative repair");
      }
      if (openWindowCount === 1) {
        const openWindow = openWindows.rows[0]!;
        if (openWindow.cleanupScopeId !== input.cleanupScopeId) {
          throw new Error("another LUMEN N-1 compatibility window is already open");
        }
        if (openWindow.rollbackEvidenceSha256 !== input.rollbackEvidenceSha256) {
          throw new Error("LUMEN N-1 cleanup scope evidence does not match its open window");
        }
      } else {
        const existing = await client.query<{ closedAt: Date | null }>(
          `select closed_at as "closedAt"
             from lumen.n_minus_one_compatibility_windows
            where cleanup_scope_id = $1
            for update`,
          [input.cleanupScopeId]
        );
        if (existing.rowCount === 1) throw new Error("LUMEN N-1 cleanup scope cannot be reopened");
        await client.query(
          `insert into lumen.n_minus_one_compatibility_windows (
             cleanup_scope_id, rollback_evidence_sha256
           ) values ($1, $2)`,
          [input.cleanupScopeId, input.rollbackEvidenceSha256]
        );
      }

      await grantLumenNMinusOnePrivileges(client);
      await assertLumenNMinusOnePrivilegeState(client, true);
      await client.query("alter role hyperion_lumen with login");
      await assertSafeLumenRuntimeRole(client, true);
    });
  });
}

/** Stops the rollback window only after every hyperion_lumen database session drained. */
export async function closeLumenNMinusOneCompatibilityWindow(
  databaseUrl: string,
  cleanupScopeId: string,
  executionOptions: MigrationExecutionOptions = readMigrationExecutionOptions()
): Promise<void> {
  assertLumenNMinusOneCompatEnabled();
  validateScopeId(cleanupScopeId);
  await withCompatibilitySessionLock(databaseUrl, executionOptions, async (client) => {
    await assertCompatibilitySchema(client);
    const preflight = await client.query<{ closedAt: Date | null }>(
      `select closed_at as "closedAt"
         from lumen.n_minus_one_compatibility_windows
        where cleanup_scope_id = $1`,
      [cleanupScopeId]
    );
    if (preflight.rowCount !== 1) throw new Error("LUMEN N-1 compatibility window does not exist");
    if (preflight.rows[0]?.closedAt) {
      const anotherOpenWindow = await client.query(
        `select 1 from lumen.n_minus_one_compatibility_windows
          where closed_at is null
          limit 1`
      );
      if (anotherOpenWindow.rowCount !== 0) {
        throw new Error("a different LUMEN N-1 compatibility window is still open");
      }
      // A retry after bootstrap reconciliation must not fence only LUMEN. It
      // merely reasserts baseline ACLs and preserves the current login state.
      await withClientTransaction(client, executionOptions, async () => {
        await revokeLumenNMinusOnePrivileges(client);
        await assertLumenNMinusOnePrivilegeState(client, false);
      });
      return;
    }

    await fenceLumenRuntimeRole(client, executionOptions);

    await withClientTransaction(client, executionOptions, async () => {
      await assertCompatibilitySchema(client);
      await assertNoActiveLumenSessions(client);
      await assertSafeLumenRuntimeRole(client, false);
      const existing = await client.query<{ closedAt: Date | null }>(
        `select closed_at as "closedAt"
           from lumen.n_minus_one_compatibility_windows
          where cleanup_scope_id = $1
          for update`,
        [cleanupScopeId]
      );
      if (existing.rowCount !== 1) throw new Error("LUMEN N-1 compatibility window does not exist");

      const otherOpenWindows = await client.query<{ cleanupScopeId: string }>(
        `select cleanup_scope_id as "cleanupScopeId"
           from lumen.n_minus_one_compatibility_windows
          where closed_at is null
          for update`
      );
      const otherOpenWindowCount = otherOpenWindows.rowCount ?? 0;
      if (
        otherOpenWindowCount > 1 ||
        (otherOpenWindowCount === 1 && otherOpenWindows.rows[0]?.cleanupScopeId !== cleanupScopeId)
      ) {
        throw new Error("a different LUMEN N-1 compatibility window is still open");
      }

      if (!existing.rows[0]?.closedAt) {
        await client.query(
          `update lumen.n_minus_one_compatibility_windows
              set closed_at = now(), closed_by = session_user, close_reason = 'operator_closed'
            where cleanup_scope_id = $1 and closed_at is null`,
          [cleanupScopeId]
        );
      }
      await revokeLumenNMinusOnePrivileges(client);
      await assertLumenNMinusOnePrivilegeState(client, false);
      // Returning to current is a separate all-role bootstrap. Never reactivate
      // one shared identity after rollback or rescue an unrelated failed fence.
      await assertSafeLumenRuntimeRole(client, false);
    });
  });
}

/**
 * Finalizes only legacy rows after the orchestrator has destroyed their exact
 * externally managed ephemeral scope. It never inspects, derives, scans or removes a
 * filesystem path. The raw external evidence is retained outside PostgreSQL;
 * only its SHA-256 is stored here.
 */
export async function attestDestroyedLegacyAudioScope(
  databaseUrl: string,
  input: DestroyedLegacyScopeAttestationInput,
  executionOptions: MigrationExecutionOptions = readMigrationExecutionOptions()
): Promise<DestroyedLegacyScopeAttestationResult> {
  assertLumenNMinusOneCompatEnabled();
  validateScopeId(input.cleanupScopeId);
  validateSha256(input.evidenceSha256, "scope destruction evidence");
  if (!UUID_PATTERN.test(input.attestationId)) throw new Error("LUMEN N-1 scope attestation id must be a UUID");
  const destroyedAt = parsePastTimestamp(input.destroyedAt);

  return withCompatibilitySessionLock(databaseUrl, executionOptions, async (client) =>
    withClientTransaction(client, executionOptions, async () => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `hyperion:lumen-n1:${input.cleanupScopeId}`
      ]);
      await assertCompatibilitySchema(client);
      await assertSafeLumenRuntimeRole(client, false);
      await assertNoActiveLumenSessions(client);
      const window = await client.query<{ openedAt: Date; closedAt: Date | null }>(
        `select opened_at as "openedAt", closed_at as "closedAt"
         from lumen.n_minus_one_compatibility_windows
        where cleanup_scope_id = $1
        for update`,
        [input.cleanupScopeId]
      );
      if (window.rowCount !== 1) throw new Error("LUMEN N-1 compatibility window does not exist");
      if (!window.rows[0]?.closedAt) throw new Error("close the LUMEN N-1 compatibility window before attestation");
      if (destroyedAt.getTime() < window.rows[0].openedAt.getTime()) {
        throw new Error("LUMEN N-1 scope destruction predates its compatibility window");
      }

      const existing = await client.query<{
        attestationId: string;
        destroyedAt: Date;
        evidenceSha256: string;
        finalizedAttemptCount: number;
      }>(
        `select attestation_id as "attestationId", destroyed_at as "destroyedAt",
              evidence_sha256 as "evidenceSha256",
              finalized_attempt_count as "finalizedAttemptCount"
         from lumen.legacy_audio_scope_attestations
        where cleanup_scope_id = $1
        for update`,
        [input.cleanupScopeId]
      );
      if (existing.rowCount === 1) {
        const row = existing.rows[0]!;
        if (
          row.attestationId !== input.attestationId ||
          row.evidenceSha256 !== input.evidenceSha256 ||
          row.destroyedAt.getTime() !== destroyedAt.getTime()
        ) {
          throw new Error("LUMEN N-1 scope already has a different destruction attestation");
        }
        return { finalizedAttemptCount: row.finalizedAttemptCount, replay: true };
      }

      const timing = await client.query<{ attemptCount: number; newestStartedAt: Date | null }>(
        `select max(started_at) as "newestStartedAt", count(*)::int as "attemptCount"
         from lumen.processing_attempts
        where cleanup_protocol = 'legacy_ephemeral_v1'
          and cleanup_scope_id = $1
          and status in ('processing', 'cleanup_pending')`,
        [input.cleanupScopeId]
      );
      if (timing.rows[0]?.newestStartedAt && destroyedAt.getTime() < timing.rows[0].newestStartedAt.getTime()) {
        throw new Error("LUMEN N-1 scope destruction predates an active legacy attempt");
      }

      const finalizedAttemptCount = timing.rows[0]?.attemptCount ?? 0;
      // Insert the immutable evidence first in the same transaction. The
      // SECURITY DEFINER transition guard below can then prove that every
      // ephemeral_scope_destroyed update is administrative and attested.
      await client.query(
        `insert into lumen.legacy_audio_scope_attestations (
         attestation_id, cleanup_scope_id, destroyed_at, evidence_sha256,
         finalized_attempt_count
       ) values ($1::uuid, $2, $3::timestamptz, $4, $5)`,
        [
          input.attestationId,
          input.cleanupScopeId,
          destroyedAt.toISOString(),
          input.evidenceSha256,
          finalizedAttemptCount
        ]
      );

      const finalized = await client.query(
        `update lumen.processing_attempts
          set status = case
                when status = 'cleanup_pending' then cleanup_target_status
                else 'failed'
              end,
              failed_at = case
                when status = 'processing' or cleanup_target_status = 'failed' then now()
                else null
              end,
              cancelled_at = case
                when status = 'cleanup_pending' and cleanup_target_status = 'cancelled' then now()
                else null
              end,
              error_code = case
                when status = 'cleanup_pending' and cleanup_target_status = 'cancelled' then null
                else coalesce(error_code, 'legacy_process_interrupted')
              end,
              temp_audio_deleted_at = $2::timestamptz,
              cleanup_disposition = 'ephemeral_scope_destroyed',
              cleanup_target_status = null,
              updated_at = now()
        where cleanup_protocol = 'legacy_ephemeral_v1'
          and cleanup_scope_id = $1
          and status in ('processing', 'cleanup_pending')`,
        [input.cleanupScopeId, destroyedAt.toISOString()]
      );
      if ((finalized.rowCount ?? 0) !== finalizedAttemptCount) {
        throw new Error("LUMEN N-1 attestation did not finalize its exact legacy attempt set");
      }
      return { finalizedAttemptCount, replay: false };
    })
  );
}

async function grantLumenNMinusOnePrivileges(client: CompatibilityClient): Promise<void> {
  await client.query("grant usage on schema platform, pulso_iris to hyperion_lumen");
  await client.query(
    `grant select on table
       platform.schema_migrations,
       pulso_iris.administrative_patients,
       pulso_iris.professionals,
       pulso_iris.sites
     to hyperion_lumen`
  );
  await client.query("grant insert on table platform.audit_events to hyperion_lumen");
}

async function revokeLumenNMinusOnePrivileges(client: CompatibilityClient): Promise<void> {
  await client.query("revoke insert on table platform.audit_events from hyperion_lumen");
  await client.query(
    `revoke select on table
       platform.schema_migrations,
       pulso_iris.administrative_patients,
       pulso_iris.professionals,
       pulso_iris.sites
     from hyperion_lumen`
  );
  await client.query("revoke usage on schema platform, pulso_iris from hyperion_lumen");
}

async function fenceLumenRuntimeRole(
  client: CompatibilityClient,
  executionOptions: MigrationExecutionOptions
): Promise<void> {
  await withClientTransaction(client, executionOptions, async () => {
    await client.query("alter role hyperion_lumen with nologin");
  });
}

async function withCompatibilitySessionLock<T>(
  databaseUrl: string,
  executionOptions: MigrationExecutionOptions,
  operation: (client: CompatibilityClient) => Promise<T>
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  let lockAcquired = false;
  await client.connect();
  try {
    // PostgreSQL advisory locks do not honor lock_timeout, so bound the
    // session-level global mutex with statement_timeout while acquiring it.
    await client.query("select set_config('statement_timeout', $1, false)", [`${executionOptions.lockTimeoutMs}ms`]);
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [COMPATIBILITY_LOCK_KEY]);
      lockAcquired = true;
    } finally {
      await client.query("reset statement_timeout").catch(() => undefined);
    }
    return await operation(client);
  } finally {
    if (lockAcquired) {
      await client.query("select pg_advisory_unlock(hashtext($1))", [COMPATIBILITY_LOCK_KEY]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

async function withClientTransaction<T>(
  client: CompatibilityClient,
  executionOptions: MigrationExecutionOptions,
  operation: () => Promise<T>
): Promise<T> {
  await client.query("begin");
  try {
    await client.query("select set_config('lock_timeout', $1, true)", [`${executionOptions.lockTimeoutMs}ms`]);
    await client.query("select set_config('statement_timeout', $1, true)", [
      `${executionOptions.statementTimeoutMs}ms`
    ]);
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function assertCompatibilitySchema(client: CompatibilityClient): Promise<void> {
  const result = await client.query<{ ready: boolean }>(
    `select to_regclass('lumen.n_minus_one_compatibility_windows') is not null
            and to_regclass('lumen.legacy_audio_scope_attestations') is not null
            and exists (
              select 1 from lumen.schema_version
               where service_name = 'lumen' and current_version >= 32
            ) as ready`
  );
  if (!result.rows[0]?.ready) throw new Error("LUMEN N-1 compatibility schema is incomplete; run migrations");
}

async function assertNoActiveLumenSessions(client: CompatibilityClient): Promise<void> {
  const active = await client.query(
    `select 1
       from pg_stat_activity
      where usename = 'hyperion_lumen'
        and pid <> pg_backend_pid()
        and backend_type = 'client backend'
      limit 1`
  );
  if (active.rowCount !== 0) throw new Error("hyperion_lumen still has active database sessions");
}

async function isHealthyOpenWindow(client: CompatibilityClient, input: LumenNMinusOneWindowInput): Promise<boolean> {
  const windows = await client.query<{ cleanupScopeId: string; rollbackEvidenceSha256: string }>(
    `select cleanup_scope_id as "cleanupScopeId",
            rollback_evidence_sha256 as "rollbackEvidenceSha256"
       from lumen.n_minus_one_compatibility_windows
      where closed_at is null`
  );
  if (
    windows.rowCount !== 1 ||
    windows.rows[0]?.cleanupScopeId !== input.cleanupScopeId ||
    windows.rows[0]?.rollbackEvidenceSha256 !== input.rollbackEvidenceSha256
  ) {
    return false;
  }
  const role = await readLumenRuntimeRoleState(client);
  const privileges = await readLumenNMinusOnePrivilegeState(client);
  const allRolesActivated = await readAllServiceRolesActivatedAndSafe(client);
  return (
    allRolesActivated &&
    isSafeLumenRuntimeRoleState(role, true) &&
    isExpectedLumenNMinusOnePrivilegeState(privileges, true)
  );
}

async function assertScopeCanStartOpening(client: CompatibilityClient, cleanupScopeId: string): Promise<void> {
  const openWindow = await client.query(
    `select 1 from lumen.n_minus_one_compatibility_windows
      where closed_at is null
      limit 1`
  );
  if (openWindow.rowCount !== 0) {
    throw new Error("an existing LUMEN N-1 compatibility window is not in the requested healthy state");
  }
  const reusedScope = await client.query(
    `select 1 from lumen.n_minus_one_compatibility_windows
      where cleanup_scope_id = $1
      limit 1`,
    [cleanupScopeId]
  );
  if (reusedScope.rowCount !== 0) throw new Error("LUMEN N-1 cleanup scope cannot be reopened");
}

async function assertAllServiceRolesActivatedAndSafe(client: CompatibilityClient): Promise<void> {
  if (!(await readAllServiceRolesActivatedAndSafe(client))) {
    throw new Error("LUMEN N-1 open requires the fully activated and validated service-role set");
  }
}

async function readAllServiceRolesActivatedAndSafe(client: CompatibilityClient): Promise<boolean> {
  const roles = SERVICE_DATABASE_ROLES.map((definition) => definition.role);
  const result = await client.query<{ valid: boolean }>(
    `select exists (
              select 1 from platform.schema_migrations
               where name = '024-service-database-roles.sql'
            )
            and exists (
              select 1 from platform.schema_migrations
               where name = '020-service-role-nologin-fence.sql'
            )
            and exists (
              select 1 from platform.schema_migrations
               where name = '024-service-role-membership-fence.sql'
            )
            and (
              select count(*) = $2::int
                 and bool_and(
                   role.rolcanlogin
                   and not role.rolsuper
                   and not role.rolcreatedb
                   and not role.rolcreaterole
                   and not role.rolinherit
                   and not role.rolreplication
                   and not role.rolbypassrls
                 )
                from pg_catalog.pg_roles role
               where role.rolname = any($1::text[])
            )
            and not exists (
              select 1
                from pg_catalog.pg_auth_members membership
                join pg_catalog.pg_roles member_role on member_role.oid = membership.member
                join pg_catalog.pg_roles granted_role on granted_role.oid = membership.roleid
               where member_role.rolname = any($1::text[])
                  or granted_role.rolname = any($1::text[])
            ) as valid`,
    [roles, roles.length]
  );
  return result.rows[0]?.valid === true;
}

async function assertSafeLumenRuntimeRole(client: CompatibilityClient, expectedCanLogin: boolean): Promise<void> {
  const state = await readLumenRuntimeRoleState(client);
  if (!isSafeLumenRuntimeRoleState(state, expectedCanLogin)) {
    throw new Error("LUMEN N-1 compatibility refused an unsafe hyperion_lumen role state");
  }
}

function isSafeLumenRuntimeRoleState(state: LumenRuntimeRoleState, expectedCanLogin: boolean): boolean {
  return state.canLogin === expectedCanLogin && state.safeCapabilities && state.noMemberships && state.noOwnedObjects;
}

async function readLumenRuntimeRoleState(client: CompatibilityClient): Promise<LumenRuntimeRoleState> {
  const result = await client.query<LumenRuntimeRoleState>(
    `select role.rolcanlogin as "canLogin",
            not (
              role.rolsuper or role.rolcreatedb or role.rolcreaterole or role.rolinherit
              or role.rolreplication or role.rolbypassrls
            ) as "safeCapabilities",
            not exists (
              select 1
                from pg_catalog.pg_auth_members membership
               where membership.member = role.oid or membership.roleid = role.oid
            ) as "noMemberships",
            not exists (
              select 1
                from pg_catalog.pg_shdepend dependency
               where dependency.refclassid = 'pg_authid'::regclass
                 and dependency.refobjid = role.oid
                 and dependency.deptype = 'o'
            )
            and not exists (select 1 from pg_catalog.pg_class object where object.relowner = role.oid)
            and not exists (select 1 from pg_catalog.pg_namespace object where object.nspowner = role.oid)
            and not exists (select 1 from pg_catalog.pg_proc object where object.proowner = role.oid)
            and not exists (select 1 from pg_catalog.pg_type object where object.typowner = role.oid)
              as "noOwnedObjects"
       from pg_catalog.pg_roles role
      where role.rolname = 'hyperion_lumen'`
  );
  const state = result.rows[0];
  if (!state) throw new Error("hyperion_lumen role does not exist");
  return state;
}

async function assertLumenNMinusOnePrivilegeState(client: CompatibilityClient, expectedOpen: boolean): Promise<void> {
  const state = await readLumenNMinusOnePrivilegeState(client);
  if (!isExpectedLumenNMinusOnePrivilegeState(state, expectedOpen)) {
    throw new Error(`LUMEN N-1 ${expectedOpen ? "grant" : "revoke"} postcondition failed`);
  }
}

function isExpectedLumenNMinusOnePrivilegeState(state: LumenNMinusOnePrivilegeState, expectedOpen: boolean): boolean {
  return (
    state.platformUsage === expectedOpen &&
    state.schemaLedgerSelect === expectedOpen &&
    state.pulsoUsage === expectedOpen &&
    state.pulsoReferenceSelect === expectedOpen &&
    state.auditInsert === expectedOpen &&
    state.platformCreateDenied &&
    state.schemaLedgerWritesDenied &&
    state.pulsoCreateDenied &&
    state.pulsoReferenceWritesDenied &&
    state.auditOtherDenied &&
    state.adminLedgerInaccessible &&
    state.guardExecuteDenied
  );
}

async function readLumenNMinusOnePrivilegeState(client: CompatibilityClient): Promise<LumenNMinusOnePrivilegeState> {
  const result = await client.query<LumenNMinusOnePrivilegeState>(
    `select has_schema_privilege('hyperion_lumen', 'platform', 'USAGE') as "platformUsage",
            not has_schema_privilege('hyperion_lumen', 'platform', 'CREATE') as "platformCreateDenied",
            has_table_privilege('hyperion_lumen', 'platform.schema_migrations', 'SELECT') as "schemaLedgerSelect",
            not exists (
              select 1
                from (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
                     denied(privilege)
               where has_table_privilege(
                 'hyperion_lumen', 'platform.schema_migrations', denied.privilege
               )
            ) as "schemaLedgerWritesDenied",
            has_schema_privilege('hyperion_lumen', 'pulso_iris', 'USAGE') as "pulsoUsage",
            not has_schema_privilege('hyperion_lumen', 'pulso_iris', 'CREATE') as "pulsoCreateDenied",
            has_table_privilege('hyperion_lumen', 'pulso_iris.administrative_patients', 'SELECT')
              and has_table_privilege('hyperion_lumen', 'pulso_iris.professionals', 'SELECT')
              and has_table_privilege('hyperion_lumen', 'pulso_iris.sites', 'SELECT')
              as "pulsoReferenceSelect",
            not exists (
              select 1
                from (values
                  ('pulso_iris.administrative_patients'::regclass),
                  ('pulso_iris.professionals'::regclass),
                  ('pulso_iris.sites'::regclass)
                ) referenced(table_oid)
                cross join (values
                  ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
                ) denied(privilege)
               where has_table_privilege('hyperion_lumen', referenced.table_oid, denied.privilege)
            ) as "pulsoReferenceWritesDenied",
            has_table_privilege('hyperion_lumen', 'platform.audit_events', 'INSERT') as "auditInsert",
            not exists (
              select 1
                from (values ('SELECT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
                     denied(privilege)
               where has_table_privilege('hyperion_lumen', 'platform.audit_events', denied.privilege)
            ) as "auditOtherDenied",
            not exists (
              select 1
                from (values
                  ('lumen.n_minus_one_compatibility_windows'::regclass),
                  ('lumen.legacy_audio_scope_attestations'::regclass)
                ) ledger(table_oid)
                cross join (values
                  ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
                ) denied(privilege)
               where has_table_privilege('hyperion_lumen', ledger.table_oid, denied.privilege)
            ) as "adminLedgerInaccessible",
            not has_function_privilege(
              'hyperion_lumen', 'lumen.require_open_n1_compatibility_window()', 'EXECUTE'
            )
            and not has_function_privilege(
              'hyperion_lumen', 'lumen.require_attested_legacy_cleanup_terminal()', 'EXECUTE'
            ) as "guardExecuteDenied"`
  );
  return result.rows[0]!;
}

function validateScopeId(value: string): void {
  if (!SCOPE_PATTERN.test(value)) {
    throw new Error("LUMEN N-1 cleanup scope id is invalid");
  }
}

function validateSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function parsePastTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("LUMEN N-1 scope destruction time is invalid");
  // PostgreSQL and the administrative process can differ by a few milliseconds.
  // Keep a small, explicit skew budget while rejecting materially future claims.
  if (parsed.getTime() > Date.now() + MAX_ATTESTATION_CLOCK_SKEW_MS) {
    throw new Error("LUMEN N-1 scope destruction time cannot be materially in the future");
  }
  return parsed;
}

/**
 * Production CLI permanently retired (DEBT-025). Vitest rehearsals may open the
 * library APIs only when HYPERION_LUMEN_N1_TEST_REHEARSAL=1 under VITEST.
 */
export function assertLumenNMinusOneCompatEnabled(env: NodeJS.ProcessEnv = process.env): void {
  const underVitest = env.VITEST === "true" || env.VITEST === "1";
  const testRehearsal = env.HYPERION_LUMEN_N1_TEST_REHEARSAL?.trim() === "1";
  if (underVitest && testRehearsal) return;
  throw new Error(
    "LUMEN N-1 compatibility bridge is permanently retired (DEBT-025). Administrative escape hatch removed."
  );
}

async function main(): Promise<void> {
  assertLumenNMinusOneCompatEnabled();
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const action = process.argv[2]?.trim();
  const cleanupScopeId = process.env.LUMEN_N1_CLEANUP_SCOPE_ID?.trim() ?? "";

  if (action === "open") {
    await openLumenNMinusOneCompatibilityWindow(databaseUrl, {
      cleanupScopeId,
      rollbackEvidenceSha256: process.env.LUMEN_N1_ROLLBACK_EVIDENCE_SHA256?.trim() ?? ""
    });
    logger.info("LUMEN N-1 compatibility window opened", { cleanupScopeId });
    return;
  }
  if (action === "close") {
    await closeLumenNMinusOneCompatibilityWindow(databaseUrl, cleanupScopeId);
    logger.info("LUMEN N-1 compatibility window closed", { cleanupScopeId });
    return;
  }
  if (action === "attest-destroyed-scope") {
    if (process.env.LUMEN_N1_SCOPE_DESTRUCTION_CONFIRMED?.trim().toLowerCase() !== "true") {
      throw new Error("LUMEN_N1_SCOPE_DESTRUCTION_CONFIRMED=true is required after external scope destruction");
    }
    const result = await attestDestroyedLegacyAudioScope(databaseUrl, {
      cleanupScopeId,
      attestationId: process.env.LUMEN_N1_SCOPE_ATTESTATION_ID?.trim() ?? "",
      destroyedAt: process.env.LUMEN_N1_SCOPE_DESTROYED_AT?.trim() ?? "",
      evidenceSha256: process.env.LUMEN_N1_SCOPE_EVIDENCE_SHA256?.trim() ?? ""
    });
    logger.info("LUMEN legacy ephemeral scope attested", {
      cleanupScopeId,
      finalizedAttemptCount: result.finalizedAttemptCount,
      replay: result.replay
    });
    return;
  }
  throw new Error("expected action: open, close, or attest-destroyed-scope");
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (entrypoint === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    logger.error("LUMEN N-1 compatibility action failed", {
      error: error instanceof Error ? error.message : "unknown error"
    });
    process.exitCode = 1;
  }
}
