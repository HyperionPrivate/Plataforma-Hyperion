import { randomUUID } from "node:crypto";
import { contactEligibilityDecidedPayloadSchema, voiceCallRequestedV2PayloadSchema } from "@hyperion/nova-contracts";
import type { DatabaseExecutor } from "@hyperion/database";
import { decideEligibility, DEFAULT_COMPLIANCE, type ComplianceSettings, type EligibilityResult } from "./domain.js";
import { insertNovaAuditOutboxEvent, insertNovaOutboxEvent } from "./outbox.js";
import { computeVoicePolicySha256, type RevisionedVoicePolicy } from "./voice-policy.js";

interface LockedContact {
  phoneE164: string;
  fullName: string | null;
  agencyCode: string | null;
  university: string | null;
  city: string | null;
  voiceSuppressedAt: Date | null;
  optedOut: boolean;
}

interface StoredComplianceSettings {
  windowStartHour: number;
  windowEndHour: number;
  timeZone: string;
  allowedWeekdays: number[];
  voiceEnabled: boolean;
  whatsappEnabled: boolean;
  maxAttemptsPerDay: number;
  maxAttemptsPerContact: number;
  rollingWindowDays: number;
  maxConcurrentCalls: number;
  minHoursBetweenAttempts: number;
  respectHolidays: boolean;
  policyRevision: number;
}

const REQUIRED_CUTOVER_GATES = [
  "retention_policy",
  "monitoring_on_call",
  "coordinated_recovery",
  "release_artifact",
  "provider_connectivity",
  "consented_test_call"
] as const;

export interface VoiceEligibilitySnapshot {
  contactId: string;
  phoneE164: string;
  fullName: string | null;
  agencyCode: string | null;
  university: string | null;
  city: string | null;
  decision: EligibilityResult;
  settings: ComplianceSettings;
  attemptsToday: number;
  attemptsInRollingWindow: number;
  hoursSinceLastAttempt: number | null;
  activeVoiceCalls: number;
  cutoverTestCorrelationId: string | null;
}

export interface VoiceAuthorizationOptions {
  tenantId: string;
  contactId: string;
  campaignId?: string;
  productFlow?: string;
  voiceDestination: string;
  auditDestination: string;
  at?: Date;
}

export type VoiceAuthorizationResult =
  | { status: "authorized"; callId: string; correlationId: string; snapshot: VoiceEligibilitySnapshot }
  | { status: "blocked"; snapshot: VoiceEligibilitySnapshot }
  | { status: "contact_not_found" };

/**
 * Must run inside the caller's transaction. The contact row is the serialization
 * lock shared by manual and campaign dispatch, so two workers cannot reserve the
 * same contact past a frequency gate concurrently.
 */
