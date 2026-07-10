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

const structurer: ClinicalStructurer = {
  name: "test-llm",
  model: "test-llm-v1",
  isConfigured: () => true,
  structure: async () => ({ content: CONTENT, provider: "test-llm", model: "test-llm-v1" })
};

let app: ServiceHandle["app"];
let client: pg.Client;
let tenantA: string;
let tenantB: string;
let encounterA: string;
let patientB: string;
const operatorId = "00000000-0000-4000-8000-000000000001";
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
    patientB = fixtureB.patientId;

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
        `insert into lumen.encounters (tenant_id, patient_id, professional_id, site_id, scheduled_at)
         values ($1, $2, $3, $4, now())`,
        [tenantA, patientB, catalog.rows[0].professional_id, catalog.rows[0].site_id]
      )
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("transcribes without persisting audio, structures, resolves uncertainties and approves", async () => {
    const headers = { "x-operator-role": "advisor", "x-operator-id": operatorId };
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

    const structured = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/structure`,
      headers,
      payload: { transcript: dictation.transcript, dictationId: dictation.id }
    });
    expect(structured.statusCode).toBe(201);
    expect(structured.json().data.content.uncertainties).toHaveLength(1);

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

    const approved = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/approve`,
      headers
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.status).toBe("approved");
    expect(audits.map((event) => event.eventType)).toContain("lumen.record.approved");
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
       (tenant_id, patient_id, professional_id, site_id, scheduled_at, is_demo, demo_key)
     values ($1, $2, $3, $4, '2026-07-10T15:00:00Z', true, $5) returning id`,
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

async function cleanup(): Promise<void> {
  if (!client) return;
  await client.query(`delete from platform.tenants where slug like 'lumen-int-%'`);
}
