import type { LumenClinicalRecordContent, LumenFieldEvidenceOrigin } from "@hyperion/lumen-contracts";
import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  acquireAudioCleanupOwnerLease,
  reconcilePendingAudioCleanup,
  type AudioCleanupLease
} from "./audio-cleanup-recovery.js";
import type { ClinicalStructurer } from "./clinical-ai.js";
import { SpeechToTextError } from "./provider-errors.js";
import { processingResultSnapshotSha256 } from "./processing-attempts.js";
import { registerLumenRoutes } from "./routes.js";
import type { SpeechToTextProvider } from "./speech-to-text.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_LUMEN_FIXTURE_DATABASE_URL = process.env.TEST_LUMEN_FIXTURE_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL && TEST_LUMEN_FIXTURE_DATABASE_URL ? describe : describe.skip;
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

function validWebmAudioBase64(fill = 0): string {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28, fill)]).toString("base64");
}

function sha256ForTest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

let transcriptionCallCount = 0;
let nextTranscriptionError: SpeechToTextError | undefined;
let nextVerifiedTranscriptionDurationSeconds: number | undefined;
let transcriptionBarrier: { started: () => void; release: Promise<void> } | undefined;
const transcriber: SpeechToTextProvider = {
  name: "test-stt",
  model: "test-stt-v1",
  language: "spa",
  isConfigured: () => true,
  transcribe: async (input) => {
    transcriptionCallCount += 1;
    if (nextTranscriptionError) {
      const error = nextTranscriptionError;
      nextTranscriptionError = undefined;
      throw error;
    }
    transcriptionBarrier?.started();
    if (transcriptionBarrier) await transcriptionBarrier.release;
    const verifiedDurationSeconds = nextVerifiedTranscriptionDurationSeconds ?? input.durationSeconds;
    nextVerifiedTranscriptionDurationSeconds = undefined;
    return {
      transcript: TEST_TRANSCRIPT,
      provider: "test-stt",
      model: "test-stt-v1",
      language: "spa",
      durationSeconds: verifiedDurationSeconds,
      audioSha256: input.audioSha256 ?? "0".repeat(64),
      requestIdHash: "1".repeat(64),
      traceIdHash: "2".repeat(64),
      temporaryAudioDeleted: true
    };
  }
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
let fixtureClient: pg.Client;
let tenantA: string;
let tenantB: string;
let encounterA: string;
let patientA: string;
let patientB: string;
let siteA: string;
let operatorId: string;

describeIntegration("LUMEN clinical vertical", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    client = new Client({ connectionString: TEST_DATABASE_URL });
    fixtureClient = new Client({ connectionString: TEST_LUMEN_FIXTURE_DATABASE_URL });
    await Promise.all([client.connect(), fixtureClient.connect()]);
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
        registerLumenRoutes(serviceApp, context, {
          transcriber,
          structurer,
          audioCleanupOwner: "lumen-integration-1"
        })
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([client?.end(), fixtureClient?.end()]);
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

  it("makes real-audio transcription idempotent and tenant-scoped without persisting audio", async () => {
    const fixture = await createFixture(tenantA, "IDEMP-A");
    const tenantBFixture = await createFixture(tenantB, "IDEMP-B");
    const operatorB = await createOperator(tenantB);
    const idempotencyKey = randomUUID();
    const payload = {
      audioBase64: validWebmAudioBase64(0x11),
      mimeType: "audio/webm" as const,
      source: "authorized_upload" as const,
      durationSeconds: 8,
      idempotencyKey
    };
    const callsBefore = transcriptionCallCount;
    const headersA = { "x-operator-role": "advisor", "x-operator-id": operatorId };
    nextVerifiedTranscriptionDurationSeconds = 12.6;

    const first = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
      headers: headersA,
      payload
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data.durationSeconds).toBe(13);
    expect(transcriptionCallCount).toBe(callsBefore + 1);

    const replay = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
      headers: headersA,
      payload
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect(transcriptionCallCount).toBe(callsBefore + 1);

    const mismatch = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
      headers: headersA,
      payload: { ...payload, audioBase64: validWebmAudioBase64(0x22) }
    });
    expect(mismatch.statusCode).toBe(409);
    expect(transcriptionCallCount).toBe(callsBefore + 1);

    const otherTenant = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantB}/lumen/encounters/${tenantBFixture.encounterId}/transcriptions`,
      headers: { "x-operator-role": "advisor", "x-operator-id": operatorB },
      payload
    });
    expect(otherTenant.statusCode).toBe(201);
    expect(otherTenant.json().data.id).not.toBe(first.json().data.id);
    expect(transcriptionCallCount).toBe(callsBefore + 2);

    const trace = await client.query(
      `select status, request_id_hash, trace_id_hash, temp_audio_deleted_at, duration_seconds,
              to_jsonb(attempt)::text as serialized
       from lumen.processing_attempts attempt
       where tenant_id = $1 and encounter_id = $2 and operation = 'transcription'`,
      [tenantA, fixture.encounterId]
    );
    expect(trace.rowCount).toBe(1);
    expect(trace.rows[0]).toMatchObject({
      status: "completed",
      request_id_hash: "1".repeat(64),
      trace_id_hash: "2".repeat(64)
    });
    expect(trace.rows[0].duration_seconds).toBe(payload.durationSeconds);
    expect(trace.rows[0].temp_audio_deleted_at).toBeTruthy();
    expect(trace.rows[0].serialized).not.toContain(payload.audioBase64);
    expect(trace.rows[0].serialized).not.toContain(TEST_TRANSCRIPT);

    const audit = await client.query(
      `select (payload->'metadata')::text as metadata
       from lumen.outbox_events
       where tenant_id = $1 and payload->>'eventType' = 'lumen.dictation.transcribed'
         and payload->'metadata'->>'encounterId' = $2`,
      [tenantA, fixture.encounterId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].metadata).not.toContain(TEST_TRANSCRIPT);
    expect(audit.rows[0].metadata).not.toContain(payload.audioBase64);
  });

  it("deduplicates concurrent STT requests before calling the provider", async () => {
    const fixture = await createFixture(tenantA, "STT-CONCURRENT");
    const headers = { "x-operator-role": "advisor", "x-operator-id": operatorId };
    const payload = {
      audioBase64: validWebmAudioBase64(0x44),
      mimeType: "audio/webm",
      source: "browser_microphone",
      durationSeconds: 5,
      idempotencyKey: randomUUID()
    };
    let notifyStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerRelease = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    transcriptionBarrier = { started: notifyStarted, release: providerRelease };
    const callsBefore = transcriptionCallCount;

    try {
      const first = app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
        headers,
        payload
      });
      await providerStarted;
      const duplicate = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
        headers,
        payload
      });
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.headers["retry-after"]).toBe("2");
      expect(transcriptionCallCount).toBe(callsBefore + 1);
      releaseProvider();
      expect((await first).statusCode).toBe(201);
      expect(transcriptionCallCount).toBe(callsBefore + 1);
    } finally {
      releaseProvider();
      transcriptionBarrier = undefined;
    }
  });

  it("records sanitized recoverable STT failures with confirmed temporary cleanup", async () => {
    const fixture = await createFixture(tenantA, "STT-FAIL");
    const idempotencyKey = randomUUID();
    const payload = {
      audioBase64: validWebmAudioBase64(0x33),
      mimeType: "audio/webm",
      source: "browser_microphone",
      durationSeconds: 4,
      idempotencyKey
    };
    const headers = { "x-operator-role": "advisor", "x-operator-id": operatorId };
    const callsBefore = transcriptionCallCount;
    nextTranscriptionError = new SpeechToTextError("network", "ElevenLabs STT transport failed", {
      provider: "test-stt",
      retryable: true,
      temporaryAudioDeleted: true
    });

    try {
      const failed = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
        headers,
        payload
      });
      expect(failed.statusCode).toBe(502);
      expect(failed.json().data).toMatchObject({ code: "network", retryable: true });
      expect(transcriptionCallCount).toBe(callsBefore + 1);

      const attempt = await client.query(
        `select status, error_code, temp_audio_deleted_at
         from lumen.processing_attempts
         where tenant_id = $1 and encounter_id = $2 and idempotency_key = $3`,
        [tenantA, fixture.encounterId, idempotencyKey]
      );
      expect(attempt.rows[0]).toMatchObject({ status: "failed", error_code: "network" });
      expect(attempt.rows[0].temp_audio_deleted_at).toBeTruthy();

      const dictations = await client.query(
        `select count(*)::int as count from lumen.dictations where tenant_id = $1 and encounter_id = $2`,
        [tenantA, fixture.encounterId]
      );
      expect(dictations.rows[0].count).toBe(0);

      const repeatedFailure = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
        headers,
        payload
      });
      expect(repeatedFailure.statusCode).toBe(409);
      expect(transcriptionCallCount).toBe(callsBefore + 1);

      const retry = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
        headers,
        payload: { ...payload, idempotencyKey: randomUUID() }
      });
      expect(retry.statusCode).toBe(201);
      expect(transcriptionCallCount).toBe(callsBefore + 2);
    } finally {
      nextTranscriptionError = undefined;
    }
  });

  it("holds an rm failure in cleanup_pending and terminalizes it only after a successful retry", async () => {
    const fixture = await createFixture(tenantA, "STT-CLEANUP-RETRY");
    const idempotencyKey = randomUUID();
    const payload = {
      audioBase64: validWebmAudioBase64(0x35),
      mimeType: "audio/webm",
      source: "authorized_upload",
      durationSeconds: 4,
      idempotencyKey
    };
    nextTranscriptionError = new SpeechToTextError("temporary_storage", "Private temporary audio handling failed", {
      provider: "test-stt",
      retryable: true,
      temporaryAudioDeleted: false
    });

    try {
      const failed = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
        headers: { "x-operator-role": "advisor", "x-operator-id": operatorId },
        payload
      });
      expect(failed.statusCode).toBe(502);

      const pending = await client.query(
        `select id, status, cleanup_owner, cleanup_target_status, error_code, temp_audio_deleted_at
         from lumen.processing_attempts
         where tenant_id = $1 and encounter_id = $2 and idempotency_key = $3`,
        [tenantA, fixture.encounterId, idempotencyKey]
      );
      expect(pending.rows[0]).toMatchObject({
        status: "cleanup_pending",
        cleanup_owner: "lumen-integration-1",
        cleanup_target_status: "failed",
        error_code: "temporary_storage",
        temp_audio_deleted_at: null
      });

      const repeated = await app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${fixture.encounterId}/transcriptions`,
        headers: { "x-operator-role": "advisor", "x-operator-id": operatorId },
        payload
      });
      expect(repeated.statusCode).toBe(409);
      expect(repeated.headers["retry-after"]).toBe("5");

      const removeDirectory = vi.fn(async () => undefined);
      const cleanupLease: AudioCleanupLease = {
        owner: "lumen-integration-1",
        holderId: randomUUID(),
        ttlMs: 30 * 60_000
      };
      await expect(acquireAudioCleanupOwnerLease(client, cleanupLease)).resolves.toBe(true);
      await expect(
        reconcilePendingAudioCleanup(
          client,
          {
            owner: "lumen-integration-1",
            rootDirectory: "C:/deterministic-test-root",
            batchSize: 25
          },
          cleanupLease,
          { removeDirectory }
        )
      ).resolves.toEqual({ attempted: 1, completed: 1, failed: 0 });
      expect(removeDirectory).toHaveBeenCalledWith(expect.stringContaining(`attempt-${pending.rows[0].id}`));

      const terminal = await client.query(
        `select status, cleanup_target_status, error_code, temp_audio_deleted_at
         from lumen.processing_attempts where id = $1`,
        [pending.rows[0].id]
      );
      expect(terminal.rows[0]).toMatchObject({
        status: "failed",
        cleanup_target_status: null,
        error_code: "temporary_storage"
      });
      expect(terminal.rows[0].temp_audio_deleted_at).toBeTruthy();
      await client.query(
        `delete from lumen.audio_cleanup_owner_leases
          where cleanup_owner = $1 and holder_id = $2::uuid`,
        [cleanupLease.owner, cleanupLease.holderId]
      );
    } finally {
      nextTranscriptionError = undefined;
    }
  });

  it("blocks direct cross-tenant encounter references", async () => {
    const catalog = await client.query(
      `select e.professional_id, e.site_id from lumen.encounters e where e.tenant_id = $1 and e.id = $2`,
      [tenantA, encounterA]
    );
    await expect(
      fixtureClient.query(
        `insert into lumen.encounters
           (tenant_id, patient_id, professional_id, site_id, scheduled_at, is_demo, demo_key, metadata)
         values ($1, $2, $3, $4, now(), true, 'cross-tenant', '{"synthetic":true}'::jsonb)`,
        [tenantA, patientB, catalog.rows[0].professional_id, catalog.rows[0].site_id]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects encounters without a matching local synthetic reference snapshot", async () => {
    const patientId = randomUUID();
    const catalog = await client.query(
      `select professional_id, site_id from lumen.encounters where tenant_id = $1 and id = $2`,
      [tenantA, encounterA]
    );
    await expect(
      fixtureClient.query(
        `insert into lumen.encounters
           (tenant_id, patient_id, professional_id, site_id, scheduled_at, is_demo, demo_key, metadata)
         values ($1, $2, $3, $4, now(), true, 'non-demo-reference', '{"synthetic":true}'::jsonb)`,
        [tenantA, patientId, catalog.rows[0].professional_id, catalog.rows[0].site_id]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps synthetic identity markers and approval transitions database-enforced", async () => {
    await expect(
      fixtureClient.query(
        `update lumen.encounter_reference_snapshots
         set patient_is_demo = false
         where tenant_id = $1 and patient_id = $2`,
        [tenantA, patientA]
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixtureClient.query(`update lumen.encounters set status = 'approved' where tenant_id = $1 and id = $2`, [
        tenantA,
        encounterA
      ])
    ).rejects.toMatchObject({ code: "23514" });

    const failedDictation = await fixtureClient.query(
      `insert into lumen.dictations
         (tenant_id, encounter_id, status, mime_type, provider, error_code, metadata)
       values ($1, $2, 'failed', 'audio/webm', 'test-stt', 'ProviderError', '{"audioStored":false}'::jsonb)
       returning id`,
      [tenantA, encounterA]
    );
    await expect(
      fixtureClient.query(
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
    const dictationId = await createCompletedAudioDictation(tenantA, fixture.encounterId, TEST_TRANSCRIPT);
    await fixtureClient.query(
      `insert into lumen.clinical_records
         (tenant_id, encounter_id, dictation_id, status, content, provider, model)
       values ($1, $2, $3, 'draft', $4::jsonb, 'test-llm', 'test-llm-v1')`,
      [tenantA, fixture.encounterId, dictationId, JSON.stringify(resolvedContent)]
    );
    await fixtureClient.query(`update lumen.encounters set status = 'review' where tenant_id = $1 and id = $2`, [
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
        payload: { transcript: "Dictado concurrente sintético sin PII.", idempotencyKey: randomUUID() }
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
      payload: {
        transcript: "Consulta sintética sin hallazgos clínicos adicionales.",
        idempotencyKey: randomUUID()
      }
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
    const dictationId = await createCompletedAudioDictation(tenantA, fixture.encounterId, TEST_TRANSCRIPT);
    await fixtureClient.query(
      `insert into lumen.clinical_records
         (tenant_id, encounter_id, dictation_id, status, content, provider, model)
       values ($1, $2, $3, 'draft', $4::jsonb, 'test-llm', 'test-llm-v1')`,
      [tenantA, fixture.encounterId, dictationId, JSON.stringify({ ...CONTENT, history: "", uncertainties: [] })]
    );
    await fixtureClient.query(`update lumen.encounters set status = 'review' where tenant_id = $1 and id = $2`, [
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
    const dictationId = await createCompletedAudioDictation(tenantA, fixture.encounterId, TEST_TRANSCRIPT);
    const contentWithoutPlanEvidence = {
      ...CONTENT,
      uncertainties: [],
      fieldEvidence: CONTENT.fieldEvidence.filter((evidence) => evidence.field !== "plan")
    };
    await fixtureClient.query(
      `insert into lumen.clinical_records
         (tenant_id, encounter_id, dictation_id, status, content, provider, model)
       values ($1, $2, $3, 'draft', $4::jsonb, 'test-llm', 'test-llm-v1')`,
      [tenantA, fixture.encounterId, dictationId, JSON.stringify(contentWithoutPlanEvidence)]
    );
    await fixtureClient.query(`update lumen.encounters set status = 'review' where tenant_id = $1 and id = $2`, [
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
        audioBase64: validWebmAudioBase64(),
        mimeType: "audio/webm",
        source: "authorized_upload",
        durationSeconds: 8,
        idempotencyKey: randomUUID()
      }
    });
    expect(transcription.statusCode).toBe(201);
    const dictation = transcription.json().data;
    expect(dictation.transcript).toContain("PIO");
    expect(dictation.source).toBe("authorized_upload");

    const stored = await client.query(
      `select metadata, transcript, provider_transcript, processing_attempt_id,
              reviewed_at, reviewed_by
       from lumen.dictations where tenant_id = $1 and id = $2`,
      [tenantA, dictation.id]
    );
    expect(stored.rows[0].metadata).toMatchObject({ audioStored: false });
    expect(stored.rows[0].metadata).toMatchObject({ source: "authorized_upload" });
    expect(stored.rows[0].provider_transcript).toBe(dictation.transcript);
    expect(stored.rows[0].processing_attempt_id).toBeTruthy();
    expect(stored.rows[0].reviewed_at).toBeNull();

    const reviewedTranscript = `${dictation.transcript} Texto editado por la revisión humana.`;
    const structureIdempotencyKey = randomUUID();
    const structureCallsBefore = structureCallCount;
    const structured = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/structure`,
      headers,
      payload: {
        transcript: reviewedTranscript,
        dictationId: dictation.id,
        idempotencyKey: structureIdempotencyKey
      }
    });
    expect(structured.statusCode).toBe(201);
    const exactStructuredDraft = structured.json().data;
    expect(exactStructuredDraft.status).toBe("draft");
    expect(lastStructureOrigin).toBe("voice_reviewed");
    expect(structured.json().data.content.uncertainties).toHaveLength(1);
    expect(structureCallCount).toBe(structureCallsBefore + 1);

    const structureReplay = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/structure`,
      headers,
      payload: {
        transcript: reviewedTranscript,
        dictationId: dictation.id,
        idempotencyKey: structureIdempotencyKey
      }
    });
    expect(structureReplay.statusCode).toBe(200);
    expect(structureReplay.headers["x-idempotent-replay"]).toBe("true");
    expect(structureReplay.json().data).toEqual(exactStructuredDraft);
    expect(structureCallCount).toBe(structureCallsBefore + 1);

    const immutableStructureResult = await client.query(
      `select result_snapshot, result_sha256, result_version
       from lumen.processing_attempts
       where tenant_id = $1 and encounter_id = $2 and operation = 'structuring'
         and idempotency_key = $3`,
      [tenantA, encounterA, structureIdempotencyKey]
    );
    expect(immutableStructureResult.rows[0].result_snapshot).toEqual(exactStructuredDraft);
    expect(immutableStructureResult.rows[0].result_sha256).toBe(processingResultSnapshotSha256(exactStructuredDraft));
    expect(immutableStructureResult.rows[0].result_version.toISOString()).toBe(exactStructuredDraft.updatedAt);

    const reviewedStored = await client.query(
      `select transcript, provider_transcript, reviewed_at, reviewed_by
       from lumen.dictations where tenant_id = $1 and id = $2`,
      [tenantA, dictation.id]
    );
    expect(reviewedStored.rows[0]).toMatchObject({
      transcript: reviewedTranscript,
      provider_transcript: dictation.transcript,
      reviewed_by: operatorId
    });
    expect(reviewedStored.rows[0].reviewed_at).toBeTruthy();
    await expect(
      fixtureClient.query(
        `update lumen.dictations set provider_transcript = 'altered'
         where tenant_id = $1 and id = $2`,
        [tenantA, dictation.id]
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixtureClient.query(
        `update lumen.processing_attempts set model = 'altered'
         where id = $1`,
        [stored.rows[0].processing_attempt_id]
      )
    ).rejects.toMatchObject({ code: "23514" });

    const durableProcessAudit = await client.query(
      `select payload->>'eventType' as event_type, count(*)::int as count
       from lumen.outbox_events
       where tenant_id = $1
         and payload->>'eventType' in ('lumen.encounter.started', 'lumen.dictation.transcribed', 'lumen.record.structured')
         and (payload->>'entityId' = $2 or payload->'metadata'->>'encounterId' = $2)
       group by payload->>'eventType'`,
      [tenantA, encounterA]
    );
    expect(Object.fromEntries(durableProcessAudit.rows.map((row) => [row.event_type, row.count]))).toEqual({
      "lumen.dictation.transcribed": 1,
      "lumen.encounter.started": 1,
      "lumen.record.structured": 1
    });
    const dictationAudit = await client.query(
      `select payload->'metadata' as metadata from lumen.outbox_events
       where tenant_id = $1 and payload->>'eventType' = 'lumen.dictation.transcribed'
         and payload->>'entityId' = $2`,
      [tenantA, dictation.id]
    );
    expect(dictationAudit.rows[0].metadata).toMatchObject({ source: "authorized_upload", audioStored: false });
    const transcriptReviewAudit = await client.query(
      `select (payload->'metadata')::text as metadata
       from lumen.outbox_events
       where tenant_id = $1 and payload->>'eventType' = 'lumen.dictation.reviewed'
         and payload->>'entityId' = $2`,
      [tenantA, dictation.id]
    );
    expect(transcriptReviewAudit.rowCount).toBe(1);
    expect(transcriptReviewAudit.rows[0].metadata).toContain(sha256ForTest(reviewedTranscript));
    expect(transcriptReviewAudit.rows[0].metadata).not.toContain(reviewedTranscript);
    expect(transcriptReviewAudit.rows[0].metadata).not.toContain(dictation.transcript);

    await expect(
      fixtureClient.query(
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
      fixtureClient.query(
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
          origin: "voice_reviewed",
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

    const replayAfterMutableReview = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/structure`,
      headers,
      payload: {
        transcript: reviewedTranscript,
        dictationId: dictation.id,
        idempotencyKey: structureIdempotencyKey
      }
    });
    expect(replayAfterMutableReview.statusCode).toBe(200);
    expect(replayAfterMutableReview.headers["x-idempotent-replay"]).toBe("true");
    expect(replayAfterMutableReview.json().data).toEqual(exactStructuredDraft);
    expect(replayAfterMutableReview.json().data).not.toEqual(patched.json().data);
    expect(structureCallCount).toBe(structureCallsBefore + 1);

    const durableReviewAudit = await client.query(
      `select payload->'metadata' as metadata from lumen.outbox_events
       where tenant_id = $1 and payload->>'eventType' = 'lumen.record.reviewed'
         and payload->>'entityId' = $2 and payload->>'actorId' = $3`,
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
      `select count(*)::int as count,
              bool_and(event_type = 'lumen.audit.event.record.v1') as source_scoped
       from lumen.outbox_events
       where tenant_id = $1 and payload->>'eventType' = 'lumen.record.approved'
         and payload->>'entityId' = $2`,
      [tenantA, approved.json().data.id]
    );
    expect(durableAudit.rows[0].count).toBe(1);
    expect(durableAudit.rows[0].source_scoped).toBe(true);

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
          audioBase64: validWebmAudioBase64(),
          mimeType: "audio/webm",
          source: "browser_microphone",
          durationSeconds: 2,
          idempotencyKey: randomUUID()
        }
      }),
      app.inject({
        method: "POST",
        url: `/v1/tenants/${tenantA}/lumen/encounters/${encounterA}/structure`,
        headers,
        payload: { transcript: "Transcript manual posterior a aprobación.", idempotencyKey: randomUUID() }
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
      fixtureClient.query(
        `update lumen.clinical_records set content = jsonb_set(content, '{history}', '"alterada"'::jsonb)
         where tenant_id = $1 and encounter_id = $2`,
        [tenantA, encounterA]
      )
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixtureClient.query(`delete from lumen.clinical_records where tenant_id = $1 and encounter_id = $2`, [
        tenantA,
        encounterA
      ])
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixtureClient.query(
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
  const tenantId = randomUUID();
  await fixtureClient.query(
    `insert into lumen.tenant_snapshots (
       tenant_id, status, is_demo, is_active, source_version, source_updated_at, payload_hash
     ) values ($1, 'active', true, true, 1, now(), $2)`,
    [tenantId, sha256ForTest(`tenant:${slug}:${tenantId}:1`)]
  );
  return tenantId;
}

async function createFixture(
  tenantId: string,
  suffix: string
): Promise<{ encounterId: string; patientId: string; siteId: string }> {
  const encounterId = randomUUID();
  const patientId = randomUUID();
  const professionalId = randomUUID();
  const siteId = randomUUID();
  await fixtureClient.query(
    `insert into lumen.encounter_reference_snapshots (
       tenant_id, encounter_id, patient_id, site_id, professional_id,
       patient_display_name, patient_age, professional_name, site_name,
       patient_is_demo, professional_is_demo, source_version, source_updated_at, payload_hash
     ) values ($1, $2, $3, $4, $5, $6, 54, $7, $8, true, true, 1, now(), $9)`,
    [
      tenantId,
      encounterId,
      patientId,
      siteId,
      professionalId,
      `Paciente ${suffix}`,
      `Profesional ${suffix}`,
      `Sede ${suffix}`,
      sha256ForTest(`reference:${tenantId}:${encounterId}:1`)
    ]
  );
  const encounter = await fixtureClient.query(
    `insert into lumen.encounters
       (id, tenant_id, patient_id, professional_id, site_id, scheduled_at, is_demo, demo_key, metadata)
     values ($2, $1, $3, $4, $5, '2026-07-10T15:00:00Z', true, $6, '{"synthetic":true}'::jsonb)
     returning id`,
    [tenantId, encounterId, patientId, professionalId, siteId, `integration-${suffix}`]
  );
  await fixtureClient.query(
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
  return { encounterId: encounter.rows[0].id, patientId, siteId };
}

async function createOperator(tenantId: string): Promise<string> {
  const operatorId = randomUUID();
  await fixtureClient.query(
    `insert into lumen.operator_grants (
       operator_id, tenant_id, role, is_active, can_review,
       source_version, source_updated_at, payload_hash
     ) values ($1, $2, 'advisor', true, true, 1, now(), $3)`,
    [operatorId, tenantId, sha256ForTest(`operator:${tenantId}:${operatorId}:1`)]
  );
  return operatorId;
}

async function createCompletedAudioDictation(
  tenantId: string,
  encounterId: string,
  transcript: string
): Promise<string> {
  const attempt = await fixtureClient.query(
    `insert into lumen.processing_attempts
       (tenant_id, encounter_id, operation, idempotency_key, input_sha256,
        provider, model, mime_type, source, duration_seconds, cleanup_protocol, cleanup_owner)
     values ($1, $2, 'transcription', $3, $4, 'test-stt', 'test-stt-v1',
             'audio/webm', 'browser_microphone', 8, 'deterministic_v2', 'lumen-integration-1')
     returning id`,
    [tenantId, encounterId, randomUUID(), sha256ForTest(`fixture-audio:${transcript}`)]
  );
  const dictation = await fixtureClient.query(
    `insert into lumen.dictations
       (tenant_id, encounter_id, status, transcript, mime_type, provider, model,
        duration_seconds, metadata, provider_transcript, processing_attempt_id)
     values ($1, $2, 'transcribed', $3, 'audio/webm', 'test-stt', 'test-stt-v1', 8,
             '{"audioStored":false,"source":"browser_microphone","temporaryAudioDeleted":true}'::jsonb,
             $3, $4)
     returning id`,
    [tenantId, encounterId, transcript, attempt.rows[0].id]
  );
  await fixtureClient.query(
    `update lumen.processing_attempts
     set status = 'completed', result_entity_id = $2, completed_at = now(),
         temp_audio_deleted_at = now(), updated_at = now()
     where id = $1`,
    [attempt.rows[0].id, dictation.rows[0].id]
  );
  return dictation.rows[0].id;
}
