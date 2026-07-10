import type { LumenClinicalRecordContent } from "@hyperion/contracts";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LumenAuditEvent } from "./audit-client.js";
import type { ClinicalStructurer, ClinicalTranscriber } from "./clinical-ai.js";
import { registerLumenRoutes } from "./routes.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;
const { Client } = pg;

const CONTENT: LumenClinicalRecordContent = {
  reasonForVisit: "Control oftalmológico",
  history: "Visión estable durante el último mes.",
  visualAcuity: { right: "20/20", left: "20/40" },
  intraocularPressure: { right: "14 mmHg", left: "16 mmHg" },
  biomicroscopy: { right: null, left: null },
  fundus: { right: null, left: "Hallazgo por confirmar" },
  assessment: [],
  plan: ["Control en cuatro semanas"],
  uncertainties: [{ field: "fundus.left", message: "Confirmar hallazgo", sourceText: "hallazgo dudoso" }]
};

const transcriber: ClinicalTranscriber = {
  name: "test-stt",
  model: "test-stt-v1",
  isConfigured: () => true,
  transcribe: async () => ({
    transcript: "Control. PIO catorce OD y dieciseis OI.",
    provider: "test-stt",
    model: "test-stt-v1"
  })
};

let structureBarrier: { started: () => void; release: Promise<void> } | undefined;
let structureCallCount = 0;
const structurer: ClinicalStructurer = {
  name: "test-llm",
  model: "test-llm-v1",
  isConfigured: () => true,
  structure: async () => {
    structureCallCount += 1;
    structureBarrier?.started();
    if (structureBarrier) await structureBarrier.release;
    return { content: CONTENT, provider: "test-llm", model: "test-llm-v1" };
  }
};

let app: ServiceHandle["app"];
let client: pg.Client;
let tenantA: string;
let tenantB: string;
let encounterA: string;
let patientA: string;
let patientB: string;
let operatorId: string;
const audits: LumenAuditEvent[] = [];

