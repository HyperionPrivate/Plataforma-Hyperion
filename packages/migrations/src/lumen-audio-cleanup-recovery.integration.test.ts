import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  applyServiceRolePrivilegeMatrix,
  bootstrapDatabaseRoles,
  SERVICE_DATABASE_ROLES,
  type ServiceRolePasswords
} from "./bootstrap-roles.js";
import {
  attestDestroyedLegacyAudioScope,
  closeLumenNMinusOneCompatibilityWindow,
  openLumenNMinusOneCompatibilityWindow
} from "./lumen-n-minus-one-compatibility.js";
import { runMigrations } from "./runner.js";

const { Client } = pg;
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;
const sqlDir = fileURLToPath(new URL("../sql", import.meta.url));
// Vitest-only rehearsal; production CLI permanently retired (DEBT-025).
process.env.HYPERION_LUMEN_N1_TEST_REHEARSAL = "1";

describeIntegration("029-039 LUMEN audio cleanup recovery", () => {
  it("permits only cleanup_pending -> confirmed terminal transitions and keeps terminal rows immutable", async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    const databaseName = `hyperion_lumen_cleanup_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
    let databaseCreated = false;

    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
      databaseCreated = true;
      const migration = await runMigrations(databaseUrl, sqlDir);
      expect(migration.applied).toContain("029-lumen-audio-cleanup-recovery.sql");
      expect(migration.applied).toContain("032-lumen-audio-cleanup-contract.sql");
      expect(migration.applied).toContain("033-lumen-audio-cleanup-index.sql");
      expect(migration.applied).toContain("039-lumen-unresolved-cleanup-owner-index.sql");

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        const contract = await client.query<{
          adminLedgerDenied: boolean;
          activeCleanupIndexReady: boolean;
          allChecksValidated: boolean;
          cleanupIndexReady: boolean;
          compatibilityGuardsHardened: boolean;
          lumenLeaseDml: boolean;
          leaseTable: string | null;
          publicLeaseDml: boolean;
        }>(
          `select
             exists (
               select 1 from pg_index
                where indexrelid = 'lumen.idx_lumen_processing_attempts_unresolved_cleanup_owner'::regclass
                  and indisvalid and indisready
             ) as "activeCleanupIndexReady",
             not exists (
               select 1 from pg_constraint
                where conrelid = 'lumen.processing_attempts'::regclass
                  and conname like 'ck_lumen_processing_attempt_%'
                  and not convalidated
             ) as "allChecksValidated",
             exists (
               select 1 from pg_index
                where indexrelid = 'lumen.idx_lumen_processing_attempts_cleanup_pending'::regclass
                  and indisvalid and indisready
             ) as "cleanupIndexReady",
             not has_table_privilege(
               'hyperion_lumen', 'lumen.n_minus_one_compatibility_windows',
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
             )
             and not has_table_privilege(
               'hyperion_lumen', 'lumen.legacy_audio_scope_attestations',
               'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
             ) as "adminLedgerDenied",
             (
               select count(*) = 2
                  and bool_and(guard_function.prosecdef)
                  and bool_and(guard_function.proconfig @> array['search_path=pg_catalog, lumen'])
                  and bool_and(not has_function_privilege('hyperion_lumen', guard_function.oid, 'EXECUTE'))
                 from pg_proc guard_function
                 join pg_namespace namespace on namespace.oid = guard_function.pronamespace
                where namespace.nspname = 'lumen'
                  and guard_function.proname in (
                    'require_open_n1_compatibility_window',
                    'require_attested_legacy_cleanup_terminal'
                  )
             ) as "compatibilityGuardsHardened",
             to_regclass('lumen.audio_cleanup_owner_leases')::text as "leaseTable",
             has_table_privilege(
               'hyperion_lumen', 'lumen.audio_cleanup_owner_leases',
               'SELECT,INSERT,UPDATE,DELETE'
             ) as "lumenLeaseDml",
             exists (
               select 1
                 from pg_class lease_table,
                      lateral aclexplode(coalesce(lease_table.relacl, acldefault('r', lease_table.relowner))) acl
                where lease_table.oid = 'lumen.audio_cleanup_owner_leases'::regclass
                  and acl.grantee = 0
                  and acl.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
             ) as "publicLeaseDml"`
        );
        expect(contract.rows[0]).toEqual({
          adminLedgerDenied: true,
          activeCleanupIndexReady: true,
          allChecksValidated: true,
          cleanupIndexReady: true,
          compatibilityGuardsHardened: true,
          leaseTable: "lumen.audio_cleanup_owner_leases",
          lumenLeaseDml: true,
          publicLeaseDml: false
        });

        const tenantId = (
          await client.query<{ id: string }>(
            `insert into platform.tenants (slug, display_name, status)
             values ($1, 'LUMEN cleanup test', 'active') returning id`,
            [`lumen-cleanup-${randomUUID()}`]
          )
        ).rows[0]!.id;
        await client.query(
          `insert into lumen.tenant_snapshots (
             tenant_id, status, is_demo, is_active, source_version, source_updated_at, payload_hash
           ) values ($1, 'active', true, true, 1, now(), $2)`,
          [tenantId, sha256(`tenant:${tenantId}:1`)]
        );
        const encounterId = randomUUID();
        const patientId = randomUUID();
        const siteId = randomUUID();
        const professionalId = randomUUID();
        await client.query(
          `insert into lumen.encounter_reference_snapshots (
             tenant_id, encounter_id, patient_id, site_id, professional_id,
             patient_display_name, professional_name, site_name,
             patient_is_demo, professional_is_demo, source_version, source_updated_at, payload_hash
           ) values ($1, $2, $3, $4, $5, 'Paciente sintético', 'Profesional sintético',
                     'Sede sintética', true, true, 1, now(), $6)`,
          [tenantId, encounterId, patientId, siteId, professionalId, sha256(`reference:${encounterId}:1`)]
        );
        await client.query(
          `insert into lumen.encounters (
             id, tenant_id, patient_id, professional_id, site_id, scheduled_at,
             is_demo, demo_key, metadata
           ) values ($1, $2, $3, $4, $5, now(), true, $6, '{"synthetic":true}'::jsonb)`,
          [encounterId, tenantId, patientId, professionalId, siteId, `cleanup-${randomUUID()}`]
        );

        const attemptId = (
          await client.query<{ id: string }>(
            `insert into lumen.processing_attempts (
               tenant_id, encounter_id, operation, idempotency_key, input_sha256,
               provider, model, mime_type, source, duration_seconds, cleanup_protocol, cleanup_owner
             ) values ($1, $2, 'transcription', $3, $4, 'test-stt', 'test-model',
                       'audio/wav', 'authorized_upload', 8, 'deterministic_v2', 'lumen-stateful-0')
             returning id`,
            [tenantId, encounterId, randomUUID(), sha256("authorized synthetic audio")]
          )
        ).rows[0]!.id;

        await expect(
          client.query(
            `update lumen.processing_attempts
             set status = 'failed', error_code = 'cleanup_failed', failed_at = now(), updated_at = now()
             where id = $1`,
            [attemptId]
          )
        ).rejects.toMatchObject({ code: "23514" });

        await client.query(
          `update lumen.processing_attempts
           set status = 'cleanup_pending', cleanup_target_status = 'failed',
               error_code = 'temporary_storage', updated_at = now()
           where id = $1`,
          [attemptId]
        );
        await expect(
          client.query(
            `update lumen.processing_attempts
             set status = 'failed', cleanup_target_status = null, failed_at = now(), updated_at = now()
             where id = $1`,
            [attemptId]
          )
        ).rejects.toMatchObject({ code: "23514" });

        await client.query(
          `update lumen.processing_attempts
           set status = cleanup_target_status, cleanup_target_status = null,
               failed_at = now(), temp_audio_deleted_at = now(), updated_at = now()
           where id = $1`,
          [attemptId]
        );
        const finalized = await client.query<{
          status: string;
          errorCode: string | null;
          deletedAt: Date | null;
        }>(
          `select status, error_code as "errorCode", temp_audio_deleted_at as "deletedAt"
           from lumen.processing_attempts where id = $1`,
          [attemptId]
        );
        expect(finalized.rows[0]).toMatchObject({ status: "failed", errorCode: "temporary_storage" });
        expect(finalized.rows[0]?.deletedAt).toBeInstanceOf(Date);

        await expect(
          client.query(`update lumen.processing_attempts set updated_at = now() where id = $1`, [attemptId])
        ).rejects.toMatchObject({ code: "23514" });
      } finally {
        await client.end();
      }
    } finally {
      if (databaseCreated) await admin.query(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
    }
  }, 120_000);

  it("supports exact origin/main audio SQL only inside an attributed N-1 scope without false cleanup", async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    const databaseName = `hyperion_lumen_n1_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
    const cleanupScopeId = `lumen-n1-ci-${randomUUID()}`;
    const rollbackEvidenceSha256 = sha256("authorized rollback rehearsal");
    const serviceRolePasswords = new Map(
      SERVICE_DATABASE_ROLES.map((definition, index) => [
        definition.role,
        `N1${index}${randomUUID().replaceAll("-", "")}Safe`
      ])
    ) as ServiceRolePasswords;
    const lumenDatabaseUrl = withCredentials(
      databaseUrl,
      "hyperion_lumen",
      serviceRolePasswords.get("hyperion_lumen")!
    );
    let databaseCreated = false;

    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
      databaseCreated = true;
      await runMigrations(databaseUrl, sqlDir);
      await bootstrapDatabaseRoles(databaseUrl, serviceRolePasswords);
      const databaseAdmin = new Client({ connectionString: databaseUrl });
      await databaseAdmin.connect();
      try {
        const { tenantId, encounterId } = await createLumenFixture(databaseAdmin, "n1-compat");

        // A regex-valid PGAPPNAME is insufficient: the real runtime identity
        // cannot create a legacy attempt until its administrative window opens,
        // and it never receives SELECT on the private compatibility ledger.
        const beforeOpen = new Client({ connectionString: lumenDatabaseUrl, application_name: cleanupScopeId });
        await beforeOpen.connect();
        try {
          await expect(
            insertOriginMainTranscriptionAttempt(beforeOpen, tenantId, encounterId, "before-open")
          ).rejects.toMatchObject({ code: "23514" });
          await expect(
            beforeOpen.query("select count(*) from lumen.n_minus_one_compatibility_windows")
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await beforeOpen.end();
        }

        await openLumenNMinusOneCompatibilityWindow(databaseUrl, {
          cleanupScopeId,
          rollbackEvidenceSha256
        });

        const openedPrivileges = await readLumenNMinusOnePrivileges(databaseAdmin);
        expect(openedPrivileges).toEqual({
          auditInsert: true,
          auditUpdate: false,
          ledgerSelect: true,
          platformUsage: true,
          pulsoPatientSelect: true,
          pulsoUsage: true
        });

        // The exact N-1 INSERT has no cleanup columns. Even during the window,
        // an actual hyperion_lumen connection without the attributed scope is
        // rejected by the first guard.
        const unattributed = new Client({ connectionString: lumenDatabaseUrl, application_name: "lumen-current" });
        await unattributed.connect();
        try {
          await expect(
            insertOriginMainTranscriptionAttempt(unattributed, tenantId, encounterId, "unattributed")
          ).rejects.toMatchObject({ code: "23514" });
        } finally {
          await unattributed.end();
        }

        const legacy = new Client({ connectionString: lumenDatabaseUrl, application_name: cleanupScopeId });
        await legacy.connect();
        let legacyClosed = false;
        try {
          const runtimeIdentity = await legacy.query<{ currentUser: string }>(`select current_user as "currentUser"`);
          expect(runtimeIdentity.rows[0]?.currentUser).toBe("hyperion_lumen");
          await expect(
            legacy.query("select count(*) from lumen.n_minus_one_compatibility_windows")
          ).rejects.toMatchObject({ code: "42501" });

          const completedAttemptId = await insertOriginMainTranscriptionAttempt(
            legacy,
            tenantId,
            encounterId,
            "completed"
          );
          const dictationId = (
            await legacy.query<{ id: string }>(
              `insert into lumen.dictations (
                 tenant_id, encounter_id, status, transcript, mime_type, provider, model,
                 duration_seconds, metadata, provider_transcript, processing_attempt_id
               ) values ($1, $2, 'transcribed', 'Texto sintético', 'audio/wav', 'test-stt',
                         'test-model', 8,
                         '{"audioStored":false,"source":"authorized_upload","temporaryAudioDeleted":true}'::jsonb,
                         'Texto sintético', $3)
               returning id`,
              [tenantId, encounterId, completedAttemptId]
            )
          ).rows[0]!.id;

          // Exact update shape used by origin/main completeProcessingAttempt.
          await legacy.query(
            `update lumen.processing_attempts
             set status = 'completed', result_entity_id = $2, provider = $3, model = $4,
                 request_id_hash = $5, trace_id_hash = $6,
                 temp_audio_deleted_at = case when $7::boolean then now() else temp_audio_deleted_at end,
                 result_snapshot = $8::jsonb, result_sha256 = $9, result_version = $10::timestamptz,
                 completed_at = now(), updated_at = now()
             where id = $1 and tenant_id = $11 and encounter_id = $12 and operation = $13
               and status = 'processing'`,
            [
              completedAttemptId,
              dictationId,
              "test-stt",
              "test-model",
              null,
              null,
              true,
              null,
              null,
              null,
              tenantId,
              encounterId,
              "transcription"
            ]
          );

          const failedAttemptId = await insertOriginMainTranscriptionAttempt(
            legacy,
            tenantId,
            encounterId,
            "cleanup-failed"
          );
          // Exact update shape used by origin/main failProcessingAttempt. A
          // missing deletion confirmation is rewritten to cleanup_pending.
          await legacy.query(
            `update lumen.processing_attempts
             set status = case when $2::boolean then 'cancelled' else 'failed' end,
                 error_code = case when $2::boolean then null else $3 end,
                 cancelled_at = case when $2::boolean then now() else null end,
                 failed_at = case when $2::boolean then null else now() end,
                 temp_audio_deleted_at = case when $4::boolean then now() else temp_audio_deleted_at end,
                 updated_at = now()
             where id = $1 and status = 'processing'`,
            [failedAttemptId, false, "temporary_storage", false]
          );
          const crashedAttemptId = await insertOriginMainTranscriptionAttempt(
            legacy,
            tenantId,
            encounterId,
            "process-crashed"
          );

          const beforeAttestation = await legacy.query<{
            id: string;
            status: string;
            cleanupProtocol: string;
            cleanupScopeId: string;
            cleanupTargetStatus: string | null;
            cleanupDisposition: string | null;
            deletedAt: Date | null;
          }>(
            `select id, status, cleanup_protocol as "cleanupProtocol",
                    cleanup_scope_id as "cleanupScopeId",
                    cleanup_target_status as "cleanupTargetStatus",
                    cleanup_disposition as "cleanupDisposition",
                    temp_audio_deleted_at as "deletedAt"
               from lumen.processing_attempts
              where id = any($1::uuid[])
              order by id`,
            [[completedAttemptId, failedAttemptId, crashedAttemptId]]
          );
          const byId = new Map(beforeAttestation.rows.map((row) => [row.id, row]));
          expect(byId.get(completedAttemptId)).toMatchObject({
            status: "completed",
            cleanupProtocol: "legacy_ephemeral_v1",
            cleanupScopeId,
            cleanupDisposition: "legacy_request_finalizer"
          });
          expect(byId.get(completedAttemptId)?.deletedAt).toBeInstanceOf(Date);
          expect(byId.get(failedAttemptId)).toMatchObject({
            status: "cleanup_pending",
            cleanupProtocol: "legacy_ephemeral_v1",
            cleanupScopeId,
            cleanupTargetStatus: "failed",
            cleanupDisposition: null,
            deletedAt: null
          });
          expect(byId.get(crashedAttemptId)).toMatchObject({
            status: "processing",
            cleanupProtocol: "legacy_ephemeral_v1",
            cleanupScopeId,
            cleanupDisposition: null,
            deletedAt: null
          });

          await expect(
            legacy.query(
              `update lumen.processing_attempts
                  set status = 'failed', cleanup_target_status = null,
                      failed_at = now(), temp_audio_deleted_at = now(),
                      cleanup_disposition = 'ephemeral_scope_destroyed', updated_at = now()
                where id = $1 and status = 'cleanup_pending'`,
              [failedAttemptId]
            )
          ).rejects.toMatchObject({ code: "42501" });
          const stillPending = await legacy.query<{ status: string; disposition: string | null }>(
            `select status, cleanup_disposition as disposition
               from lumen.processing_attempts where id = $1`,
            [failedAttemptId]
          );
          expect(stillPending.rows[0]).toEqual({ status: "cleanup_pending", disposition: null });

          await expect(closeLumenNMinusOneCompatibilityWindow(databaseUrl, cleanupScopeId)).rejects.toThrow(
            "still has active database sessions"
          );
        } finally {
          await legacy.end();
          legacyClosed = true;
        }
        expect(legacyClosed).toBe(true);

        await closeLumenNMinusOneCompatibilityWindow(databaseUrl, cleanupScopeId);
        expect(await readLumenNMinusOnePrivileges(databaseAdmin)).toEqual({
          auditInsert: false,
          auditUpdate: false,
          ledgerSelect: false,
          platformUsage: false,
          pulsoPatientSelect: false,
          pulsoUsage: false
        });
        expect(await readRoleCanLogin(databaseAdmin, "hyperion_lumen")).toBe(false);

        const fencedScope = `lumen-n1-ci-${randomUUID()}`;
        await expect(
          openLumenNMinusOneCompatibilityWindow(databaseUrl, {
            cleanupScopeId: fencedScope,
            rollbackEvidenceSha256: sha256("must not bypass a prior NOLOGIN fence")
          })
        ).rejects.toThrow("fully activated and validated service-role set");
        expect(await readRoleCanLogin(databaseAdmin, "hyperion_lumen")).toBe(false);
        const fencedWindow = await databaseAdmin.query(
          `select 1 from lumen.n_minus_one_compatibility_windows where cleanup_scope_id = $1`,
          [fencedScope]
        );
        expect(fencedWindow.rowCount).toBe(0);

        const databaseClock = await databaseAdmin.query<{ now: Date }>("select clock_timestamp() as now");
        const attestationId = randomUUID();
        const destructionEvidenceSha256 = sha256("container and tmpfs scope destroyed by CI orchestrator");
        await expect(
          attestDestroyedLegacyAudioScope(databaseUrl, {
            cleanupScopeId,
            attestationId: randomUUID(),
            destroyedAt: new Date(Date.now() + 60_000).toISOString(),
            evidenceSha256: destructionEvidenceSha256
          })
        ).rejects.toThrow("scope destruction time cannot be materially in the future");

        const attestation = await attestDestroyedLegacyAudioScope(databaseUrl, {
          cleanupScopeId,
          attestationId,
          destroyedAt: databaseClock.rows[0]!.now.toISOString(),
          evidenceSha256: destructionEvidenceSha256
        });
        expect(attestation).toEqual({ finalizedAttemptCount: 2, replay: false });
        await expect(
          attestDestroyedLegacyAudioScope(databaseUrl, {
            cleanupScopeId,
            attestationId,
            destroyedAt: databaseClock.rows[0]!.now.toISOString(),
            evidenceSha256: destructionEvidenceSha256
          })
        ).resolves.toEqual({ finalizedAttemptCount: 2, replay: true });

        const finalized = await databaseAdmin.query<{
          status: string;
          cleanupDisposition: string;
          count: number;
        }>(
          `select status, cleanup_disposition as "cleanupDisposition", count(*)::int as count
             from lumen.processing_attempts
            where cleanup_scope_id = $1
            group by status, cleanup_disposition
            order by cleanup_disposition`,
          [cleanupScopeId]
        );
        expect(finalized.rows).toEqual(
          expect.arrayContaining([
            { status: "completed", cleanupDisposition: "legacy_request_finalizer", count: 1 },
            { status: "failed", cleanupDisposition: "ephemeral_scope_destroyed", count: 2 }
          ])
        );
        const durableEvidence = await databaseAdmin.query(
          `select 1 from lumen.legacy_audio_scope_attestations
            where attestation_id = $1 and cleanup_scope_id = $2
              and evidence_sha256 = $3 and finalized_attempt_count = 2`,
          [attestationId, cleanupScopeId, destructionEvidenceSha256]
        );
        expect(durableEvidence.rowCount).toBe(1);

        // Only the all-role bootstrap may return current after close. A close
        // retry after that bootstrap must preserve LOGIN rather than fencing
        // LUMEN in isolation.
        await bootstrapDatabaseRoles(databaseUrl, serviceRolePasswords);
        expect(await readRoleCanLogin(databaseAdmin, "hyperion_lumen")).toBe(true);
        await expect(
          attestDestroyedLegacyAudioScope(databaseUrl, {
            cleanupScopeId,
            attestationId,
            destroyedAt: databaseClock.rows[0]!.now.toISOString(),
            evidenceSha256: destructionEvidenceSha256
          })
        ).rejects.toThrow("unsafe hyperion_lumen role state");
        const afterClose = new Client({ connectionString: lumenDatabaseUrl, application_name: cleanupScopeId });
        await afterClose.connect();
        try {
          await expect(
            insertOriginMainTranscriptionAttempt(afterClose, tenantId, encounterId, "after-close")
          ).rejects.toMatchObject({ code: "23514" });
          await expect(
            afterClose.query("select count(*) from lumen.n_minus_one_compatibility_windows")
          ).rejects.toMatchObject({ code: "42501" });
        } finally {
          await afterClose.end();
        }
        await closeLumenNMinusOneCompatibilityWindow(databaseUrl, cleanupScopeId);
        expect(await readRoleCanLogin(databaseAdmin, "hyperion_lumen")).toBe(true);

        // A normal current bootstrap replays migration 024, whose allow-list
        // intentionally excludes every temporary compatibility grant.
        const bootstrapScope = `lumen-n1-ci-${randomUUID()}`;
        await openLumenNMinusOneCompatibilityWindow(databaseUrl, {
          cleanupScopeId: bootstrapScope,
          rollbackEvidenceSha256: sha256("bootstrap revocation rehearsal")
        });
        expect((await readLumenNMinusOnePrivileges(databaseAdmin)).auditInsert).toBe(true);
        await applyServiceRolePrivilegeMatrix(databaseAdmin);
        expect(await readLumenNMinusOnePrivileges(databaseAdmin)).toEqual({
          auditInsert: false,
          auditUpdate: false,
          ledgerSelect: false,
          platformUsage: false,
          pulsoPatientSelect: false,
          pulsoUsage: false
        });
        const bootstrapReconciled = await databaseAdmin.query<{
          closeReason: string;
          closedBy: string;
        }>(
          `select close_reason as "closeReason", closed_by as "closedBy"
             from lumen.n_minus_one_compatibility_windows
            where cleanup_scope_id = $1 and closed_at is not null`,
          [bootstrapScope]
        );
        expect(bootstrapReconciled.rows[0]?.closeReason).toBe("bootstrap_reconciled");
        expect(bootstrapReconciled.rows[0]?.closedBy).toBeTruthy();
        await closeLumenNMinusOneCompatibilityWindow(databaseUrl, bootstrapScope);
        expect(await readRoleCanLogin(databaseAdmin, "hyperion_lumen")).toBe(true);

        const concurrentScopes = [`lumen-n1-ci-${randomUUID()}`, `lumen-n1-ci-${randomUUID()}`] as const;
        const concurrentOpen = await Promise.allSettled(
          concurrentScopes.map((scope, index) =>
            openLumenNMinusOneCompatibilityWindow(databaseUrl, {
              cleanupScopeId: scope,
              rollbackEvidenceSha256: sha256(`concurrent rollback ${index}`)
            })
          )
        );
        expect(concurrentOpen.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(concurrentOpen.filter((result) => result.status === "rejected")).toHaveLength(1);
        const soleOpenWindow = await databaseAdmin.query<{ cleanupScopeId: string }>(
          `select cleanup_scope_id as "cleanupScopeId"
             from lumen.n_minus_one_compatibility_windows
            where closed_at is null`
        );
        expect(soleOpenWindow.rowCount).toBe(1);
        expect(concurrentScopes).toContain(soleOpenWindow.rows[0]!.cleanupScopeId);
        expect((await readLumenNMinusOnePrivileges(databaseAdmin)).auditInsert).toBe(true);
        expect(await readRoleCanLogin(databaseAdmin, "hyperion_lumen")).toBe(true);

        const concurrentClose = await Promise.allSettled([
          closeLumenNMinusOneCompatibilityWindow(databaseUrl, soleOpenWindow.rows[0]!.cleanupScopeId),
          closeLumenNMinusOneCompatibilityWindow(databaseUrl, soleOpenWindow.rows[0]!.cleanupScopeId)
        ]);
        expect(concurrentClose.every((result) => result.status === "fulfilled")).toBe(true);
        const remainingOpenWindows = await databaseAdmin.query(
          `select 1 from lumen.n_minus_one_compatibility_windows where closed_at is null`
        );
        expect(remainingOpenWindows.rowCount).toBe(0);
        expect(await readLumenNMinusOnePrivileges(databaseAdmin)).toEqual({
          auditInsert: false,
          auditUpdate: false,
          ledgerSelect: false,
          platformUsage: false,
          pulsoPatientSelect: false,
          pulsoUsage: false
        });
        expect(await readRoleCanLogin(databaseAdmin, "hyperion_lumen")).toBe(false);
        await bootstrapDatabaseRoles(databaseUrl, serviceRolePasswords);
        expect(await readRoleCanLogin(databaseAdmin, "hyperion_lumen")).toBe(true);
      } finally {
        await databaseAdmin.end();
      }
    } finally {
      if (databaseCreated) await admin.query(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
    }
  }, 180_000);

  it("honors the migration lock budget before validating the phased CHECK constraints", async () => {
    const admin = new Client({ connectionString: TEST_DATABASE_URL });
    const databaseName = `hyperion_lumen_cleanup_lock_${randomUUID().replaceAll("-", "")}`;
    const databaseUrl = withDatabase(TEST_DATABASE_URL ?? "", databaseName);
    const phasedSqlDir = await mkdtemp(join(tmpdir(), "hyperion-lumen-031-"));
    const fullSqlDir = await mkdtemp(join(tmpdir(), "hyperion-lumen-full-"));
    let databaseCreated = false;

    await admin.connect();
    try {
      await admin.query(`create database "${databaseName}"`);
      databaseCreated = true;
      for (const file of await readdir(sqlDir)) {
        if (!file.endsWith(".sql")) continue;
        await copyFile(join(sqlDir, file), join(fullSqlDir, file));
        if (Number(file.slice(0, 3)) <= 31) await copyFile(join(sqlDir, file), join(phasedSqlDir, file));
      }
      await runMigrations(databaseUrl, phasedSqlDir);

      const blocker = new Client({ connectionString: databaseUrl });
      await blocker.connect();
      try {
        await blocker.query("begin");
        await blocker.query("lock table lumen.processing_attempts in access exclusive mode");
        await expect(
          runMigrations(databaseUrl, fullSqlDir, { lockTimeoutMs: 100, statementTimeoutMs: 5_000 })
        ).rejects.toMatchObject({ code: "55P03" });
        await blocker.query("rollback");
      } finally {
        await blocker.end();
      }

      await expect(
        runMigrations(databaseUrl, fullSqlDir, { lockTimeoutMs: 5_000, statementTimeoutMs: 30_000 })
      ).resolves.toMatchObject({
        applied: expect.arrayContaining([
          "032-lumen-audio-cleanup-contract.sql",
          "033-lumen-audio-cleanup-index.sql",
          "039-lumen-unresolved-cleanup-owner-index.sql"
        ])
      });
    } finally {
      await rm(phasedSqlDir, { recursive: true, force: true });
      await rm(fullSqlDir, { recursive: true, force: true });
      if (databaseCreated) await admin.query(`drop database if exists "${databaseName}" with (force)`);
      await admin.end();
    }
  }, 120_000);
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createLumenFixture(
  client: pg.Client,
  suffix: string
): Promise<{ tenantId: string; encounterId: string }> {
  const tenantId = (
    await client.query<{ id: string }>(
      `insert into platform.tenants (slug, display_name, status)
       values ($1, 'LUMEN N-1 compatibility', 'active') returning id`,
      [`lumen-n1-${suffix}-${randomUUID()}`]
    )
  ).rows[0]!.id;
  await client.query(
    `insert into lumen.tenant_snapshots (
       tenant_id, status, is_demo, is_active, source_version, source_updated_at, payload_hash
     ) values ($1, 'active', true, true, 1, now(), $2)`,
    [tenantId, sha256(`tenant:${tenantId}:1`)]
  );
  const encounterId = randomUUID();
  const patientId = randomUUID();
  const siteId = randomUUID();
  const professionalId = randomUUID();
  await client.query(
    `insert into lumen.encounter_reference_snapshots (
       tenant_id, encounter_id, patient_id, site_id, professional_id,
       patient_display_name, professional_name, site_name,
       patient_is_demo, professional_is_demo, source_version, source_updated_at, payload_hash
     ) values ($1, $2, $3, $4, $5, 'Paciente sintético', 'Profesional sintético',
               'Sede sintética', true, true, 1, now(), $6)`,
    [tenantId, encounterId, patientId, siteId, professionalId, sha256(`reference:${encounterId}:1`)]
  );
  await client.query(
    `insert into lumen.encounters (
       id, tenant_id, patient_id, professional_id, site_id, scheduled_at,
       is_demo, demo_key, metadata
     ) values ($1, $2, $3, $4, $5, now(), true, $6, '{"synthetic":true}'::jsonb)`,
    [encounterId, tenantId, patientId, professionalId, siteId, `n1-${randomUUID()}`]
  );
  return { tenantId, encounterId };
}

/** SQL is intentionally kept byte-for-byte equivalent in shape to origin/main. */
async function insertOriginMainTranscriptionAttempt(
  client: pg.Client,
  tenantId: string,
  encounterId: string,
  label: string
): Promise<string> {
  return (
    await client.query<{ id: string }>(
      `insert into lumen.processing_attempts
         (tenant_id, encounter_id, operation, idempotency_key, input_sha256,
          provider, model, mime_type, source, duration_seconds)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (tenant_id, encounter_id, operation, idempotency_key) do nothing
       returning id`,
      [
        tenantId,
        encounterId,
        "transcription",
        randomUUID(),
        sha256(`synthetic-audio:${label}`),
        "test-stt",
        "test-model",
        "audio/wav",
        "authorized_upload",
        8
      ]
    )
  ).rows[0]!.id;
}

async function readLumenNMinusOnePrivileges(client: pg.Client): Promise<{
  auditInsert: boolean;
  auditUpdate: boolean;
  ledgerSelect: boolean;
  platformUsage: boolean;
  pulsoPatientSelect: boolean;
  pulsoUsage: boolean;
}> {
  return (
    await client.query<{
      auditInsert: boolean;
      auditUpdate: boolean;
      ledgerSelect: boolean;
      platformUsage: boolean;
      pulsoPatientSelect: boolean;
      pulsoUsage: boolean;
    }>(
      `select
         has_table_privilege('hyperion_lumen', 'platform.audit_events', 'INSERT') as "auditInsert",
         has_table_privilege('hyperion_lumen', 'platform.audit_events', 'UPDATE') as "auditUpdate",
         has_table_privilege('hyperion_lumen', 'platform.schema_migrations', 'SELECT') as "ledgerSelect",
         has_schema_privilege('hyperion_lumen', 'platform', 'USAGE') as "platformUsage",
         has_table_privilege(
           'hyperion_lumen', 'pulso_iris.administrative_patients', 'SELECT'
         ) as "pulsoPatientSelect",
         has_schema_privilege('hyperion_lumen', 'pulso_iris', 'USAGE') as "pulsoUsage"`
    )
  ).rows[0]!;
}

async function readRoleCanLogin(client: pg.Client, role: string): Promise<boolean> {
  return (
    await client.query<{ canLogin: boolean }>(`select rolcanlogin as "canLogin" from pg_roles where rolname = $1`, [
      role
    ])
  ).rows[0]!.canLogin;
}

function withDatabase(baseUrl: string, databaseName: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function withCredentials(baseUrl: string, username: string, password: string): string {
  const parsed = new URL(baseUrl);
  parsed.username = username;
  parsed.password = password;
  return parsed.toString();
}
