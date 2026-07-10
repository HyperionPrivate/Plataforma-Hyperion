import {
  envelope,
  lumenClinicalRecordContentSchema,
  lumenClinicalRecordPatchSchema,
  lumenClinicalRecordSchema,
  lumenDictationSchema,
  lumenEncounterDetailSchema,
  lumenPreconsultationSummarySchema,
  lumenStructureInputSchema,
  lumenTranscriptionInputSchema,
  lumenWorklistEntrySchema,
  tenantIdSchema,
  type LumenClinicalRecord,
  type LumenEncounterDetail,
  type LumenWorklistEntry
} from "@hyperion/contracts";
import type { DatabaseClient } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";
import type { LumenAuditEmitter } from "./audit-client.js";
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type ClinicalStructurer,
  type ClinicalTranscriber
} from "./clinical-ai.js";

export interface LumenRouteDependencies {
  transcriber: ClinicalTranscriber;
  structurer: ClinicalStructurer;
  emitAudit: LumenAuditEmitter;
}

interface WorklistRow {
  encounterId: string;
  tenantId: string;
  patientId: string;
  patientDisplayName: string;
  patientAge: number | null;
  professionalName: string;
  siteName: string;
  scheduledAt: Date | string;
  status: string;
  isDemo: boolean;
}

interface DictationRow {
  id: string;
  tenantId: string;
  encounterId: string;
  status: string;
  transcript: string;
  mimeType: string;
  provider: string | null;
  model: string | null;
  durationSeconds: number | null;
  createdAt: Date | string;
}

