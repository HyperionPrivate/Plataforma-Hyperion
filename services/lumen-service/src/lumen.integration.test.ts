import type { LumenClinicalRecordContent, LumenFieldEvidenceOrigin } from "@hyperion/contracts";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LumenAuditEvent } from "./audit-client.js";
import type { ClinicalStructurer, ClinicalTranscriber } from "./clinical-ai.js";
import { registerLumenRoutes } from "./routes.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? describe : describe.skip;
const { Client } = pg;

const TEST_TRANSCRIPT =
  "Control oftalmológico. Visión estable durante el último mes. Agudeza visual OD 20/20 y OI 20/40. " +
  "PIO OD 14 mmHg y OI 16 mmHg. Biomicroscopía OD sin hallazgos y OI sin hallazgos. " +
  "Gonioscopía OD ángulo abierto y OI ángulo abierto. Fondo OD sin hallazgos; fondo OI hallazgo dudoso. " +
  "Impresión: glaucoma en estudio. Plan: control en cuatro semanas.";

const CONTENT: LumenClinicalRecordContent = {
  reasonForVisit: "Control oftalmológico",
  history: "Visión estable durante el último mes.",
  visualAcuity: { right: "20/20", left: "20/40" },
  intraocularPressure: { right: "14 mmHg", left: "16 mmHg" },
  biomicroscopy: { right: "Sin hallazgos", left: "Sin hallazgos" },
  fundus: { right: "Sin hallazgos", left: "Hallazgo por confirmar" },
  gonioscopy: { right: "Ángulo abierto", left: "Ángulo abierto" },
  assessment: [{ description: "Glaucoma en estudio", code: null, confidence: 0.9 }],
  plan: ["Control en cuatro semanas"],
  uncertainties: [{ field: "fundus.left", message: "Confirmar hallazgo", sourceText: "hallazgo dudoso" }],
  fieldEvidence: [
    { field: "reasonForVisit", confidence: 0.98, origin: "voice", sourceText: "Control oftalmológico" },
    { field: "history", confidence: 0.96, origin: "voice", sourceText: "Visión estable durante el último mes" },
    { field: "visualAcuity.right", confidence: 0.98, origin: "voice", sourceText: "OD 20/20" },
    { field: "visualAcuity.left", confidence: 0.98, origin: "voice", sourceText: "OI 20/40" },
    { field: "intraocularPressure.right", confidence: 0.98, origin: "voice", sourceText: "PIO OD 14 mmHg" },
    { field: "intraocularPressure.left", confidence: 0.98, origin: "voice", sourceText: "OI 16 mmHg" },
    {
      field: "biomicroscopy.right",
      confidence: 0.96,
      origin: "voice",
      sourceText: "Biomicroscopía OD sin hallazgos"
    },
    { field: "biomicroscopy.left", confidence: 0.96, origin: "voice", sourceText: "OI sin hallazgos" },
    { field: "gonioscopy.right", confidence: 0.95, origin: "voice", sourceText: "Gonioscopía OD ángulo abierto" },
    { field: "gonioscopy.left", confidence: 0.95, origin: "voice", sourceText: "OI ángulo abierto" },
    { field: "fundus.right", confidence: 0.95, origin: "voice", sourceText: "Fondo OD sin hallazgos" },
    { field: "fundus.left", confidence: 0.72, origin: "voice", sourceText: "fondo OI hallazgo dudoso" },
    { field: "assessment", confidence: 0.9, origin: "voice", sourceText: "Impresión: glaucoma en estudio" },
    { field: "plan", confidence: 0.94, origin: "voice", sourceText: "Plan: control en cuatro semanas" }
  ]
};

const transcriber: ClinicalTranscriber = {
  name: "test-stt",
  model: "test-stt-v1",
  isConfigured: () => true,
  transcribe: async () => ({
    transcript: TEST_TRANSCRIPT,
    provider: "test-stt",
    model: "test-stt-v1"
  })
};

