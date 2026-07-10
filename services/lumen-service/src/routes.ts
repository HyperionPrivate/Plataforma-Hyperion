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
import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
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
    if (!(await requireMutableEncounter(scope.db, scope.tenantId, encounterId, request, reply))) return;
    const operatorId = readOperatorId(request);
    if (!operatorId) return reply.code(400).send(envelope({ error: "x-operator-id must be a UUID" }, request.id));

    await scope.db.transaction(async (client) => {
      const result = await client.query(
        `update lumen.encounters
         set status = 'in_progress', updated_at = now()
         where tenant_id = $1 and id = $2 and status = 'preconsultation'
         returning id`,
        [scope.tenantId, encounterId]
      );
      if (result.rowCount === 1) {
        await insertDurableAudit(client, {
          tenantId: scope.tenantId,
          actorId: operatorId,
          eventType: "lumen.encounter.started",
          entityType: "lumen_encounter",
          entityId: encounterId
        });
      }
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
    if (!(await requireMutableEncounter(scope.db, scope.tenantId, encounterId, request, reply))) return;
    const operatorId = readOperatorId(request);
    if (!operatorId) return reply.code(400).send(envelope({ error: "x-operator-id must be a UUID" }, request.id));
    if (!dependencies.transcriber.isConfigured()) {
      return reply.code(503).send(envelope({ error: "Clinical transcription provider is not configured" }, request.id));
    }

    try {
      const outcome = await scope.db.transaction(async (client) => {
        const mutable = await lockMutableEncounter(client, scope.tenantId, encounterId);
        if (mutable !== "mutable") return { state: mutable } as const;

        const transcription = await dependencies.transcriber.transcribe(input.audioBase64, input.mimeType);
        const result = await client.query<DictationRow>(
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
        await client.query(
          `update lumen.encounters set status = 'in_progress', updated_at = now()
           where tenant_id = $1 and id = $2 and status <> 'approved'`,
          [scope.tenantId, encounterId]
        );
        const dictation = lumenDictationSchema.parse(result.rows[0]);
        await insertDurableAudit(client, {
          tenantId: scope.tenantId,
          actorId: operatorId,
          eventType: "lumen.dictation.transcribed",
          entityType: "lumen_dictation",
          entityId: dictation.id,
          metadata: {
            encounterId,
            provider: transcription.provider,
            model: transcription.model,
            audioStored: false
          }
        });
        return { state: "created", dictation } as const;
      });

      if (outcome.state === "not_found") {
        return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
      }
      if (outcome.state === "approved") {
        return reply.code(409).send(envelope({ error: "Approved encounters are immutable" }, request.id));
      }
      return reply.code(201).send(envelope(outcome.dictation, request.id));
    } catch (error) {
      if (error instanceof ProviderNotConfiguredError || error instanceof ProviderRequestError) {
        await recordFailedDictation(scope.db, {
          tenantId: scope.tenantId,
          encounterId,
          operatorId,
          mimeType: input.mimeType,
          provider: dependencies.transcriber.name,
          model: dependencies.transcriber.model,
          durationSeconds: input.durationSeconds ?? null,
          errorCode: error.name.slice(0, 120)
        });
      }
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
    if (!(await requireMutableEncounter(scope.db, scope.tenantId, encounterId, request, reply))) return;
    const operatorId = readOperatorId(request);
    if (!operatorId) return reply.code(400).send(envelope({ error: "x-operator-id must be a UUID" }, request.id));
    if (!dependencies.structurer.isConfigured()) {
      return reply.code(503).send(envelope({ error: "Clinical structuring provider is not configured" }, request.id));
    }

    try {
      const outcome = await scope.db.transaction(async (client) => {
        const mutable = await lockMutableEncounter(client, scope.tenantId, encounterId);
        if (mutable !== "mutable") return { state: mutable } as const;

        let dictationId = input.dictationId;
        if (dictationId) {
          const dictation = await client.query<{ transcript: string }>(
            `select transcript from lumen.dictations
             where tenant_id = $1 and encounter_id = $2 and id = $3 and status = 'transcribed'`,
            [scope.tenantId, encounterId, dictationId]
          );
          if (dictation.rowCount === 0) return { state: "dictation_not_found" } as const;
          if (dictation.rows[0]!.transcript !== input.transcript) {
            return { state: "transcript_mismatch" } as const;
          }
        } else {
          const dictation = await client.query<{ id: string }>(
            `insert into lumen.dictations
               (tenant_id, encounter_id, status, transcript, mime_type, provider, metadata)
             values ($1, $2, 'transcribed', $3, 'text/plain', 'manual', '{"audioStored":false}'::jsonb)
             returning id`,
            [scope.tenantId, encounterId, input.transcript]
          );
          dictationId = dictation.rows[0]!.id;
        }

        const structured = await dependencies.structurer.structure(input.transcript);
        const result = await client.query<RecordRow>(
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
        if (result.rowCount === 0) return { state: "approved" } as const;
        await client.query(
          `update lumen.encounters set status = 'review', updated_at = now()
           where tenant_id = $1 and id = $2 and status <> 'approved'`,
          [scope.tenantId, encounterId]
        );
        const record = parseRecord(result.rows[0]!);
        await insertDurableAudit(client, {
          tenantId: scope.tenantId,
          actorId: operatorId,
          eventType: "lumen.record.structured",
          entityType: "lumen_clinical_record",
          entityId: record.id,
          metadata: { encounterId, dictationId, provider: structured.provider, model: structured.model }
        });
        return { state: "created", record } as const;
      });

      if (outcome.state === "not_found") {
        return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
      }
      if (outcome.state === "approved") {
        return reply.code(409).send(envelope({ error: "Approved clinical records cannot be replaced" }, request.id));
      }
      if (outcome.state === "dictation_not_found") {
        return reply.code(422).send(envelope({ error: "dictationId does not belong to this encounter" }, request.id));
      }
      if (outcome.state === "transcript_mismatch") {
        return reply.code(422).send(envelope({ error: "Transcript does not match dictationId" }, request.id));
      }
      return reply.code(201).send(envelope(outcome.record, request.id));
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
    if (!(await requireMutableEncounter(scope.db, scope.tenantId, encounterId, request, reply))) return;
    const operatorId = readOperatorId(request);
    if (!operatorId) return reply.code(400).send(envelope({ error: "x-operator-id must be a UUID" }, request.id));
    const input = parseBody(lumenClinicalRecordPatchSchema, request, reply);
    if (!input) return;

    const record = await scope.db.transaction(async (client) => {
      const current = await client.query<{ id: string; content: unknown }>(
        `select id, content from lumen.clinical_records
         where tenant_id = $1 and encounter_id = $2 and status = 'draft'
         for update`,
        [scope.tenantId, encounterId]
      );
      if (current.rowCount === 0) return undefined;
      const previousContent = lumenClinicalRecordContentSchema.parse(current.rows[0]!.content);
      const result = await client.query<RecordRow>(
        `update lumen.clinical_records
         set content = $3::jsonb, updated_at = now()
         where tenant_id = $1 and encounter_id = $2 and status = 'draft'
         returning id, tenant_id as "tenantId", encounter_id as "encounterId",
                   dictation_id as "dictationId", status, schema_version as "schemaVersion",
                   content, provider, model, approved_by as "approvedBy",
                   approved_at as "approvedAt", created_at as "createdAt", updated_at as "updatedAt"`,
        [scope.tenantId, encounterId, JSON.stringify(input.content)]
      );
      if (result.rowCount === 0) return undefined;
      const updated = parseRecord(result.rows[0]!);
      const remainingFields = new Set(updated.content.uncertainties.map((uncertainty) => uncertainty.field));
      const resolvedFields = [
        ...new Set(
          previousContent.uncertainties
            .filter((uncertainty) => !remainingFields.has(uncertainty.field))
            .map((uncertainty) => uncertainty.field)
        )
      ];
      const previousDocument = previousContent as unknown as Record<string, unknown>;
      const updatedDocument = updated.content as unknown as Record<string, unknown>;
      const reviewedSections = Object.keys(previousDocument).filter(
        (key) => JSON.stringify(previousDocument[key]) !== JSON.stringify(updatedDocument[key])
      );
      await client.query(
        `insert into platform.audit_events
           (tenant_id, actor_id, event_type, entity_type, entity_id, metadata)
         values ($1, $2, 'lumen.record.reviewed', 'lumen_clinical_record', $3, $4::jsonb)`,
        [
          scope.tenantId,
          operatorId,
          updated.id,
          JSON.stringify({
            encounterId,
            previousUncertainties: previousContent.uncertainties.length,
            remainingUncertainties: updated.content.uncertainties.length,
            resolvedUncertainties: Math.max(
              0,
              previousContent.uncertainties.length - updated.content.uncertainties.length
            ),
            resolvedFields,
            reviewedSections
          })
        ]
      );
      return updated;
    });
    if (!record) {
      return reply
        .code(409)
        .send(envelope({ error: "Draft clinical record not found or already approved" }, request.id));
    }
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

    const outcome = await scope.db.transaction(async (client) => {
      const mutable = await lockMutableEncounter(client, scope.tenantId, encounterId);
      if (mutable === "not_found") return { state: "not_found" } as const;
      if (mutable === "approved") return { state: "approved" } as const;
      const current = await client.query<{ content: unknown; status: string }>(
        `select content, status from lumen.clinical_records
         where tenant_id = $1 and encounter_id = $2
         for update`,
        [scope.tenantId, encounterId]
      );
      if (current.rowCount === 0) return { state: "record_not_found" } as const;
      if (current.rows[0]!.status === "approved") return { state: "approved" } as const;
      const content = lumenClinicalRecordContentSchema.parse(current.rows[0]!.content);
      if (content.uncertainties.length > 0) return { state: "unresolved" } as const;
      if (!content.reasonForVisit.trim() && !content.history.trim()) return { state: "incomplete" } as const;

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
      if (result.rowCount === 0) return { state: "conflict" } as const;
      return { state: "approved_record", record: parseRecord(result.rows[0]!) } as const;
    });
    if (outcome.state === "not_found" || outcome.state === "record_not_found") {
      return reply.code(404).send(envelope({ error: "Clinical record not found" }, request.id));
    }
    if (outcome.state === "approved") {
      return reply.code(409).send(envelope({ error: "Clinical record is already approved" }, request.id));
    }
    if (outcome.state === "unresolved") {
      return reply.code(422).send(envelope({ error: "Resolve every uncertainty before approval" }, request.id));
    }
    if (outcome.state === "incomplete") {
      return reply.code(422).send(envelope({ error: "Reason for visit or history is required" }, request.id));
    }
    if (outcome.state === "conflict") {
      return reply.code(409).send(envelope({ error: "Clinical record approval conflict" }, request.id));
    }
    return envelope(outcome.record, request.id);
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
     where e.tenant_id = $1
       and e.is_demo
       and coalesce(p.metadata->>'is_demo', 'false') = 'true'
       and coalesce(professional.metadata->>'is_demo', 'false') = 'true'
       and ($2::uuid is null or e.id = $2)
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

async function lockMutableEncounter(
  db: DatabaseExecutor,
  tenantId: string,
  encounterId: string
): Promise<"mutable" | "not_found" | "approved"> {
  const result = await db.query<{ status: string }>(
    `select status from lumen.encounters
     where tenant_id = $1 and id = $2 and is_demo
     for update`,
    [tenantId, encounterId]
  );
  if (result.rowCount === 0) return "not_found";
  return result.rows[0]!.status === "approved" ? "approved" : "mutable";
}

async function insertDurableAudit(
  db: DatabaseExecutor,
  event: {
    tenantId: string;
    actorId?: string;
    eventType: string;
    entityType: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await db.query(
    `insert into platform.audit_events
       (tenant_id, actor_id, event_type, entity_type, entity_id, metadata)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.tenantId,
      event.actorId ?? null,
      event.eventType,
      event.entityType,
      event.entityId ?? null,
      JSON.stringify({ source: "lumen-service", ...(event.metadata ?? {}) })
    ]
  );
}

async function recordFailedDictation(
  db: DatabaseClient,
  input: {
    tenantId: string;
    encounterId: string;
    operatorId: string;
    mimeType: string;
    provider: string;
    model: string;
    durationSeconds: number | null;
    errorCode: string;
  }
): Promise<void> {
  await db.transaction(async (client) => {
    if ((await lockMutableEncounter(client, input.tenantId, input.encounterId)) !== "mutable") return;
    const result = await client.query<{ id: string }>(
      `insert into lumen.dictations
         (tenant_id, encounter_id, status, mime_type, provider, model, duration_seconds, error_code, metadata)
       values ($1, $2, 'failed', $3, $4, $5, $6, $7,
               '{"audioStored":false,"source":"browser_microphone"}'::jsonb)
       returning id`,
      [
        input.tenantId,
        input.encounterId,
        input.mimeType,
        input.provider,
        input.model,
        input.durationSeconds,
        input.errorCode
      ]
    );
    await insertDurableAudit(client, {
      tenantId: input.tenantId,
      actorId: input.operatorId,
      eventType: "lumen.dictation.failed",
      entityType: "lumen_dictation",
      entityId: result.rows[0]!.id,
      metadata: { encounterId: input.encounterId, provider: input.provider, model: input.model, audioStored: false }
    });
  });
}

async function requireMutableEncounter(
  db: DatabaseClient,
  tenantId: string,
  encounterId: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const result = await db.query<{ status: string }>(
    `select status from lumen.encounters where tenant_id = $1 and id = $2 and is_demo`,
    [tenantId, encounterId]
  );
  if (result.rowCount === 0) {
    void reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
    return false;
  }
  if (result.rows[0]!.status === "approved") {
    void reply.code(409).send(envelope({ error: "Approved encounters are immutable" }, request.id));
    return false;
  }
  return true;
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
