import { createHash, randomUUID } from "node:crypto";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CoreAdapter } from "./core-adapter.js";
import { registerNovaRoutes } from "./routes.js";

const databaseUrl = process.env.TEST_NOVA_DATABASE_URL?.trim() ?? process.env.DATABASE_URL?.trim();
const migratorUrl = process.env.TEST_NOVA_MIGRATOR_DATABASE_URL?.trim();
const integration = databaseUrl && migratorUrl ? describe : describe.skip;

integration("NOVA operator read scope PostgreSQL boundary", () => {
  let runtime: DatabaseClient;
  let migrator: DatabaseClient;
  let app: ReturnType<typeof Fastify>;

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const adminId = randomUUID();
  const supervisorId = randomUUID();
  const emptySupervisorId = randomUUID();
  const advisorId = randomUUID();
  const otherTenantSupervisorId = randomUUID();
  const agencyContactId = randomUUID();
  const otherAgencyContactId = randomUUID();
  const otherTenantContactId = randomUUID();
  const agencyCampaignId = randomUUID();
  const otherAgencyCampaignId = randomUUID();
  const otherTenantCampaignId = randomUUID();
  const agencyReviewId = randomUUID();
  const otherAgencyReviewId = randomUUID();
  let analyticsAppliedAt: Date;
  let analyticsCoverageFrom: string;

  const coreAdapter: CoreAdapter = {
    lookupAssociate: vi.fn(async () => null),
    recordOutcome: vi.fn(async () => ({ externalRef: "not-used" }))
  };

  beforeAll(async () => {
    runtime = createDatabase(databaseUrl!);
    migrator = createDatabase(migratorUrl!);
    app = Fastify();
    await registerNovaRoutes(
      app,
      {
        db: runtime,
        config: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
      } as never,
      { coreAdapter }
    );
    await app.ready();

    for (const [id, name] of [
      [tenantId, "Scoped tenant"],
      [otherTenantId, "Other tenant"]
    ] as const) {
      await runtime.query(
        `insert into nova.tenant_snapshots
           (tenant_id, status, display_name, source_version, source_updated_at, payload_hash)
         values ($1, 'active', $2, 1, now(), $3)`,
        [id, name, createHash("sha256").update(id).digest("hex")]
      );
    }

    await runtime.query(
      `insert into nova.agencies (tenant_id, code, name, city, advisor_group)
       values ($1, 'AGENCY_A', 'Agency A', 'Bogota', 'group-a'),
              ($1, 'AGENCY_B', 'Agency B', 'Medellin', 'group-b'),
              ($2, 'AGENCY_A', 'Other tenant agency', 'Cali', 'group-c')`,
      [tenantId, otherTenantId]
    );

    for (const grant of [
      { operatorId: adminId, tenant: tenantId, role: "admin", agencies: [] },
      { operatorId: supervisorId, tenant: tenantId, role: "supervisor", agencies: ["AGENCY_A"] },
      { operatorId: emptySupervisorId, tenant: tenantId, role: "supervisor", agencies: [] },
      { operatorId: advisorId, tenant: tenantId, role: "asesor", agencies: ["AGENCY_A"] },
      {
        operatorId: otherTenantSupervisorId,
        tenant: otherTenantId,
        role: "supervisor",
        agencies: ["AGENCY_A"]
      }
    ] as const) {
      await runtime.query(
        `insert into nova.operator_grants (
           operator_id, tenant_id, role, agency_codes, source_version, source_updated_at, payload_hash
         ) values ($1, $2, $3, $4::text[], 1, now(), $5)`,
        [
          grant.operatorId,
          grant.tenant,
          grant.role,
          [...grant.agencies],
          createHash("sha256").update(`${grant.tenant}:${grant.operatorId}`).digest("hex")
        ]
      );
    }

    await runtime.query(
      `insert into nova.contacts (tenant_id, contact_id, phone_e164, full_name, agency_code)
       values ($1, $2, '+573000000001', 'Agency A Contact', 'AGENCY_A'),
              ($1, $3, '+573000000002', 'Agency B Contact', 'AGENCY_B'),
              ($4, $5, '+573000000003', 'Other Tenant Contact', 'AGENCY_A')`,
      [tenantId, agencyContactId, otherAgencyContactId, otherTenantId, otherTenantContactId]
    );
    await runtime.query(
      `insert into nova.campaigns (tenant_id, campaign_id, name, channel, product_flow, status)
       values ($1, $2, 'Agency A Campaign', 'voice', 'renovacion', 'running'),
              ($1, $3, 'Agency B Campaign', 'voice', 'renovacion', 'running'),
              ($4, $5, 'Other Tenant Campaign', 'voice', 'renovacion', 'running')`,
      [tenantId, agencyCampaignId, otherAgencyCampaignId, otherTenantId, otherTenantCampaignId]
    );
    await runtime.query(
      `insert into nova.campaign_enrollments (tenant_id, campaign_id, contact_id, status)
       values ($1, $2, $3, 'enrolled'),
              ($1, $4, $5, 'enrolled'),
              ($6, $7, $8, 'enrolled')`,
      [
        tenantId,
        agencyCampaignId,
        agencyContactId,
        otherAgencyCampaignId,
        otherAgencyContactId,
        otherTenantId,
        otherTenantCampaignId,
        otherTenantContactId
      ]
    );
    await runtime.query(
      `insert into nova.leads (tenant_id, lead_id, contact_id, stage, agency_code, product_line)
       values ($1, $2, $3, 'contactado', 'AGENCY_A', 'renovacion'),
              ($1, $4, $5, 'contactado', 'AGENCY_B', 'renovacion'),
              ($6, $7, $8, 'contactado', 'AGENCY_A', 'renovacion')`,
      [
        tenantId,
        randomUUID(),
        agencyContactId,
        randomUUID(),
        otherAgencyContactId,
        otherTenantId,
        randomUUID(),
        otherTenantContactId
      ]
    );
    await runtime.query(
      `insert into nova.handoffs (tenant_id, handoff_id, contact_id, agency_code, status)
       values ($1, $2, $3, 'AGENCY_A', 'queued'),
              ($1, $4, $5, 'AGENCY_B', 'queued'),
              ($6, $7, $8, 'AGENCY_A', 'queued')`,
      [
        tenantId,
        randomUUID(),
        agencyContactId,
        randomUUID(),
        otherAgencyContactId,
        otherTenantId,
        randomUUID(),
        otherTenantContactId
      ]
    );
    await runtime.query(
      `insert into nova.conversations (tenant_id, conversation_id, contact_id, channel, agency_code, status)
       values ($1, $2, $3, 'whatsapp', 'AGENCY_A', 'open'),
              ($1, $4, $5, 'whatsapp', 'AGENCY_B', 'open'),
              ($6, $7, $8, 'whatsapp', 'AGENCY_A', 'open')`,
      [
        tenantId,
        randomUUID(),
        agencyContactId,
        randomUUID(),
        otherAgencyContactId,
        otherTenantId,
        randomUUID(),
        otherTenantContactId
      ]
    );
    await runtime.query(
      `insert into nova.whatsapp_reviews (tenant_id, review_id, contact_id, status, intent)
       values ($1, $2, $3, 'pending_review', 'agency-a'),
              ($1, $4, $5, 'pending_review', 'agency-b'),
              ($6, $7, $8, 'pending_review', 'other-tenant')`,
      [
        tenantId,
        agencyReviewId,
        agencyContactId,
        otherAgencyReviewId,
        otherAgencyContactId,
        otherTenantId,
        randomUUID(),
        otherTenantContactId
      ]
    );
    await runtime.query(
      `insert into nova.compliance_settings (tenant_id, meta_contactos_hoy)
       values ($1, 25), ($2, 99)`,
      [tenantId, otherTenantId]
    );
    await runtime.query(
      `insert into nova.analytics_agency_coverage
         (tenant_id, applied_at, coverage_from, cutover_time_zone)
       select snapshot.tenant_id, ledger.applied_at,
              timezone(settings.time_zone, ledger.applied_at)::date + 1,
              settings.time_zone
         from nova.tenant_snapshots snapshot
         join nova.compliance_settings settings on settings.tenant_id = snapshot.tenant_id
         cross join nova.migration_ledger ledger
        where snapshot.tenant_id = any($1::uuid[])
          and ledger.name = '057-nova-agency-scoped-analytics.sql'`,
      [[tenantId, otherTenantId]]
    );
    const cutover = await migrator.query<{ appliedAt: Date; coverageFrom: string }>(
      `select applied_at as "appliedAt", coverage_from::text as "coverageFrom"
         from nova.analytics_agency_coverage
        where tenant_id = $1`,
      [tenantId]
    );
    analyticsAppliedAt = cutover.rows[0]!.appliedAt;
    analyticsCoverageFrom = cutover.rows[0]!.coverageFrom;
    await runtime.query(
      `insert into nova.analytics_daily (
         tenant_id, day, channel, calls_completed, handoffs_queued
       ) values ($1, $2::date, 'all', 11, 2), ($3, $2::date, 'all', 100, 100)`,
      [tenantId, analyticsCoverageFrom, otherTenantId]
    );
    await runtime.query(
      `insert into nova.analytics_daily_by_agency (
         tenant_id, agency_code, day, channel, calls_completed, handoffs_queued
       ) values ($1, 'AGENCY_A', $2::date, 'all', 1, 1),
                ($1, 'AGENCY_B', $2::date, 'all', 10, 1),
                ($3, 'AGENCY_A', $2::date, 'all', 100, 100)`,
      [tenantId, analyticsCoverageFrom, otherTenantId]
    );
  });

  afterAll(async () => {
    await app?.close();
    await migrator?.query(`delete from nova.tenant_snapshots where tenant_id = any($1::uuid[])`, [
      [tenantId, otherTenantId]
    ]);
    await Promise.all([runtime?.close(), migrator?.close()]);
  });

  it("keeps dashboard aggregates inside the verified tenant and agency grant", async () => {
    const admin = await get("dashboard", adminId);
    expect(admin.statusCode).toBe(200);
    expect(admin.json().data).toEqual({
      contacts: 2,
      campaigns: 2,
      leads: 2,
      handoffsQueued: 2,
      openConversations: 2,
      meta_contactos_hoy: 25
    });

    for (const operatorId of [supervisorId, advisorId]) {
      const scoped = await get("dashboard", operatorId);
      expect(scoped.statusCode).toBe(200);
      expect(scoped.json().data).toEqual({
        contacts: 1,
        campaigns: 1,
        leads: 1,
        handoffsQueued: 1,
        openConversations: 1,
        meta_contactos_hoy: 0
      });
    }

    const emptySupervisor = await get("dashboard", emptySupervisorId);
    expect(emptySupervisor.statusCode).toBe(200);
    expect(emptySupervisor.json().data).toEqual({
      contacts: 0,
      campaigns: 0,
      leads: 0,
      handoffsQueued: 0,
      openConversations: 0,
      meta_contactos_hoy: 0
    });

    const crossTenant = await get("dashboard", otherTenantSupervisorId);
    expect(crossTenant.statusCode).toBe(403);
  });

  it("blocks supervisors from mutating contacts outside their agency grant", async () => {
    const crossAgencyScore = await post(`contacts/${otherAgencyContactId}/score`, supervisorId, {});
    expect(crossAgencyScore.statusCode).toBe(404);

    const crossAgencyEligibility = await post(`contacts/${otherAgencyContactId}/eligibility`, supervisorId, {});
    expect(crossAgencyEligibility.statusCode).toBe(404);

    const crossAgencyImport = await post("contacts/import", supervisorId, {
      contacts: [
        {
          phone_e164: "+573009999902",
          full_name: "Outside Agency",
          agency_code: "AGENCY_B"
        }
      ]
    });
    expect(crossAgencyImport.statusCode).toBe(403);

    const existingOutsideGrant = await post("contacts/import", supervisorId, {
      contacts: [
        {
          phone_e164: "+573000000002",
          full_name: "Rewrite B",
          agency_code: "AGENCY_A"
        }
      ]
    });
    expect(existingOutsideGrant.statusCode).toBe(403);

    const advisorImport = await post("contacts/import", advisorId, {
      contacts: [
        {
          phone_e164: "+573009999903",
          full_name: "Advisor blocked",
          agency_code: "AGENCY_A"
        }
      ]
    });
    expect(advisorImport.statusCode).toBe(403);

    const inGrantScore = await post(`contacts/${agencyContactId}/score`, supervisorId, {
      segment: "renovacion",
      score: 0.42
    });
    expect(inGrantScore.statusCode).toBe(200);
    expect(inGrantScore.json().data).toMatchObject({
      contact_id: agencyContactId,
      segment: "renovacion",
      score: 0.42
    });

    const inGrantImport = await post("contacts/import", supervisorId, {
      contacts: [
        {
          phone_e164: "+573009999901",
          full_name: "In Agency",
          agency_code: "AGENCY_A"
        }
      ]
    });
    expect(inGrantImport.statusCode).toBe(201);
  });

  it("requires admin grants for bootstrap updates, compliance writes, and DLQ", async () => {
    const supervisorBootstrap = await post("bootstrap", supervisorId, {
      display_name: "Should fail",
      agencies: [],
      operator_grants: []
    });
    expect(supervisorBootstrap.statusCode).toBe(403);

    const supervisorCompliance = await app.inject({
      method: "PUT",
      url: `/v1/tenants/${tenantId}/nova/compliance/settings`,
      headers: { "x-operator-id": supervisorId },
      payload: {
        window_start_hour: 8,
        window_end_hour: 18,
        time_zone: "America/Bogota",
        allowed_weekdays: [1, 2, 3, 4, 5],
        voice_enabled: true,
        whatsapp_enabled: true,
        max_attempts_per_day: 100,
        max_attempts_per_contact: 3,
        rolling_window_days: 7,
        max_concurrent_calls: 5,
        min_hours_between_attempts: 4,
        respect_holidays: true,
        meta_contactos_hoy: 10
      }
    });
    expect(supervisorCompliance.statusCode).toBe(403);

    const supervisorDlq = await get("outbox/dlq", supervisorId);
    expect(supervisorDlq.statusCode).toBe(403);

    const adminDlq = await get("outbox/dlq", adminId);
    expect(adminDlq.statusCode).toBe(200);
  });

  it("rejects the reserved analytics bucket in bootstrap agencies and grants", async () => {
    const base = {
      display_name: "Reserved bucket rejection",
      agencies: [],
      operator_grants: []
    };
    const reservedAgency = await post("bootstrap", adminId, {
      ...base,
      agencies: [
        {
          code: "__UNATTRIBUTED__",
          name: "Reserved",
          city: "Bogota",
          advisor_group: "reserved"
        }
      ]
    });
    expect(reservedAgency.statusCode).toBe(400);

    const reservedGrant = await post("bootstrap", adminId, {
      ...base,
      operator_grants: [
        {
          operator_id: randomUUID(),
          role: "supervisor",
          agency_codes: ["__UNATTRIBUTED__"],
          is_active: true
        }
      ]
    });
    expect(reservedGrant.statusCode).toBe(400);
  });

  it("allows only management roles to read reviews and filters supervisors by agency", async () => {
    const admin = await get("reviews", adminId);
    expect(admin.statusCode).toBe(200);
    expect(admin.json().data).toHaveLength(2);

    const supervisor = await get("reviews", supervisorId);
    expect(supervisor.statusCode).toBe(200);
    expect(supervisor.json().data).toHaveLength(1);
    expect(supervisor.json().data[0]).toMatchObject({ contact_id: agencyContactId, intent: "agency-a" });

    const emptySupervisor = await get("reviews", emptySupervisorId);
    expect(emptySupervisor.statusCode).toBe(200);
    expect(emptySupervisor.json().data).toEqual([]);

    const advisor = await get("reviews", advisorId);
    expect(advisor.statusCode).toBe(403);

    const crossTenant = await get("reviews", otherTenantSupervisorId);
    expect(crossTenant.statusCode).toBe(403);
  });

  it("rejects review mutations outside the management role or agency without side effects", async () => {
    const before = await reviewMutationState();

    const advisorCreate = await post("reviews", advisorId, {
      contact_id: agencyContactId,
      intent: "advisor-bypass"
    });
    expect(advisorCreate.statusCode).toBe(403);

    const crossTenantCreate = await post("reviews", otherTenantSupervisorId, {
      contact_id: agencyContactId,
      intent: "cross-tenant"
    });
    expect(crossTenantCreate.statusCode).toBe(403);

    const supervisorCreateOutsideGrant = await post("reviews", supervisorId, {
      contact_id: otherAgencyContactId,
      intent: "cross-agency"
    });
    expect(supervisorCreateOutsideGrant.statusCode).toBe(403);

    const supervisorDecideOutsideGrant = await post(`reviews/${otherAgencyReviewId}/decide`, supervisorId, {
      decision: "approve"
    });
    expect(supervisorDecideOutsideGrant.statusCode).toBe(403);

    const advisorDecide = await post(`reviews/${agencyReviewId}/decide`, advisorId, { decision: "approve" });
    expect(advisorDecide.statusCode).toBe(403);

    expect(await reviewMutationState()).toEqual(before);

    const allowed = await post("reviews", supervisorId, {
      contact_id: agencyContactId,
      intent: "agency-a-supervisor",
      flow_id: "renewal_flow"
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
    expect(allowed.json().data).toMatchObject({ contact_id: agencyContactId, status: "pending_review" });
  });

  it("revalidates and locks the operator grant inside the review mutation transaction", async () => {
    const before = await reviewMutationState();
    let pendingRequest: ReturnType<typeof post> | undefined;
    let settled = false;

    try {
      await migrator.transaction(async (tx) => {
        await tx.query(
          `update nova.operator_grants set is_active = false
            where tenant_id = $1 and operator_id = $2`,
          [tenantId, supervisorId]
        );
        pendingRequest = post("reviews", supervisorId, {
          contact_id: agencyContactId,
          intent: "revocation-race"
        });
        void pendingRequest.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(false);
      });

      const response = await pendingRequest!;
      expect(response.statusCode).toBe(403);
      expect(response.json().data.error).toMatch(/management grant/i);
      expect(await reviewMutationState()).toEqual(before);
    } finally {
      await migrator.query(
        `update nova.operator_grants set is_active = true
          where tenant_id = $1 and operator_id = $2`,
        [tenantId, supervisorId]
      );
    }
  });

  it("fails closed when a contact moves outside the agency grant during review creation", async () => {
    const before = await reviewMutationState();
    let pendingRequest: ReturnType<typeof post> | undefined;
    let settled = false;

    try {
      await migrator.transaction(async (tx) => {
        await tx.query(
          `update nova.contacts set agency_code = 'AGENCY_B'
            where tenant_id = $1 and contact_id = $2`,
          [tenantId, agencyContactId]
        );
        pendingRequest = post("reviews", supervisorId, {
          contact_id: agencyContactId,
          intent: "agency-move-race"
        });
        void pendingRequest.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(settled).toBe(false);
      });

      const response = await pendingRequest!;
      expect(response.statusCode).toBe(403);
      expect(response.json().data.error).toMatch(/outside the operator grant/i);
      expect(await reviewMutationState()).toEqual(before);
    } finally {
      await migrator.query(
        `update nova.contacts set agency_code = 'AGENCY_A'
          where tenant_id = $1 and contact_id = $2`,
        [tenantId, agencyContactId]
      );
    }
  });

  it("keeps global analytics admin-only and aggregates only supervisor agencies", async () => {
    const admin = await get("analytics/daily", adminId);
    expect(admin.statusCode).toBe(200);
    expect(admin.json().data).toHaveLength(1);
    expect(Number(admin.json().data[0]?.calls_completed)).toBe(11);

    const supervisor = await get("analytics/daily", supervisorId);
    expect(supervisor.statusCode).toBe(200);
    expect(supervisor.json().data).toHaveLength(1);
    expect(Number(supervisor.json().data[0]?.calls_completed)).toBe(1);
    expect(Number(supervisor.json().data[0]?.handoffs_queued)).toBe(1);
    expect(supervisor.json().meta.analyticsCoverage).toMatchObject({
      status: "complete_since_cutover",
      coverageFrom: analyticsCoverageFrom,
      appliedAt: analyticsAppliedAt.toISOString(),
      reservedBucketExcluded: true
    });

    const emptySupervisor = await get("analytics/daily", emptySupervisorId);
    expect(emptySupervisor.statusCode).toBe(200);
    expect(emptySupervisor.json().data).toEqual([]);

    const advisor = await get("analytics/daily", advisorId);
    expect(advisor.statusCode).toBe(403);

    const crossTenant = await get("analytics/daily", otherTenantSupervisorId);
    expect(crossTenant.statusCode).toBe(403);
  });

  it("keeps the attested cutover stable when the mutable compliance timezone changes", async () => {
    try {
      await runtime.query(`update nova.compliance_settings set time_zone = 'Pacific/Kiritimati' where tenant_id = $1`, [
        tenantId
      ]);
      const supervisor = await get("analytics/daily", supervisorId);
      expect(supervisor.statusCode).toBe(200);
      expect(supervisor.json().meta.analyticsCoverage).toMatchObject({
        coverageFrom: analyticsCoverageFrom,
        appliedAt: analyticsAppliedAt.toISOString(),
        cutoverTimeZone: "America/Bogota"
      });
    } finally {
      await runtime.query(`update nova.compliance_settings set time_zone = 'America/Bogota' where tenant_id = $1`, [
        tenantId
      ]);
    }
  });

  it("backfills historical totals into an idempotent non-assignable bucket", async () => {
    const historicalDay = await migrator.query<{ day: string }>(`select ($1::date - 1)::text as day`, [
      analyticsCoverageFrom
    ]);
    await runtime.query(
      `insert into nova.analytics_daily (tenant_id, day, channel, calls_completed, wa_sent)
       values ($1, $2::date, 'voice', 7, 3)`,
      [tenantId, historicalDay.rows[0]!.day]
    );

    const first = await migrator.query<{ affected: number }>(
      `select nova.backfill_agency_analytics_unattributed($1) as affected`,
      [tenantId]
    );
    const second = await migrator.query<{ affected: number }>(
      `select nova.backfill_agency_analytics_unattributed($1) as affected`,
      [tenantId]
    );
    expect(Number(first.rows[0]?.affected)).toBe(1);
    expect(Number(second.rows[0]?.affected)).toBe(0);

    const bucket = await runtime.query<{ callsCompleted: string; waSent: string }>(
      `select calls_completed::text as "callsCompleted", wa_sent::text as "waSent"
         from nova.analytics_daily_by_agency
        where tenant_id = $1 and agency_code = '__UNATTRIBUTED__'
          and day = $2::date and channel = 'voice'`,
      [tenantId, historicalDay.rows[0]!.day]
    );
    expect(bucket.rows[0]).toEqual({ callsCompleted: "7", waSent: "3" });

    await runtime.query(
      `insert into nova.analytics_daily_by_agency
         (tenant_id, agency_code, day, channel, calls_completed, wa_sent)
       values ($1, 'AGENCY_A', $2::date, 'voice', 4, 1)`,
      [tenantId, historicalDay.rows[0]!.day]
    );
    const redistributed = await migrator.query<{ affected: number }>(
      `select nova.backfill_agency_analytics_unattributed($1) as affected`,
      [tenantId]
    );
    const redistributedAgain = await migrator.query<{ affected: number }>(
      `select nova.backfill_agency_analytics_unattributed($1) as affected`,
      [tenantId]
    );
    expect(Number(redistributed.rows[0]?.affected)).toBe(1);
    expect(Number(redistributedAgain.rows[0]?.affected)).toBe(0);
    const reducedBucket = await runtime.query<{ callsCompleted: string; waSent: string }>(
      `select calls_completed::text as "callsCompleted", wa_sent::text as "waSent"
         from nova.analytics_daily_by_agency
        where tenant_id = $1 and agency_code = '__UNATTRIBUTED__'
          and day = $2::date and channel = 'voice'`,
      [tenantId, historicalDay.rows[0]!.day]
    );
    expect(reducedBucket.rows[0]).toEqual({ callsCompleted: "3", waSent: "2" });

    await runtime.query(
      `insert into nova.analytics_daily_by_agency
         (tenant_id, agency_code, day, channel, calls_completed)
       values ($1, 'AGENCY_B', $2::date, 'voice', 4)`,
      [tenantId, historicalDay.rows[0]!.day]
    );
    await expect(migrator.query(`select nova.backfill_agency_analytics_unattributed($1)`, [tenantId])).rejects.toThrow(
      /exceed the tenant-wide aggregate/
    );
    await runtime.query(
      `delete from nova.analytics_daily_by_agency
        where tenant_id = $1 and agency_code = 'AGENCY_B'
          and day = $2::date and channel = 'voice'`,
      [tenantId, historicalDay.rows[0]!.day]
    );

    const supervisor = await get("analytics/daily", supervisorId);
    expect(supervisor.statusCode).toBe(200);
    expect(supervisor.json().data).toHaveLength(1);
    expect(supervisor.json().data[0]?.day).not.toBe(historicalDay.rows[0]!.day);
  });

  it("fails closed on a post-cutover mismatch and recovers after a verified attribution backfill", async () => {
    const mismatchDay = await runtime.query<{ day: string }>(`select ($1::date + 1)::text as day`, [
      analyticsCoverageFrom
    ]);
    await runtime.query(
      `insert into nova.analytics_daily (tenant_id, day, channel, calls_completed)
       values ($1, $2::date, 'voice', 5)`,
      [tenantId, mismatchDay.rows[0]!.day]
    );

    const partial = await get("analytics/daily", supervisorId);
    expect(partial.statusCode).toBe(409);
    expect(partial.json().data).toMatchObject({
      code: "agency_analytics_history_partial",
      coverage: {
        status: "partial",
        coverageFrom: analyticsCoverageFrom,
        appliedAt: analyticsAppliedAt.toISOString(),
        mismatchedRows: 1,
        dataReturned: false,
        remediation: "verified_agency_backfill_required"
      }
    });

    const admin = await get("analytics/daily", adminId);
    expect(admin.statusCode).toBe(200);
    expect(admin.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ channel: "voice", calls_completed: 5 })])
    );

    await runtime.query(
      `insert into nova.analytics_daily_by_agency
         (tenant_id, agency_code, day, channel, calls_completed)
       values ($1, 'AGENCY_A', $2::date, 'voice', 5)`,
      [tenantId, mismatchDay.rows[0]!.day]
    );
    const recovered = await get("analytics/daily", supervisorId);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().data).toEqual(
      expect.arrayContaining([expect.objectContaining({ channel: "voice", calls_completed: 5 })])
    );
  });

  it("reconciles the entire post-cutover history even when the response contains only 90 rows", async () => {
    await runtime.query(
      `insert into nova.analytics_daily (tenant_id, day, channel, calls_requested)
       select $1, $2::date + series.day_offset, 'whatsapp', 1
         from generate_series(1, 91) as series(day_offset)`,
      [tenantId, analyticsCoverageFrom]
    );
    await runtime.query(
      `insert into nova.analytics_daily_by_agency
         (tenant_id, agency_code, day, channel, calls_requested)
       select $1, 'AGENCY_A', $2::date + series.day_offset, 'whatsapp', 1
         from generate_series(1, 91) as series(day_offset)`,
      [tenantId, analyticsCoverageFrom]
    );
    await runtime.query(
      `update nova.analytics_daily
          set contacts_imported = contacts_imported + 1
        where tenant_id = $1 and day = $2::date and channel = 'all'`,
      [tenantId, analyticsCoverageFrom]
    );

    const partial = await get("analytics/daily", supervisorId);
    expect(partial.statusCode).toBe(409);
    expect(partial.json().data.coverage).toMatchObject({
      mismatchedRows: 1,
      earliestMismatchDay: analyticsCoverageFrom,
      latestMismatchDay: analyticsCoverageFrom,
      dataReturned: false
    });

    await runtime.query(
      `update nova.analytics_daily_by_agency
          set contacts_imported = contacts_imported + 1
        where tenant_id = $1 and agency_code = 'AGENCY_A'
          and day = $2::date and channel = 'all'`,
      [tenantId, analyticsCoverageFrom]
    );
    const recovered = await get("analytics/daily", supervisorId);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().data).toHaveLength(90);
  });

  it("returns a machine-readable 503 when the persisted coverage attestation is absent", async () => {
    await migrator.query(`delete from nova.analytics_agency_coverage where tenant_id = $1`, [tenantId]);
    try {
      const unavailable = await get("analytics/daily", supervisorId);
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json().data).toMatchObject({
        code: "agency_analytics_coverage_unavailable",
        coverage: {
          status: "unavailable",
          migration: "057-nova-agency-scoped-analytics.sql",
          dataReturned: false
        }
      });
    } finally {
      await migrator.query(
        `insert into nova.analytics_agency_coverage
           (tenant_id, applied_at, coverage_from, cutover_time_zone)
         values ($1, $2, $3::date, 'America/Bogota')`,
        [tenantId, analyticsAppliedAt, analyticsCoverageFrom]
      );
    }
  });

  it("dual-writes new contact-attributed metrics without changing another agency", async () => {
    const before = await analyticsTotals();
    const response = await app.inject({
      method: "POST",
      url: "/internal/events",
      payload: {
        event_id: randomUUID(),
        event_type: "wa.message.sent",
        tenant_id: tenantId,
        business_idempotency_key: `scope-test:${randomUUID()}`,
        payload: {
          message_id: randomUUID(),
          contact_id: agencyContactId,
          mode: "text",
          text: "Scoped analytics"
        }
      }
    });
    expect(response.statusCode).toBe(200);

    const after = await analyticsTotals();
    expect(after.global).toBe(before.global + 1);
    expect(after.agencyA).toBe(before.agencyA + 1);
    expect(after.agencyB).toBe(before.agencyB);
  });

  function get(suffix: string, operatorId: string) {
    return app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/nova/${suffix}`,
      headers: { "x-operator-id": operatorId }
    });
  }

  function post(suffix: string, operatorId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/${suffix}`,
      headers: { "x-operator-id": operatorId },
      payload
    });
  }

  async function reviewMutationState(): Promise<{
    agencyReviewStatus: string;
    otherAgencyReviewStatus: string;
    outboxCount: number;
    reviewCount: number;
  }> {
    const reviews = await runtime.query<{ reviewId: string; status: string }>(
      `select review_id as "reviewId", status
         from nova.whatsapp_reviews
        where tenant_id = $1`,
      [tenantId]
    );
    const outbox = await runtime.query<{ count: string }>(
      `select count(*)::text as count from nova.outbox_events where tenant_id = $1`,
      [tenantId]
    );
    const statusById = new Map(reviews.rows.map((row) => [row.reviewId, row.status]));
    return {
      agencyReviewStatus: statusById.get(agencyReviewId) ?? "missing",
      otherAgencyReviewStatus: statusById.get(otherAgencyReviewId) ?? "missing",
      outboxCount: Number(outbox.rows[0]?.count ?? 0),
      reviewCount: reviews.rows.length
    };
  }

  async function analyticsTotals(): Promise<{ global: number; agencyA: number; agencyB: number }> {
    const global = await runtime.query<{ total: string }>(
      `select coalesce(sum(wa_sent), 0)::text as total from nova.analytics_daily where tenant_id = $1`,
      [tenantId]
    );
    const scoped = await runtime.query<{ agencyCode: string; total: string }>(
      `select agency_code as "agencyCode", coalesce(sum(wa_sent), 0)::text as total
         from nova.analytics_daily_by_agency
        where tenant_id = $1
        group by agency_code`,
      [tenantId]
    );
    const byAgency = new Map(scoped.rows.map((row) => [row.agencyCode, Number(row.total)]));
    return {
      global: Number(global.rows[0]?.total ?? 0),
      agencyA: byAgency.get("AGENCY_A") ?? 0,
      agencyB: byAgency.get("AGENCY_B") ?? 0
    };
  }
});