let structureBarrier: { started: () => void; release: Promise<void> } | undefined;
let structureCallCount = 0;
let lastStructureOrigin: LumenFieldEvidenceOrigin | undefined;
const structurer: ClinicalStructurer = {
  name: "test-llm",
  model: "test-llm-v1",
  isConfigured: () => true,
  structure: async (_transcript, origin) => {
    structureCallCount += 1;
    lastStructureOrigin = origin;
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
let siteA: string;
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
    siteA = fixtureA.siteId;
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
    expect(own.json().data.encounter.siteId).toBe(siteA);

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

  it("does not hold encounter locks during structuring and lets approval win safely", async () => {
    const fixture = await createFixture(tenantA, "C");
    const resolvedContent = {
      ...CONTENT,
      uncertainties: [],
      fieldEvidence: [
        ...CONTENT.fieldEvidence.filter((evidence) => evidence.field !== "fundus.left"),
        { field: "fundus.left", confidence: 1, origin: "manual", sourceText: null }
      ]
    };
    const dictation = await client.query(
      `insert into lumen.dictations
         (tenant_id, encounter_id, status, transcript, mime_type, provider, metadata)
       values ($1, $2, 'transcribed', $3, 'text/plain', 'test-stt',
               '{"audioStored":false,"source":"browser_microphone"}'::jsonb)
       returning id`,
      [tenantA, fixture.encounterId, TEST_TRANSCRIPT]
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
    try {
      const structureRequest = app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/structure`,
        headers,
        payload: { transcript: "Dictado concurrente sintético sin PII." }
      });
      await providerStarted;
      const approvalRequest = app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/approve`,
        headers
      });
      const approvalOutcome = await Promise.race([
        approvalRequest.then((response) => ({ state: "settled" as const, response })),
        new Promise<{ state: "timeout" }>((resolve) => setTimeout(() => resolve({ state: "timeout" }), 2_000))
      ]);
      expect(approvalOutcome.state).toBe("settled");
      if (approvalOutcome.state !== "settled") throw new Error("approval remained blocked by provider I/O");
      expect(approvalOutcome.response.statusCode).toBe(200);
      releaseProvider();
      expect((await structureRequest).statusCode).toBe(409);
      expect(lastStructureOrigin).toBe("manual");
      const detail = await app.inject({
        method: "GET",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}`
      });
      expect(detail.json().data.dictations[0].source).toBe("browser_microphone");
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
    expect(state.rows[0]).toMatchObject({ status: "approved", uncertainties: 0 });
  });

  it("turns ungrounded provider fields into approval blockers at the route boundary", async () => {
    const fixture = await createFixture(tenantA, "D");
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/structure`,
      headers: { "x-operator-role": "advisor", "x-operator-id": operatorId },
      payload: { transcript: "Consulta sintética sin hallazgos clínicos adicionales." }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.content.fieldEvidence).toEqual([]);
    expect(response.json().data.content.uncertainties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "reasonForVisit" }),
        expect.objectContaining({ field: "intraocularPressure.left" }),
        expect.objectContaining({ field: "plan" })
      ])
    );
  });

  it("returns every missing required clinical field before approval", async () => {
    const fixture = await createFixture(tenantA, "F");
    const dictation = await client.query(
      `insert into lumen.dictations
         (tenant_id, encounter_id, status, transcript, mime_type, provider, metadata)
       values ($1, $2, 'transcribed', $3, 'text/plain', 'test-stt',
               '{"audioStored":false,"source":"browser_microphone"}'::jsonb)
       returning id`,
      [tenantA, fixture.encounterId, TEST_TRANSCRIPT]
    );
    await client.query(
      `insert into lumen.clinical_records
         (tenant_id, encounter_id, dictation_id, status, content, provider, model)
       values ($1, $2, $3, 'draft', $4::jsonb, 'test-llm', 'test-llm-v1')`,
      [
        tenantA,
        fixture.encounterId,
        dictation.rows[0].id,
        JSON.stringify({ ...CONTENT, history: "", uncertainties: [] })
      ]
    );
    await client.query(`update lumen.encounters set status = 'review' where tenant_id = $1 and id = $2`, [
      tenantA,
      fixture.encounterId
    ]);

    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/approve`,
      headers: { "x-operator-role": "advisor", "x-operator-id": operatorId }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().data.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "history" })])
    );
  });

  it("rejects approval without grounded evidence and ignores client-forged manual evidence", async () => {
    const fixture = await createFixture(tenantA, "E");
    const dictation = await client.query(
      `insert into lumen.dictations
         (tenant_id, encounter_id, status, transcript, mime_type, provider, metadata)
       values ($1, $2, 'transcribed', $3, 'text/plain', 'test-stt',
               '{"audioStored":false,"source":"browser_microphone"}'::jsonb)
       returning id`,
      [tenantA, fixture.encounterId, TEST_TRANSCRIPT]
    );
    const contentWithoutPlanEvidence = {
      ...CONTENT,
      uncertainties: [],
      fieldEvidence: CONTENT.fieldEvidence.filter((evidence) => evidence.field !== "plan")
    };
    await client.query(
      `insert into lumen.clinical_records
         (tenant_id, encounter_id, dictation_id, status, content, provider, model)
       values ($1, $2, $3, 'draft', $4::jsonb, 'test-llm', 'test-llm-v1')`,
      [tenantA, fixture.encounterId, dictation.rows[0].id, JSON.stringify(contentWithoutPlanEvidence)]
    );
    await client.query(`update lumen.encounters set status = 'review' where tenant_id = $1 and id = $2`, [
      tenantA,
      fixture.encounterId
    ]);
    const headers = { "x-operator-role": "advisor", "x-operator-id": operatorId };

    const blocked = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/approve`,
      headers
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().data.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "plan", reason: "missing" })])
    );

    const forgedPatch = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/record`,
      headers,
      payload: {
        content: {
          ...contentWithoutPlanEvidence,
          fieldEvidence: [
            ...contentWithoutPlanEvidence.fieldEvidence,
            { field: "plan", confidence: 1, origin: "manual", sourceText: null }
          ]
        }
      }
    });
    expect(forgedPatch.statusCode).toBe(200);
    expect(
      forgedPatch.json().data.content.fieldEvidence.some((evidence: { field: string }) => evidence.field === "plan")
    ).toBe(false);

    const stillBlocked = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/approve`,
      headers
    });
    expect(stillBlocked.statusCode).toBe(422);
    expect(stillBlocked.json().data.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "plan", reason: "missing" })])
    );
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
        source: "authorized_upload",
        durationSeconds: 8
      }
    });
    expect(transcription.statusCode).toBe(201);
    const dictation = transcription.json().data;
    expect(dictation.transcript).toContain("PIO");
    expect(dictation.source).toBe("authorized_upload");

    const stored = await client.query(`select metadata from lumen.dictations where tenant_id = $1 and id = $2`, [
      tenantA,
      dictation.id
    ]);
    expect(stored.rows[0].metadata).toMatchObject({ audioStored: false });
    expect(stored.rows[0].metadata).toMatchObject({ source: "authorized_upload" });

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
    expect(lastStructureOrigin).toBe("voice");
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
    const dictationAudit = await client.query(
      `select metadata from platform.audit_events
       where tenant_id = $1 and event_type = 'lumen.dictation.transcribed' and entity_id = $2`,
      [tenantA, dictation.id]
    );
    expect(dictationAudit.rows[0].metadata).toMatchObject({ source: "authorized_upload", audioStored: false });

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
      fieldEvidence: [
        {
          field: "plan",
          confidence: 1,
          origin: "manual",
          sourceText: null
        }
      ]
    };
    const patched = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/record`,
      headers,
      payload: { content: resolved }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().data.content.fieldEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "plan",
          origin: "voice",
          sourceText: "Plan: control en cuatro semanas"
        }),
        {
          field: "fundus.left",
          confidence: 1,
          origin: "manual",
          sourceText: null
        }
      ])
    );

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
      resolvedFields: ["fundus.left"],
      manualEvidenceFields: ["fundus.left"]
    });
    expect(durableReviewAudit.rows[0].metadata.reviewedSections).toEqual(
      expect.arrayContaining(["fieldEvidence", "uncertainties"])
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
          source: "browser_microphone",
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

async function createFixture(
  tenantId: string,
  suffix: string
): Promise<{ encounterId: string; patientId: string; siteId: string }> {
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
  return { encounterId: encounter.rows[0].id, patientId: patient.rows[0].id, siteId: site.rows[0].id };
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
