import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { dispatchCampaignBatch } from "./campaign-orchestrator.js";
import { authorizeVoiceCall } from "./voice-authorization.js";
import { computeVoicePolicySha256, type RevisionedVoicePolicy } from "./voice-policy.js";

const databaseUrl = process.env.TEST_NOVA_DATABASE_URL?.trim();
const migratorUrl = process.env.TEST_NOVA_MIGRATOR_DATABASE_URL?.trim();
const integration = databaseUrl && migratorUrl ? describe : describe.skip;

integration("campaign orchestrator PostgreSQL lifecycle", () => {
  let first: DatabaseClient;
  let second: DatabaseClient;
  let migrator: DatabaseClient;
  const tenantId = randomUUID();
  const campaignId = randomUUID();
  const contacts = [randomUUID(), randomUUID(), randomUUID()];
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
    maxConcurrentCalls: 10,
    minHoursBetweenAttempts: 0,
    respectHolidays: false
  };
  const destinations = {
    voice: "http://voice.test/internal/events",
    audit: "http://audit.test/internal/events"
  };

  beforeAll(async () => {
    first = createDatabase(databaseUrl!);
    second = createDatabase(databaseUrl!);
    migrator = createDatabase(migratorUrl!);
    await first.query(
      `insert into nova.tenant_snapshots
         (tenant_id, status, display_name, source_version, source_updated_at, payload_hash)
       values ($1, 'active', 'Campaign orchestration integration', 1, now(), $2)`,
      [tenantId, createHash("sha256").update(tenantId).digest("hex")]
    );
    for (let index = 0; index < contacts.length; index += 1) {
      await first.query(
        `insert into nova.contacts (tenant_id, contact_id, phone_e164, full_name)
         values ($1, $2, $3, $4)`,
        [tenantId, contacts[index], `+57300123456${index}`, `Campaign Contact ${index}`]
      );
    }
    await first.query(
      `insert into nova.compliance_settings (
         tenant_id, window_start_hour, window_end_hour, time_zone, allowed_weekdays,
         voice_enabled, whatsapp_enabled, max_attempts_per_day, max_attempts_per_contact,
         rolling_window_days, max_concurrent_calls, min_hours_between_attempts, respect_holidays
       ) values ($1, 0, 24, 'America/Bogota', array[1,2,3,4,5,6,7]::smallint[],
                 true, false, 20, 20, 7, 10, 0, false)`,
      [tenantId]
    );
    await first.query(
      `insert into nova.campaigns (tenant_id, campaign_id, name, channel, product_flow, status)
       values ($1, $2, 'Campaign integration', 'voice', 'renovacion', 'running')`,
      [tenantId, campaignId]
    );
    await first.query(
      `insert into nova.campaign_enrollments (tenant_id, campaign_id, contact_id, status)
       values ($1, $2, $3, 'enrolled'), ($1, $2, $4, 'enrolled')`,
      [tenantId, campaignId, contacts[0], contacts[1]]
    );
    await migrator.query(
      `insert into nova.voice_policy_approvals (
         tenant_id, policy_revision, policy_sha256, approved_by, approval_receipt_sha256,
         approval_signature_sha256, signer_key_sha256, expires_at
       ) values ($1, 1, $2, 'integration-test', $3, $4, $5, now() + interval '1 day')`,
      [tenantId, computeVoicePolicySha256(policy), "a".repeat(64), "b".repeat(64), "c".repeat(64)]
    );
    await migrator.query(
      `insert into nova.exclusion_registry_runs (
         tenant_id, run_id, source, status, completed_at, valid_until,
         source_receipt_sha256, source_signature_sha256, signer_key_sha256,
         record_count, imported_by
       ) values ($1, $2, 'integration-test', 'ready', now(), now() + interval '1 day', $3, $4, $5, 0, 'integration-test')`,
      [tenantId, randomUUID(), "d".repeat(64), "e".repeat(64), "f".repeat(64)]
    );
    await migrator.query(
      `insert into nova.voice_cutover_receipts (
         tenant_id, gate_name, subject_ref, scope_sha256, receipt_sha256,
         signature_sha256, signer_key_sha256, attested_by, expires_at
       )
       select $1, gate_name, case when gate_name = 'consented_test_call' then $2 else gate_name end,
              $3, $4, $5, $6, 'integration-test', now() + interval '1 day'
         from unnest($7::text[]) gate_name`,
      [
        tenantId,
        randomUUID(),
        "e".repeat(64),
        "f".repeat(64),
        "1".repeat(64),
        "2".repeat(64),
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
  });

  afterAll(async () => {
    await migrator.query("delete from nova.tenant_snapshots where tenant_id = $1", [tenantId]);
    await Promise.all([first.close(), second.close(), migrator.close()]);
  });

  it("serializes two workers without duplicate enrollment dispatch", async () => {
    const results = await Promise.all([
      dispatchCampaignBatch(first, tenantId, campaignId, destinations, 1),
      dispatchCampaignBatch(second, tenantId, campaignId, destinations, 1)
    ]);
    expect(results.map(({ queued }) => queued).sort()).toEqual([1, 1]);
    const attempts = await first.query<{ count: string; contacts: string }>(
      `select count(*)::text as count, count(distinct contact_id)::text as contacts
         from nova.contact_attempts where tenant_id = $1 and campaign_id = $2`,
      [tenantId, campaignId]
    );
    expect(attempts.rows[0]).toEqual({ count: "2", contacts: "2" });
  });

  it("does not dispatch while paused and rolls back a crashed reservation", async () => {
    await first.query(
      `insert into nova.campaign_enrollments (tenant_id, campaign_id, contact_id, status)
       values ($1, $2, $3, 'enrolled')`,
      [tenantId, campaignId, contacts[2]]
    );
    await first.query("update nova.campaigns set status = 'paused' where tenant_id = $1 and campaign_id = $2", [
      tenantId,
      campaignId
    ]);
    await expect(dispatchCampaignBatch(first, tenantId, campaignId, destinations)).resolves.toMatchObject({
      status: "not_running",
      queued: 0
    });

    await first.query("update nova.campaigns set status = 'running' where tenant_id = $1 and campaign_id = $2", [
      tenantId,
      campaignId
    ]);
    await expect(
      first.transaction(async (tx) => {
        const result = await authorizeVoiceCall(tx, {
          tenantId,
          contactId: contacts[2]!,
          campaignId,
          productFlow: "renovacion",
          voiceDestination: destinations.voice,
          auditDestination: destinations.audit
        });
        expect(result.status).toBe("authorized");
        throw new Error("simulated_worker_crash");
      })
    ).rejects.toThrow("simulated_worker_crash");

    const rolledBack = await first.query<{ status: string; attemptCount: number }>(
      `select status, attempt_count as "attemptCount" from nova.campaign_enrollments
        where tenant_id = $1 and campaign_id = $2 and contact_id = $3`,
      [tenantId, campaignId, contacts[2]]
    );
    expect(rolledBack.rows[0]).toEqual({ status: "enrolled", attemptCount: 0 });
    await expect(dispatchCampaignBatch(first, tenantId, campaignId, destinations, 1)).resolves.toMatchObject({
      queued: 1
    });
  });

  it("completes only after no dispatchable or in-flight enrollment remains", async () => {
    await first.query(
      `update nova.campaign_enrollments set status = 'reached'
        where tenant_id = $1 and campaign_id = $2`,
      [tenantId, campaignId]
    );
    await dispatchCampaignBatch(first, tenantId, campaignId, destinations, 10);
    const campaign = await first.query<{ status: string }>(
      "select status from nova.campaigns where tenant_id = $1 and campaign_id = $2",
      [tenantId, campaignId]
    );
    expect(campaign.rows[0]?.status).toBe("completed");
  });
});