interface RecordRow {
  id: string;
  tenantId: string;
  encounterId: string;
  dictationId: string | null;
  status: string;
  schemaVersion: string;
  content: unknown;
  provider: string | null;
  model: string | null;
  approvedBy: string | null;
  approvedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export async function registerLumenRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  dependencies: LumenRouteDependencies
): Promise<void> {
  app.get("/v1/tenants/:tenantId/lumen/worklist", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const rows = await fetchWorklist(scope.db, scope.tenantId);
    return envelope(rows, request.id);
  });

  app.get("/v1/tenants/:tenantId/lumen/encounters/:encounterId", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const encounterId = readUuid(request.params, "encounterId");
    if (!encounterId) return reply.code(400).send(envelope({ error: "encounterId must be a UUID" }, request.id));

    const detail = await loadEncounterDetail(scope.db, scope.tenantId, encounterId);
    if (!detail) return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
    return envelope(detail, request.id);
  });

  app.post("/v1/tenants/:tenantId/lumen/encounters/:encounterId/start", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!requireClinicalWrite(request, reply)) return;
    const encounterId = readUuid(request.params, "encounterId");
    if (!encounterId) return reply.code(400).send(envelope({ error: "encounterId must be a UUID" }, request.id));

    const result = await scope.db.query(
      `update lumen.encounters
       set status = case when status = 'preconsultation' then 'in_progress' else status end,
           updated_at = now()
       where tenant_id = $1 and id = $2
       returning id`,
      [scope.tenantId, encounterId]
    );
    if (result.rowCount === 0) return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));

    dependencies.emitAudit({
      tenantId: scope.tenantId,
      actorId: readOperatorId(request),
      eventType: "lumen.encounter.started",
      entityType: "lumen_encounter",
      entityId: encounterId
    });
    const detail = await loadEncounterDetail(scope.db, scope.tenantId, encounterId);
    return envelope(detail, request.id);
  });

  app.post("/v1/tenants/:tenantId/lumen/encounters/:encounterId/transcriptions", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!requireClinicalWrite(request, reply)) return;
    const encounterId = readUuid(request.params, "encounterId");
    if (!encounterId) return reply.code(400).send(envelope({ error: "encounterId must be a UUID" }, request.id));
    const input = parseBody(lumenTranscriptionInputSchema, request, reply);
    if (!input) return;
    if (!(await encounterExists(scope.db, scope.tenantId, encounterId))) {
      return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
    }
    if (!dependencies.transcriber.isConfigured()) {
      return reply.code(503).send(envelope({ error: "Clinical transcription provider is not configured" }, request.id));
    }

    try {
      const transcription = await dependencies.transcriber.transcribe(input.audioBase64, input.mimeType);
      const result = await scope.db.query<DictationRow>(
        `insert into lumen.dictations
           (tenant_id, encounter_id, status, transcript, mime_type, provider, model, duration_seconds,
            metadata)
         values ($1, $2, 'transcribed', $3, $4, $5, $6, $7,
                 '{"audioStored":false,"source":"browser_microphone"}'::jsonb)
         returning id, tenant_id as "tenantId", encounter_id as "encounterId", status,
                   transcript, mime_type as "mimeType", provider, model,
                   duration_seconds as "durationSeconds", created_at as "createdAt"`,
        [
          scope.tenantId,
          encounterId,
          transcription.transcript,
          input.mimeType,
          transcription.provider,
          transcription.model,
          input.durationSeconds ?? null
        ]
      );
      await scope.db.query(
        `update lumen.encounters set status = 'in_progress', updated_at = now()
         where tenant_id = $1 and id = $2 and status <> 'approved'`,
        [scope.tenantId, encounterId]
      );
      const dictation = lumenDictationSchema.parse(result.rows[0]);
      dependencies.emitAudit({
        tenantId: scope.tenantId,
        actorId: readOperatorId(request),
        eventType: "lumen.dictation.transcribed",
        entityType: "lumen_dictation",
        entityId: dictation.id,
        metadata: { encounterId, provider: transcription.provider, model: transcription.model, audioStored: false }
      });
      return reply.code(201).send(envelope(dictation, request.id));
    } catch (error) {
      await scope.db.query(
        `insert into lumen.dictations
           (tenant_id, encounter_id, status, mime_type, provider, model, duration_seconds, error_code,
            metadata)
         values ($1, $2, 'failed', $3, $4, $5, $6, $7,
                 '{"audioStored":false,"source":"browser_microphone"}'::jsonb)`,
        [
          scope.tenantId,
          encounterId,
          input.mimeType,
          dependencies.transcriber.name,
          dependencies.transcriber.model,
          input.durationSeconds ?? null,
          error instanceof Error ? error.name.slice(0, 120) : "ProviderError"
        ]
      );
      return sendProviderError(reply, request, error);
    }
  });

  app.post("/v1/tenants/:tenantId/lumen/encounters/:encounterId/structure", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!requireClinicalWrite(request, reply)) return;
    const encounterId = readUuid(request.params, "encounterId");
    if (!encounterId) return reply.code(400).send(envelope({ error: "encounterId must be a UUID" }, request.id));
    const input = parseBody(lumenStructureInputSchema, request, reply);
    if (!input) return;
    if (!(await encounterExists(scope.db, scope.tenantId, encounterId))) {
      return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
    }
    if (!dependencies.structurer.isConfigured()) {
      return reply.code(503).send(envelope({ error: "Clinical structuring provider is not configured" }, request.id));
    }

    let dictationId = input.dictationId;
    if (dictationId) {
      const result = await scope.db.query(
        `select 1 from lumen.dictations where tenant_id = $1 and encounter_id = $2 and id = $3`,
        [scope.tenantId, encounterId, dictationId]
      );
      if (result.rowCount === 0) {
        return reply.code(422).send(envelope({ error: "dictationId does not belong to this encounter" }, request.id));
      }
    } else {
      const result = await scope.db.query<{ id: string }>(
        `insert into lumen.dictations
           (tenant_id, encounter_id, status, transcript, mime_type, provider, metadata)
         values ($1, $2, 'transcribed', $3, 'text/plain', 'manual', '{"audioStored":false}'::jsonb)
         returning id`,
        [scope.tenantId, encounterId, input.transcript]
      );
      dictationId = result.rows[0]!.id;
    }

    try {
      const structured = await dependencies.structurer.structure(input.transcript);
      const result = await scope.db.query<RecordRow>(
        `insert into lumen.clinical_records
           (tenant_id, encounter_id, dictation_id, status, content, provider, model)
         values ($1, $2, $3, 'draft', $4::jsonb, $5, $6)
         on conflict (tenant_id, encounter_id) do update set
           dictation_id = excluded.dictation_id,
           content = excluded.content,
           provider = excluded.provider,
           model = excluded.model,
           updated_at = now()
         where lumen.clinical_records.status = 'draft'
         returning id, tenant_id as "tenantId", encounter_id as "encounterId",
                   dictation_id as "dictationId", status, schema_version as "schemaVersion",
                   content, provider, model, approved_by as "approvedBy",
                   approved_at as "approvedAt", created_at as "createdAt", updated_at as "updatedAt"`,
        [
          scope.tenantId,
          encounterId,
          dictationId,
          JSON.stringify(structured.content),
          structured.provider,
          structured.model
        ]
      );
      if (result.rowCount === 0) {
        return reply.code(409).send(envelope({ error: "Approved clinical records cannot be replaced" }, request.id));
      }
      await scope.db.query(
        `update lumen.encounters set status = 'review', updated_at = now()
         where tenant_id = $1 and id = $2 and status <> 'approved'`,
        [scope.tenantId, encounterId]
      );
      const record = parseRecord(result.rows[0]!);
      dependencies.emitAudit({
        tenantId: scope.tenantId,
        actorId: readOperatorId(request),
        eventType: "lumen.record.structured",
        entityType: "lumen_clinical_record",
        entityId: record.id,
        metadata: { encounterId, dictationId, provider: structured.provider, model: structured.model }
      });
      return reply.code(201).send(envelope(record, request.id));
    } catch (error) {
      return sendProviderError(reply, request, error);
    }
  });

  app.patch("/v1/tenants/:tenantId/lumen/encounters/:encounterId/record", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!requireClinicalWrite(request, reply)) return;
    const encounterId = readUuid(request.params, "encounterId");
    if (!encounterId) return reply.code(400).send(envelope({ error: "encounterId must be a UUID" }, request.id));
    const input = parseBody(lumenClinicalRecordPatchSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query<RecordRow>(
      `update lumen.clinical_records
       set content = $3::jsonb, updated_at = now()
       where tenant_id = $1 and encounter_id = $2 and status = 'draft'
       returning id, tenant_id as "tenantId", encounter_id as "encounterId",
                 dictation_id as "dictationId", status, schema_version as "schemaVersion",
                 content, provider, model, approved_by as "approvedBy",
                 approved_at as "approvedAt", created_at as "createdAt", updated_at as "updatedAt"`,
      [scope.tenantId, encounterId, JSON.stringify(input.content)]
    );
    if (result.rowCount === 0) {
      return reply
        .code(409)
        .send(envelope({ error: "Draft clinical record not found or already approved" }, request.id));
    }
    const record = parseRecord(result.rows[0]!);
    dependencies.emitAudit({
      tenantId: scope.tenantId,
      actorId: readOperatorId(request),
      eventType: "lumen.record.updated",
      entityType: "lumen_clinical_record",
      entityId: record.id,
      metadata: { encounterId, remainingUncertainties: record.content.uncertainties.length }
    });
    return envelope(record, request.id);
  });

  app.post("/v1/tenants/:tenantId/lumen/encounters/:encounterId/approve", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!requireClinicalWrite(request, reply)) return;
    const operatorId = readOperatorId(request);
    if (!operatorId) return reply.code(400).send(envelope({ error: "x-operator-id must be a UUID" }, request.id));
    const encounterId = readUuid(request.params, "encounterId");
    if (!encounterId) return reply.code(400).send(envelope({ error: "encounterId must be a UUID" }, request.id));

    const current = await scope.db.query<{ content: unknown; status: string }>(
      `select content, status from lumen.clinical_records where tenant_id = $1 and encounter_id = $2`,
      [scope.tenantId, encounterId]
    );
    if (current.rowCount === 0)
      return reply.code(404).send(envelope({ error: "Clinical record not found" }, request.id));
    if (current.rows[0]!.status === "approved") {
      return reply.code(409).send(envelope({ error: "Clinical record is already approved" }, request.id));
    }
    const content = lumenClinicalRecordContentSchema.parse(current.rows[0]!.content);
    if (content.uncertainties.length > 0) {
      return reply.code(422).send(envelope({ error: "Resolve every uncertainty before approval" }, request.id));
    }
    if (!content.reasonForVisit.trim() && !content.history.trim()) {
      return reply.code(422).send(envelope({ error: "Reason for visit or history is required" }, request.id));
    }

    const record = await scope.db.transaction(async (client) => {
      const result = await client.query<RecordRow>(
        `update lumen.clinical_records
         set status = 'approved', approved_by = $3, approved_at = now(), updated_at = now()
         where tenant_id = $1 and encounter_id = $2 and status = 'draft'
           and jsonb_typeof(content->'uncertainties') = 'array'
           and jsonb_array_length(
             case
               when jsonb_typeof(content->'uncertainties') = 'array' then content->'uncertainties'
               else '[null]'::jsonb
             end
           ) = 0
           and (
             btrim(coalesce(content->>'reasonForVisit', '')) <> ''
             or btrim(coalesce(content->>'history', '')) <> ''
           )
         returning id, tenant_id as "tenantId", encounter_id as "encounterId",
                   dictation_id as "dictationId", status, schema_version as "schemaVersion",
                   content, provider, model, approved_by as "approvedBy",
                   approved_at as "approvedAt", created_at as "createdAt", updated_at as "updatedAt"`,
        [scope.tenantId, encounterId, operatorId]
      );
      if (result.rowCount === 0) return undefined;
      await client.query(
        `update lumen.encounters set status = 'approved', updated_at = now()
         where tenant_id = $1 and id = $2`,
        [scope.tenantId, encounterId]
      );
      return parseRecord(result.rows[0]!);
    });
    if (!record) return reply.code(409).send(envelope({ error: "Clinical record approval conflict" }, request.id));

    dependencies.emitAudit({
      tenantId: scope.tenantId,
      actorId: operatorId,
      eventType: "lumen.record.approved",
      entityType: "lumen_clinical_record",
      entityId: record.id,
      metadata: { encounterId, schemaVersion: record.schemaVersion }
    });
    return envelope(record, request.id);
  });
}