export async function evaluateVoiceEligibility(
  db: DatabaseExecutor,
  tenantId: string,
  contactId: string,
  at: Date = new Date()
): Promise<VoiceEligibilitySnapshot | null> {
  await db.query(`select pg_advisory_xact_lock(hashtext($1))`, [`nova:voice-dispatch:${tenantId}`]);
  const contact = await db.query<LockedContact>(
    `select phone_e164 as "phoneE164", opted_out as "optedOut",
            full_name as "fullName", agency_code as "agencyCode",
            universidad as university, ciudad as city,
            voice_suppressed_at as "voiceSuppressedAt"
       from nova.contacts
      where tenant_id = $1 and contact_id = $2
      for update`,
    [tenantId, contactId]
  );
  const row = contact.rows[0];
  if (!row) return null;

  const stored = await db.query<StoredComplianceSettings>(
    `select window_start_hour as "windowStartHour",
            window_end_hour as "windowEndHour",
            time_zone as "timeZone",
            allowed_weekdays as "allowedWeekdays",
            voice_enabled as "voiceEnabled",
            whatsapp_enabled as "whatsappEnabled",
            max_attempts_per_day as "maxAttemptsPerDay",
            max_attempts_per_contact as "maxAttemptsPerContact",
            rolling_window_days as "rollingWindowDays",
            max_concurrent_calls as "maxConcurrentCalls",
            min_hours_between_attempts as "minHoursBetweenAttempts",
            respect_holidays as "respectHolidays",
            policy_revision as "policyRevision"
       from nova.compliance_settings
      where tenant_id = $1`,
    [tenantId]
  );
  const storedRow = stored.rows[0];
  const storedSettings = storedRow ? { ...storedRow, policyRevision: Number(storedRow.policyRevision) } : undefined;
  const settings: ComplianceSettings = storedSettings ?? DEFAULT_COMPLIANCE;

  const tenant = await db.query<{ status: string }>(`select status from nova.tenant_snapshots where tenant_id = $1`, [
    tenantId
  ]);
  if (tenant.rows[0]?.status !== "active") {
    return blockedSnapshot(contactId, row, settings, "tenant_inactive");
  }
  if (!storedSettings) {
    return blockedSnapshot(contactId, row, settings, "voice_policy_missing");
  }

  if (!isUsableTimeZone(settings.timeZone)) {
    return blockedSnapshot(contactId, row, settings, "invalid_time_zone");
  }

  const policySha256 = computeVoicePolicySha256(storedSettings as RevisionedVoicePolicy);
  const approval = await db.query<{ policySha256: string }>(
    `select policy_sha256 as "policySha256"
       from nova.voice_policy_approvals
      where tenant_id = $1 and policy_revision = $2 and status = 'approved'
        and (expires_at is null or expires_at > $3::timestamptz)`,
    [tenantId, storedSettings.policyRevision, at.toISOString()]
  );
  if (!approval.rows[0]) {
    return blockedSnapshot(contactId, row, settings, "voice_policy_unapproved");
  }
  if (approval.rows[0].policySha256 !== policySha256) {
    return blockedSnapshot(contactId, row, settings, "voice_policy_hash_mismatch");
  }

  const exclusionRun = await db.query<{ runId: string; validUntil: Date }>(
    `select run_id as "runId", valid_until as "validUntil"
       from nova.exclusion_registry_runs
      where tenant_id = $1 and status = 'ready'
      order by completed_at desc
      limit 1`,
    [tenantId]
  );
  const currentExclusionRun = exclusionRun.rows[0];
  if (!currentExclusionRun) {
    return blockedSnapshot(contactId, row, settings, "exclusion_registry_unavailable");
  }
  if (new Date(currentExclusionRun.validUntil).getTime() <= at.getTime()) {
    return blockedSnapshot(contactId, row, settings, "exclusion_registry_stale");
  }
  const exclusion = await db.query(
    `select 1 from nova.exclusion_registry_entries
      where tenant_id = $1 and run_id = $2 and phone_e164 = $3 limit 1`,
    [tenantId, currentExclusionRun.runId, row.phoneE164]
  );
  if ((exclusion.rowCount ?? 0) > 0) {
    return blockedSnapshot(contactId, row, settings, "exclusion_registry_match");
  }

  const cutover = await db.query<{ testCorrelationId: string }>(
    `select scope_sha256,
            max(subject_ref) filter (where gate_name = 'consented_test_call') as "testCorrelationId"
       from nova.voice_cutover_receipts
      where tenant_id = $1 and status = 'current' and expires_at > $2::timestamptz
      group by scope_sha256
     having count(distinct gate_name) = $3
      limit 1`,
    [tenantId, at.toISOString(), REQUIRED_CUTOVER_GATES.length]
  );
  if ((cutover.rowCount ?? 0) === 0) {
    return blockedSnapshot(contactId, row, settings, "voice_cutover_not_ready");
  }
  const testCorrelationId = cutover.rows[0]?.testCorrelationId;
  const usedTestCorrelation = testCorrelationId
    ? await db.query(
        `select 1 from nova.outbox_events
          where tenant_id = $1 and correlation_id::text = lower($2) limit 1`,
        [tenantId, testCorrelationId]
      )
    : undefined;
  const cutoverTestCorrelationId = (usedTestCorrelation?.rowCount ?? 0) === 0 ? (testCorrelationId ?? null) : null;

  // A transaction executor owns one PostgreSQL connection. Keep these queries
  // sequential: pg rejects concurrent query dispatch on one client in pg@9.
  const suppression = await db.query(`select 1 from nova.opt_outs where tenant_id = $1 and phone_e164 = $2 limit 1`, [
    tenantId,
    row.phoneE164
  ]);
  const holiday = await db.query(
    `select 1
         from (
           select holiday_date from nova.holidays
           union all
           select holiday_date from nova.tenant_holidays where tenant_id = $1
         ) h
        where h.holiday_date = timezone($2, $3::timestamptz)::date
        limit 1`,
    [tenantId, settings.timeZone, at.toISOString()]
  );
  const attempts = await db.query<{ attemptsToday: string; rollingCount: string; hoursSinceLast: string | null }>(
    `select count(*) filter (
                where timezone($3, created_at)::date = timezone($3, $4::timestamptz)::date
              )::text as "attemptsToday",
              count(*) filter (
                where created_at >= $4::timestamptz - make_interval(days => $5)
              )::text as "rollingCount",
              extract(epoch from ($4::timestamptz - max(created_at))) / 3600 as "hoursSinceLast"
         from nova.contact_attempts
        where tenant_id = $1 and contact_id = $2 and channel = 'voice'`,
    [tenantId, contactId, settings.timeZone, at.toISOString(), settings.rollingWindowDays]
  );
  const activeCalls = await db.query<{ count: string }>(
    `select count(*)::text as count
         from nova.contact_attempts
        where tenant_id = $1 and channel = 'voice' and status in ('queued', 'dispatched')`,
    [tenantId]
  );

  const frequency = attempts.rows[0];
  const attemptsToday = Number(frequency?.attemptsToday ?? 0);
  const attemptsInRollingWindow = Number(frequency?.rollingCount ?? 0);
  const hoursSinceLastAttempt = frequency?.hoursSinceLast == null ? null : Number(frequency.hoursSinceLast);
  const activeVoiceCalls = Number(activeCalls.rows[0]?.count ?? 0);
  const decision = decideEligibility({
    optedOut: row.optedOut || (suppression.rowCount ?? 0) > 0,
    at,
    channel: "voice",
    settings,
    isHoliday: (holiday.rowCount ?? 0) > 0,
    attemptsToday,
    attemptCount: attemptsInRollingWindow,
    hoursSinceLastAttempt,
    activeVoiceCalls,
    voiceSuppressed: row.voiceSuppressedAt !== null
  });

  return {
    contactId,
    phoneE164: row.phoneE164,
    fullName: row.fullName,
    agencyCode: row.agencyCode,
    university: row.university,
    city: row.city,
    decision,
    settings,
    attemptsToday,
    attemptsInRollingWindow,
    hoursSinceLastAttempt,
    activeVoiceCalls,
    cutoverTestCorrelationId
  };
}

