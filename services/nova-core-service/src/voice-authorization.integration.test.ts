import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { authorizeVoiceCall } from "./voice-authorization.js";
import { computeVoicePolicySha256, type RevisionedVoicePolicy } from "./voice-policy.js";

const databaseUrl = process.env.TEST_NOVA_DATABASE_URL?.trim() ?? process.env.DATABASE_URL?.trim();
const migratorUrl = process.env.TEST_NOVA_MIGRATOR_DATABASE_URL?.trim();
const describeDatabase = databaseUrl && migratorUrl ? describe : describe.skip;

describeDatabase("voice authorization PostgreSQL boundary", () => {
  let firstRuntime: DatabaseClient;
  let secondRuntime: DatabaseClient;
  let migrator: DatabaseClient;
  const tenantId = randomUUID();
  const firstContactId = randomUUID();
  const secondContactId = randomUUID();
  const runId = randomUUID();
  const at = new Date("2026-07-21T15:00:00.000Z");
  const policy: RevisionedVoicePolicy = {
    policyRevision: 1,
    windowStartHour: 0,
    windowEndHour: 24,
    timeZone: "America/Bogota",
    allowedWeekdays: [1, 2, 3, 4, 5, 6, 7],
    voiceEnabled: true,
    whatsappEnabled: false,
    maxAttemptsPerDay: 20,
    maxAttemptsPerContact: 20,
    rollingWindowDays: 7,
    maxConcurrentCalls: 1,
    minHoursBetweenAttempts: 0,
    respectHolidays: false
  };

  beforeAll(async () => {
    firstRuntime = createDatabase(databaseUrl!);
    secondRuntime = createDatabase(databaseUrl!);
    migrator = createDatabase(migratorUrl!);
    const hash = createHash("sha256").update(tenantId).digest("hex");
    await firstRuntime.query(
      `insert into nova.tenant_snapshots
         (tenant_id, status, display_name, source_version, source_updated_at, payload_hash)
       values ($1, 'active', 'Voice authorization integration', 1, now(), $2)`,
      [tenantId, hash]
    );
    await firstRuntime.query(
      `insert into nova.contacts (tenant_id, contact_id, phone_e164, full_name, agency_code)
       values ($1, $2, '+573001234567', 'Prueba Uno', 'BGA'),
              ($1, $3, '+573007654321', 'Prueba Dos', 'BOG')`,
      [tenantId, firstContactId, secondContactId]
    );
    await firstRuntime.query(
      `insert into nova.compliance_settings (
         tenant_id, window_start_hour, window_end_hour, time_zone, allowed_weekdays,
         voice_enabled, whatsapp_enabled, max_attempts_per_day, max_attempts_per_contact,
         rolling_window_days, max_concurrent_calls, min_hours_between_attempts, respect_holidays
       ) values ($1, $2, $3, $4, $5::smallint[], $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        tenantId,
        policy.windowStartHour,
        policy.windowEndHour,
        policy.timeZone,
        policy.allowedWeekdays,
        policy.voiceEnabled,
        policy.whatsappEnabled,
        policy.maxAttemptsPerDay,
        policy.maxAttemptsPerContact,
        policy.rollingWindowDays,
        policy.maxConcurrentCalls,
        policy.minHoursBetweenAttempts,
        policy.respectHolidays
      ]
    );
  });

  afterAll(async () => {
    await migrator.query(`delete from nova.tenant_snapshots where tenant_id = $1`, [tenantId]);
    await Promise.all([firstRuntime.close(), secondRuntime.close(), migrator.close()]);
  });

  it("fails closed without a current approval and complete exclusion snapshot", async () => {
    const noApproval = await authorize(firstRuntime, firstContactId);
    expectBlocked(noApproval, "voice_policy_unapproved");

    await migrator.query(
      `insert into nova.voice_policy_approvals (
         tenant_id, policy_revision, policy_sha256, approved_by, approval_receipt_sha256,
         approval_signature_sha256, signer_key_sha256, expires_at
       ) values ($1, 1, $2, 'integration-test', $3, $4, $5, '2026-07-30T00:00:00.000Z')`,
      [tenantId, computeVoicePolicySha256(policy), "a".repeat(64), "b".repeat(64), "c".repeat(64)]
    );
    const noRegistry = await authorize(firstRuntime, firstContactId);
    expectBlocked(noRegistry, "exclusion_registry_unavailable");

    await migrator.query(
      `insert into nova.exclusion_registry_runs (
         tenant_id, run_id, source, status, completed_at, valid_until,
         source_receipt_sha256, source_signature_sha256, signer_key_sha256,
         record_count, imported_by
       ) values ($1, $2, 'integration-test', 'ready', $3::timestamptz,
                 $4::timestamptz, $5, $6, $7, 1, 'integration-test')`,
      [
        tenantId,
        runId,
        "2026-07-20T00:00:00.000Z",
        "2026-07-21T14:00:00.000Z",
        "d".repeat(64),
        "e".repeat(64),
        "f".repeat(64)
      ]
    );
    const staleRegistry = await authorize(firstRuntime, firstContactId);
    expectBlocked(staleRegistry, "exclusion_registry_stale");

    await migrator.query(
      `update nova.exclusion_registry_runs set valid_until = '2026-07-22T00:00:00.000Z'
        where tenant_id = $1 and run_id = $2`,
      [tenantId, runId]
    );
    await migrator.query(
      `insert into nova.exclusion_registry_entries (tenant_id, run_id, phone_e164, reason)
       values ($1, $2, '+573001234567', 'integration-test')`,
      [tenantId, runId]
    );
    const excluded = await authorize(firstRuntime, firstContactId);
    expectBlocked(excluded, "exclusion_registry_match");
    await migrator.query(`delete from nova.exclusion_registry_entries where tenant_id = $1 and run_id = $2`, [
      tenantId,
      runId
    ]);

    const noCutover = await authorize(firstRuntime, firstContactId);
    expectBlocked(noCutover, "voice_cutover_not_ready");
    await installCutoverReceipts(
      migrator,
      tenantId,
      "c".repeat(64),
      "2026-07-20T00:00:00.000Z",
      "2026-07-30T00:00:00.000Z"
    );
  });

  it("serializes two real connections and authorizes exactly one call at the concurrency limit", async () => {
    const results = await Promise.all([
      authorize(firstRuntime, firstContactId),
      authorize(secondRuntime, secondContactId)
    ]);
    expect(results.filter((result) => result.status === "authorized")).toHaveLength(1);
    const blocked = results.find((result) => result.status === "blocked");
    expectBlocked(blocked, "max_concurrent_calls");

    const attempts = await firstRuntime.query<{ count: string }>(
      `select count(*)::text as count from nova.contact_attempts where tenant_id = $1`,
      [tenantId]
    );
    const requests = await firstRuntime.query<{ count: string }>(
      `select count(*)::text as count from nova.outbox_events
        where tenant_id = $1 and event_type = 'voice.call.requested.v2'`,
      [tenantId]
    );
    expect(Number(attempts.rows[0]?.count)).toBe(1);
    expect(Number(requests.rows[0]?.count)).toBe(1);
  });

  it("invalidates the prior approval when a dispatch policy field changes", async () => {
    await firstRuntime.query(`update nova.compliance_settings set max_concurrent_calls = 2 where tenant_id = $1`, [
      tenantId
    ]);
    const revision = await firstRuntime.query<{ policyRevision: string }>(
      `select policy_revision::text as "policyRevision" from nova.compliance_settings where tenant_id = $1`,
      [tenantId]
    );
    expect(revision.rows[0]?.policyRevision).toBe("2");
    await expect(
      firstRuntime.query(`update nova.compliance_settings set policy_revision = 1 where tenant_id = $1`, [tenantId])
    ).rejects.toMatchObject({ code: "P0001" });
    const result = await authorize(firstRuntime, secondContactId);
    expectBlocked(result, "voice_policy_unapproved");
  });

  function authorize(db: DatabaseClient, contactId: string) {
    return db.transaction((tx) =>
      authorizeVoiceCall(tx, {
        tenantId,
        contactId,
        productFlow: "renovacion",
        voiceDestination: "http://voice.test/internal/events",
        auditDestination: "http://audit.test/internal/events",
        at
      })
    );
  }
});

function expectBlocked(result: Awaited<ReturnType<typeof authorizeVoiceCall>> | undefined, reason: string): void {
  expect(result?.status).toBe("blocked");
  if (result?.status === "blocked") expect(result.snapshot.decision.reason).toBe(reason);
}

async function installCutoverReceipts(
  db: DatabaseClient,
  tenantId: string,
  scopeSha256: string,
  attestedAt: string,
  expiresAt: string
): Promise<void> {
  await db.query(
    `insert into nova.voice_cutover_receipts (
       tenant_id, gate_name, subject_ref, scope_sha256, receipt_sha256,
       signature_sha256, signer_key_sha256, attested_by, attested_at, expires_at
     )
     select $1, gate_name, case when gate_name = 'consented_test_call' then $2 else gate_name end,
            $3, $4, $5, $6, 'integration-test', $7::timestamptz, $8::timestamptz
       from unnest($9::text[]) gate_name`,
    [
      tenantId,
      randomUUID(),
      scopeSha256,
      "1".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
      attestedAt,
      expiresAt,
      [
        "retention_policy",
        "monitoring_on_call",
        "coordinated_recovery",
        "release_artifact",
        "provider_connectivity",
        "consented_test_call"
      ]
    ]
  );
}