async function fetchWorklist(
  db: DatabaseClient,
  tenantId: string,
  encounterId?: string
): Promise<LumenWorklistEntry[]> {
  const result = await db.query<WorklistRow>(
    `select e.id as "encounterId", e.tenant_id as "tenantId", e.patient_id as "patientId",
            coalesce(p.full_name, 'Paciente sin nombre') as "patientDisplayName",
            case when (p.metadata->>'demoAge') ~ '^[0-9]+$' then (p.metadata->>'demoAge')::int else null end as "patientAge",
            professional.name as "professionalName", site.name as "siteName",
            e.scheduled_at as "scheduledAt", e.status, e.is_demo as "isDemo"
     from lumen.encounters e
     join pulso_iris.administrative_patients p
       on p.tenant_id = e.tenant_id and p.id = e.patient_id
     join pulso_iris.professionals professional
       on professional.tenant_id = e.tenant_id and professional.id = e.professional_id
     join pulso_iris.sites site
       on site.tenant_id = e.tenant_id and site.id = e.site_id
     where e.tenant_id = $1 and ($2::uuid is null or e.id = $2)
     order by e.scheduled_at asc
     limit 50`,
    [tenantId, encounterId ?? null]
  );
  return result.rows.map((row) => lumenWorklistEntrySchema.parse(row));
}