function blockedSnapshot(
  contactId: string,
  row: LockedContact,
  settings: ComplianceSettings,
  reason: string
): VoiceEligibilitySnapshot {
  return {
    contactId,
    phoneE164: row.phoneE164,
    fullName: row.fullName,
    agencyCode: row.agencyCode,
    university: row.university,
    city: row.city,
    decision: { eligibility: "blocked_policy", reason },
    settings,
    attemptsToday: 0,
    attemptsInRollingWindow: 0,
    hoursSinceLastAttempt: null,
    activeVoiceCalls: 0,
    cutoverTestCorrelationId: null
  };
}

export async function authorizeVoiceCall(
  db: DatabaseExecutor,
  options: VoiceAuthorizationOptions
): Promise<VoiceAuthorizationResult> {
  const snapshot = await evaluateVoiceEligibility(db, options.tenantId, options.contactId, options.at);
  if (!snapshot) return { status: "contact_not_found" };

  await db.query(
    `update nova.contacts set eligibility = $3, updated_at = now()
      where tenant_id = $1 and contact_id = $2`,
    [options.tenantId, options.contactId, snapshot.decision.eligibility]
  );

  const correlationId = snapshot.cutoverTestCorrelationId ?? randomUUID();
  const eligibilityPayload = contactEligibilityDecidedPayloadSchema.parse({
    contact_id: options.contactId,
    ...snapshot.decision
  });
  await insertNovaAuditOutboxEvent(db, {
    eventId: randomUUID(),
    domainEventType: "contact.eligibility.decided",
    entityType: "contact",
    entityId: options.contactId,
    tenantId: options.tenantId,
    correlationId,
    businessIdempotencyKey: `eligibility:${options.tenantId}:${options.contactId}:${correlationId}`,
    payload: eligibilityPayload,
    destination: options.auditDestination
  });

  if (snapshot.decision.eligibility !== "eligible") {
    if (options.campaignId) {
      const nextAttemptAt = nextEligibilityCheckAt(options.at ?? new Date(), snapshot);
      await db.query(
        `update nova.campaign_enrollments
            set status = case when $4 = 'blocked_opt_out' then 'opted_out' else status end,
                next_attempt_at = $5,
                last_block_reason = $6,
                updated_at = now()
          where tenant_id = $1 and campaign_id = $2 and contact_id = $3
            and status in ('enrolled', 'failed')`,
        [
          options.tenantId,
          options.campaignId,
          options.contactId,
          snapshot.decision.eligibility,
          nextAttemptAt,
          snapshot.decision.reason ?? snapshot.decision.eligibility
        ]
      );
    }
    return { status: "blocked", snapshot };
  }

  const callId = randomUUID();
  const attemptId = randomUUID();
  if (options.campaignId) {
    const reserved = await db.query(
      `update nova.campaign_enrollments e
          set status = 'attempted',
              attempt_count = attempt_count + 1,
              last_attempt_at = coalesce($4::timestamptz, now()),
              next_attempt_at = null,
              last_block_reason = null,
              updated_at = now()
         from nova.campaigns c
        where e.tenant_id = $1 and e.campaign_id = $2 and e.contact_id = $3
          and e.status in ('enrolled', 'failed')
          and c.tenant_id = e.tenant_id and c.campaign_id = e.campaign_id
          and c.status = 'running' and c.channel in ('voice', 'mixed')
        returning e.contact_id`,
      [options.tenantId, options.campaignId, options.contactId, options.at?.toISOString() ?? null]
    );
    if ((reserved.rowCount ?? 0) === 0) throw new Error("campaign_enrollment_not_dispatchable");
  }

  await db.query(
    `insert into nova.contact_attempts
       (tenant_id, attempt_id, contact_id, channel, campaign_id, call_id, status, created_at)
     values ($1, $2, $3, 'voice', $4, $5, 'queued', coalesce($6::timestamptz, now()))`,
    [
      options.tenantId,
      attemptId,
      options.contactId,
      options.campaignId ?? null,
      callId,
      options.at?.toISOString() ?? null
    ]
  );

  const callPayload = voiceCallRequestedV2PayloadSchema.parse({
    call_id: callId,
    contact_id: options.contactId,
    phone_e164: snapshot.phoneE164,
    campaign_id: options.campaignId,
    product_flow: options.productFlow,
    dynamic_vars: {
      nombre: firstSpokenName(snapshotContactValue(snapshot, "fullName", "Asociado")),
      agencia: snapshotContactValue(snapshot, "agencyCode", "su sede"),
      universidad: snapshotContactValue(snapshot, "university", "su universidad"),
      ciudad: snapshotContactValue(snapshot, "city", "su ciudad"),
      ...(options.productFlow ? { product_flow: options.productFlow } : {})
    }
  });
  await insertNovaOutboxEvent(db, {
    eventId: randomUUID(),
    eventType: "voice.call.requested.v2",
    tenantId: options.tenantId,
    correlationId,
    businessIdempotencyKey: `voice-request:${options.tenantId}:${attemptId}`,
    dataClassification: "confidential",
    payload: callPayload,
    destination: options.voiceDestination
  });

  return { status: "authorized", callId, correlationId, snapshot };
}

function snapshotContactValue(
  snapshot: VoiceEligibilitySnapshot,
  key: "fullName" | "agencyCode" | "university" | "city",
  fallback: string
): string {
  const value = snapshot[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function firstSpokenName(value: string): string {
  return value.trim().split(/\s+/)[0] || "Asociado";
}

function isUsableTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function nextEligibilityCheckAt(at: Date, snapshot: VoiceEligibilitySnapshot): Date {
  const reason = snapshot.decision.reason;
  if (reason === "min_hours_between_attempts" && snapshot.hoursSinceLastAttempt !== null) {
    const remaining = Math.max(0.25, snapshot.settings.minHoursBetweenAttempts - snapshot.hoursSinceLastAttempt);
    return new Date(at.getTime() + remaining * 3_600_000);
  }
  if (reason === "max_concurrent_calls") return new Date(at.getTime() + 60_000);
  if (reason === "max_daily_attempts_reached" || reason === "max_attempts_reached") {
    return new Date(at.getTime() + 24 * 3_600_000);
  }
  if (snapshot.decision.eligibility === "blocked_window") return new Date(at.getTime() + 60 * 60_000);
  return new Date(at.getTime() + 24 * 3_600_000);
}