describeIntegration("LUMEN clinical vertical", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    client = new Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    await cleanup();
    tenantA = await createTenant("lumen-int-a");
    tenantB = await createTenant("lumen-int-b");
    const fixtureA = await createFixture(tenantA, "A");
    const fixtureB = await createFixture(tenantB, "B");
    encounterA = fixtureA.encounterId;
    patientA = fixtureA.patientId;
    patientB = fixtureB.patientId;
    operatorId = await createOperator(tenantA);

    const handle = await createService({
      serviceName: "lumen-service",
      databaseRequired: true,
      registerRoutes: async (serviceApp, context) =>
        registerLumenRoutes(serviceApp, context, { transcriber, structurer, emitAudit: (event) => audits.push(event) })
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await client?.end();
    delete process.env.DATABASE_URL;
  });

  it("keeps encounter reads isolated by tenant", async () => {
    const own = await app.inject({ method: "GET", url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}` });
    expect(own.statusCode).toBe(200);
    expect(own.json().data.encounter.isDemo).toBe(true);

    const foreign = await app.inject({ method: "GET", url: `/v1/tenants/${tenantB}/lumen/encounters/${encounterA}` });
    expect(foreign.statusCode).toBe(404);
  });

  it("blocks direct cross-tenant encounter references", async () => {
    const catalog = await client.query(
      `select e.professional_id, e.site_id from lumen.encounters e where e.tenant_id = $1 and e.id = $2`,
      [tenantA, encounterA]
    );
    await expect(
      client.query(
        `insert into lumen.encounters
           (tenant_id, patient_id, professional_id, site_id, scheduled_at, is_demo, demo_key, metadata)
         values ($1, $2, $3, $4, now(), true, 'cross-tenant', '{"synthetic":true}'::jsonb)`,
        [tenantA, patientB, catalog.rows[0].professional_id, catalog.rows[0].site_id]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects clinical encounters for non-synthetic patients", async () => {
    const patient = await client.query(
      `insert into pulso_iris.administrative_patients (tenant_id, full_name, metadata)
       values ($1, 'Paciente no demo de prueba', '{}'::jsonb) returning id`,
      [tenantA]
    );
    const catalog = await client.query(
      `select professional_id, site_id from lumen.encounters where tenant_id = $1 and id = $2`,
      [tenantA, encounterA]
    );
    await expect(
      client.query(
        `insert into lumen.encounters
           (tenant_id, patient_id, professional_id, site_id, scheduled_at, is_demo, demo_key, metadata)
         values ($1, $2, $3, $4, now(), true, 'non-demo-reference', '{"synthetic":true}'::jsonb)`,
        [tenantA, patient.rows[0].id, catalog.rows[0].professional_id, catalog.rows[0].site_id]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps synthetic identity markers and approval transitions database-enforced", async () => {
    await expect(
      client.query(
        `update pulso_iris.administrative_patients
         set metadata = metadata - 'is_demo'
         where tenant_id = $1 and id = $2`,
        [tenantA, patientA]
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(`update lumen.encounters set status = 'approved' where tenant_id = $1 and id = $2`, [
        tenantA,
        encounterA
      ])
    ).rejects.toMatchObject({ code: "23514" });

    const failedDictation = await client.query(
      `insert into lumen.dictations
         (tenant_id, encounter_id, status, mime_type, provider, error_code, metadata)
       values ($1, $2, 'failed', 'audio/webm', 'test-stt', 'ProviderError', '{"audioStored":false}'::jsonb)
       returning id`,
      [tenantA, encounterA]
    );
    await expect(
      client.query(
        `insert into lumen.clinical_records
           (tenant_id, encounter_id, dictation_id, status, content, provider, model)
         values ($1, $2, $3, 'draft', $4::jsonb, 'test-llm', 'test-llm-v1')`,
        [tenantA, encounterA, failedDictation.rows[0].id, JSON.stringify(CONTENT)]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("serializes structuring against approval on the encounter row", async () => {
    const fixture = await createFixture(tenantA, "C");
    const resolvedContent = { ...CONTENT, uncertainties: [] };
    const dictation = await client.query(
      `insert into lumen.dictations
         (tenant_id, encounter_id, status, transcript, mime_type, provider, metadata)
       values ($1, $2, 'transcribed', 'Dictado inicial sintético.', 'text/plain', 'manual',
               '{"audioStored":false}'::jsonb)
       returning id`,
      [tenantA, fixture.encounterId]
    );
    await client.query(
      `insert into lumen.clinical_records
         (tenant_id, encounter_id, dictation_id, status, content, provider, model)
       values ($1, $2, $3, 'draft', $4::jsonb, 'test-llm', 'test-llm-v1')`,
      [tenantA, fixture.encounterId, dictation.rows[0].id, JSON.stringify(resolvedContent)]
    );
    await client.query(`update lumen.encounters set status = 'review' where tenant_id = $1 and id = $2`, [
      tenantA,
      fixture.encounterId
    ]);

    let notifyStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    structureBarrier = { started: notifyStarted, release: providerRelease };
    const headers = { "x-operator-role": "advisor", "x-operator-id": operatorId };
    let approvalSettled = false;
    try {
      const structureRequest = app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/structure`,
        headers,
        payload: { transcript: "Dictado concurrente sintético sin PII." }
      });
      await providerStarted;
      const approvalRequest = app
        .inject({
          method: "POST",
          url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/approve`,
          headers
        })
        .finally(() => {
          approvalSettled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(approvalSettled).toBe(false);
      releaseProvider();
      expect((await structureRequest).statusCode).toBe(201);
      expect((await approvalRequest).statusCode).toBe(422);
    } finally {
      releaseProvider();
      structureBarrier = undefined;
    }

    const state = await client.query(
      `select record.status, jsonb_array_length(record.content->'uncertainties')::int as uncertainties
       from lumen.clinical_records record
       where record.tenant_id = $1 and record.encounter_id = $2`,
      [tenantA, fixture.encounterId]
    );
    expect(state.rows[0]).toMatchObject({ status: "draft", uncertainties: 1 });
  });

  it("transcribes without persisting audio, structures, resolves uncertainties and approves", async () => {
    const headers = { "x-operator-role": "advisor", "x-operator-id": operatorId };
    const started = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/start`,
      headers
    });
    expect(started.statusCode).toBe(200);
    const transcription = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/transcriptions`,
      headers,
      payload: {
        audioBase64: Buffer.from("short-valid-audio").toString("base64"),
        mimeType: "audio/webm",
        durationSeconds: 8
      }
    });
    expect(transcription.statusCode).toBe(201);
    const dictation = transcription.json().data;
    expect(dictation.transcript).toContain("PIO");

    const stored = await client.query(`select metadata from lumen.dictations where tenant_id = $1 and id = $2`, [
      tenantA,
      dictation.id
    ]);
    expect(stored.rows[0].metadata).toMatchObject({ audioStored: false });

    const mismatched = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/structure`,
      headers,
      payload: { transcript: `${dictation.transcript} Texto editado.`, dictationId: dictation.id }
    });
    expect(mismatched.statusCode).toBe(422);

    const structured = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/structure`,
      headers,
      payload: { transcript: dictation.transcript, dictationId: dictation.id }
    });
    expect(structured.statusCode).toBe(201);
    expect(structured.json().data.content.uncertainties).toHaveLength(1);

    const durableProcessAudit = await client.query(
      `select event_type, count(*)::int as count
       from platform.audit_events
       where tenant_id = $1
         and event_type in ('lumen.encounter.started', 'lumen.dictation.transcribed', 'lumen.record.structured')
         and (entity_id = $2 or metadata->>'encounterId' = $2)
       group by event_type`,
      [tenantA, encounterA]
    );
    expect(Object.fromEntries(durableProcessAudit.rows.map((row) => [row.event_type, row.count]))).toEqual({
      "lumen.dictation.transcribed": 1,
      "lumen.encounter.started": 1,
      "lumen.record.structured": 1
    });

    await expect(
      client.query(
        `update lumen.clinical_records set approved_by = $3
         where tenant_id = $1 and encounter_id = $2`,
        [tenantA, encounterA, operatorId]
      )
    ).rejects.toMatchObject({ code: "23514" });

    const blocked = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/approve`,
      headers
    });
    expect(blocked.statusCode).toBe(422);
    await expect(
      client.query(
        `update lumen.clinical_records
         set status = 'approved', approved_by = $3, approved_at = now()
         where tenant_id = $1 and encounter_id = $2`,
        [tenantA, encounterA, operatorId]
      )
    ).rejects.toMatchObject({ code: "23514" });

    const resolved = {
      ...structured.json().data.content,
      uncertainties: [],
      fundus: { right: null, left: "Sin hallazgos adicionales" }
    };
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/record`,
      headers,
      payload: { content: resolved }
    });
    expect(patched.statusCode).toBe(200);

    const durableReviewAudit = await client.query(
      `select metadata from platform.audit_events
       where tenant_id = $1 and event_type = 'lumen.record.reviewed'
         and entity_id = $2 and actor_id = $3`,
      [tenantA, patched.json().data.id, operatorId]
    );
    expect(durableReviewAudit.rowCount).toBe(1);
    expect(durableReviewAudit.rows[0].metadata).toMatchObject({
      previousUncertainties: 1,
      remainingUncertainties: 0,
      resolvedUncertainties: 1,
      resolvedFields: ["fundus.left"]
    });
    expect(durableReviewAudit.rows[0].metadata.reviewedSections).toEqual(
      expect.arrayContaining(["fundus", "uncertainties"])
    );

    const approved = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/approve`,
      headers
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.status).toBe("approved");

    const durableAudit = await client.query(
      `select count(*)::int as count from platform.audit_events
       where tenant_id = $1 and event_type = 'lumen.record.approved'
         and entity_id = $2`,
      [tenantA, approved.json().data.id]
    );
    expect(durableAudit.rows[0].count).toBe(1);

    const beforeDictations = await client.query(
      `select count(*)::int as count from lumen.dictations where tenant_id = $1 and encounter_id = $2`,
      [tenantA, encounterA]
    );
    const structureCallsBeforeImmutableRequests = structureCallCount;
    const immutableRequests = await Promise.all([
      app.inject({ method: "POST", url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/start`, headers }),
      app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/transcriptions`,
        headers,
        payload: {
          audioBase64: Buffer.from("post-approval-audio").toString("base64"),
          mimeType: "audio/webm",
          durationSeconds: 2
        }
      }),
      app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/structure`,
        headers,
        payload: { transcript: "Transcript manual posterior a aprobación." }
      }),
      app.inject({
        method: "PATCH",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/record`,
        headers,
        payload: { content: resolved }
      }),
      app.inject({ method: "POST", url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/approve`, headers })
    ]);
    expect(immutableRequests.map((response) => response.statusCode)).toEqual([409, 409, 409, 409, 409]);
    expect(structureCallCount).toBe(structureCallsBeforeImmutableRequests);

    const afterDictations = await client.query(
      `select count(*)::int as count from lumen.dictations where tenant_id = $1 and encounter_id = $2`,
      [tenantA, encounterA]
    );
    expect(afterDictations.rows[0].count).toBe(beforeDictations.rows[0].count);

    await expect(
      client.query(
        `update lumen.clinical_records set content = jsonb_set(content, '{history}', '"alterada"'::jsonb)
         where tenant_id = $1 and encounter_id = $2`,
        [tenantA, encounterA]
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(`delete from lumen.clinical_records where tenant_id = $1 and encounter_id = $2`, [
        tenantA,
        encounterA
      ])
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        `insert into lumen.dictations
           (tenant_id, encounter_id, status, transcript, mime_type, provider, metadata)
         values ($1, $2, 'transcribed', 'posterior', 'text/plain', 'manual', '{"audioStored":false}'::jsonb)`,
        [tenantA, encounterA]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps auditors read-only", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/start`,
      headers: { "x-operator-role": "auditor", "x-operator-id": operatorId }
    });
    expect(response.statusCode).toBe(403);
  });
});