async function loadEncounterDetail(
  db: DatabaseClient,
  tenantId: string,
  encounterId: string
): Promise<LumenEncounterDetail | undefined> {
  const encounter = (await fetchWorklist(db, tenantId, encounterId))[0];
  if (!encounter) return undefined;

  const [summaryResult, dictationResult, recordResult] = await Promise.all([
    db.query<{ content: unknown; sourceCount: number }>(
      `select content, source_count as "sourceCount"
       from lumen.preconsultation_summaries where tenant_id = $1 and encounter_id = $2`,
      [tenantId, encounterId]
    ),
    db.query<DictationRow>(
      `select id, tenant_id as "tenantId", encounter_id as "encounterId", status,
              transcript, mime_type as "mimeType", provider, model,
              duration_seconds as "durationSeconds", created_at as "createdAt"
       from lumen.dictations
       where tenant_id = $1 and encounter_id = $2 and status = 'transcribed'
       order by created_at desc limit 10`,
      [tenantId, encounterId]
    ),
    db.query<RecordRow>(
      `select id, tenant_id as "tenantId", encounter_id as "encounterId",
              dictation_id as "dictationId", status, schema_version as "schemaVersion",
              content, provider, model, approved_by as "approvedBy",
              approved_at as "approvedAt", created_at as "createdAt", updated_at as "updatedAt"
       from lumen.clinical_records where tenant_id = $1 and encounter_id = $2`,
      [tenantId, encounterId]
    )
  ]);

  const summaryRow = summaryResult.rows[0];
  const preconsultation = summaryRow
    ? lumenPreconsultationSummarySchema.parse({
        ...(summaryRow.content as Record<string, unknown>),
        sourceCount: summaryRow.sourceCount
      })
    : null;
  const dictations = dictationResult.rows.map((row) => lumenDictationSchema.parse(row));
  const clinicalRecord = recordResult.rows[0] ? parseRecord(recordResult.rows[0]) : null;
  return lumenEncounterDetailSchema.parse({ encounter, preconsultation, dictations, clinicalRecord });
}

function parseRecord(row: RecordRow): LumenClinicalRecord {
  return lumenClinicalRecordSchema.parse(row);
}

async function encounterExists(db: DatabaseClient, tenantId: string, encounterId: string): Promise<boolean> {
  const result = await db.query(`select 1 from lumen.encounters where tenant_id = $1 and id = $2`, [
    tenantId,
    encounterId
  ]);
  return result.rowCount === 1;
}

function requireTenantDb(
  context: ServiceContext,
  request: FastifyRequest,
  reply: FastifyReply
): { tenantId: string; db: DatabaseClient } | undefined {
  const raw =
    typeof request.params === "object" && request.params && "tenantId" in request.params
      ? (request.params as { tenantId?: unknown }).tenantId
      : undefined;
  const parsed = tenantIdSchema.safeParse(raw);
  if (!parsed.success) {
    void reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    return undefined;
  }
  if (!context.db) {
    void reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    return undefined;
  }
  return { tenantId: parsed.data, db: context.db };
}

function readUuid(params: unknown, key: string): string | undefined {
  const value =
    typeof params === "object" && params && key in params ? (params as Record<string, unknown>)[key] : undefined;
  const parsed = tenantIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  request: FastifyRequest,
  reply: FastifyReply
): z.infer<T> | undefined {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    void reply.code(400).send(
      envelope(
        {
          error: "Invalid payload",
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        },
        request.id
      )
    );
    return undefined;
  }
  return parsed.data;
}

function requireClinicalWrite(request: FastifyRequest, reply: FastifyReply): boolean {
  const role = readHeader(request, "x-operator-role");
  if (role === "admin" || role === "coordinator" || role === "advisor") return true;
  void reply
    .code(403)
    .send(envelope({ error: role === "auditor" ? "Read-only role" : "Clinical operator role required" }, request.id));
  return false;
}

function readOperatorId(request: FastifyRequest): string | undefined {
  const raw = readHeader(request, "x-operator-id");
  const parsed = tenantIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendProviderError(reply: FastifyReply, request: FastifyRequest, error: unknown): unknown {
  if (error instanceof ProviderNotConfiguredError) {
    return reply.code(503).send(envelope({ error: error.message }, request.id));
  }
  if (error instanceof ProviderRequestError) {
    return reply.code(502).send(envelope({ error: error.message }, request.id));
  }
  return reply.code(500).send(envelope({ error: "Clinical processing failed" }, request.id));
}