async function createTenant(slug: string): Promise<string> {
  const result = await client.query(
    `insert into platform.tenants (slug, display_name, status) values ($1, $2, 'active') returning id`,
    [slug, slug]
  );
  return result.rows[0].id;
}

async function createFixture(tenantId: string, suffix: string): Promise<{ encounterId: string; patientId: string }> {
  const patient = await client.query(
    `insert into pulso_iris.administrative_patients (tenant_id, full_name, metadata)
     values ($1, $2, '{"is_demo":true,"demoAge":54}'::jsonb) returning id`,
    [tenantId, `Paciente ${suffix}`]
  );
  const professional = await client.query(
    `insert into pulso_iris.professionals (tenant_id, name, professional_type, metadata)
     values ($1, $2, 'ophthalmologist', '{"is_demo":true}'::jsonb) returning id`,
    [tenantId, `Profesional ${suffix}`]
  );
  const site = await client.query(
    `insert into pulso_iris.sites (tenant_id, name, metadata)
     values ($1, $2, '{"is_demo":true}'::jsonb) returning id`,
    [tenantId, `Sede ${suffix}`]
  );
  const encounter = await client.query(
    `insert into lumen.encounters
       (tenant_id, patient_id, professional_id, site_id, scheduled_at, is_demo, demo_key, metadata)
     values ($1, $2, $3, $4, '2026-07-10T15:00:00Z', true, $5, '{"synthetic":true}'::jsonb)
     returning id`,
    [tenantId, patient.rows[0].id, professional.rows[0].id, site.rows[0].id, `integration-${suffix}`]
  );
  await client.query(
    `insert into lumen.preconsultation_summaries (tenant_id, encounter_id, content, source_count)
     values ($1, $2, $3::jsonb, 3)`,
    [
      tenantId,
      encounter.rows[0].id,
      JSON.stringify({
        summaryText: "Paciente sintético para integración.",
        activeDiagnoses: [],
        medications: [],
        alerts: [],
        trends: []
      })
    ]
  );
  return { encounterId: encounter.rows[0].id, patientId: patient.rows[0].id };
}

async function createOperator(tenantId: string): Promise<string> {
  const operator = await client.query(
    `insert into platform.operators (tenant_id, email, display_name, role, status)
     values ($1, $2, 'Asesor LUMEN sintético', 'advisor', 'active') returning id`,
    [tenantId, `lumen-int-${tenantId}`]
  );
  await client.query(`insert into platform.operator_tenants (operator_id, tenant_id) values ($1, $2)`, [
    operator.rows[0].id,
    tenantId
  ]);
  return operator.rows[0].id;
}

async function cleanup(): Promise<void> {
  if (!client) return;
  await client.query(`delete from platform.tenants where slug like 'lumen-int-%'`);
  await client.query(`delete from platform.operators where email like 'lumen-int-%'`);
}
