import {
  envelope,
  lumenClinicalRecordContentSchema,
  lumenClinicalRecordPatchSchema,
  lumenClinicalRequiredFieldBlockers,
  lumenClinicalRecordSchema,
  lumenDictationSchema,
  lumenEncounterDetailSchema,
  lumenPreconsultationSummarySchema,
  lumenStructureInputSchema,
  lumenTranscriptionInputSchema,
  lumenWorklistEntrySchema,
  tenantIdSchema,
  type LumenClinicalField,
  type LumenClinicalRecord,
  type LumenEncounterDetail,
  type LumenFieldEvidenceOrigin,
  type LumenWorklistEntry
} from "@hyperion/contracts";
import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { LumenAuditEmitter } from "./audit-client.js";
import {
  changedLumenClinicalFields,
  clinicalEvidenceIssues,
  LUMEN_CLINICAL_FIELDS,
  normalizeStructuredClinicalContent,
  ProviderNotConfiguredError,
  ProviderRequestError,
  type ClinicalStructurer
} from "./clinical-ai.js";
import {
  completeProcessingAttempt,
  failProcessingAttempt,
  processingResultSnapshotSha256,
  reserveProcessingAttempt,
  type ProcessingAttemptReservation
} from "./processing-attempts.js";
import { isSpeechToTextError } from "./provider-errors.js";
import { createRequestAbortSignal } from "./request-abort.js";
import { decodeBase64SpeechToTextInput, type SpeechToTextProvider, type SpeechToTextResult } from "./speech-to-text.js";

export interface LumenRouteDependencies {
  transcriber: SpeechToTextProvider;
  structurer: ClinicalStructurer;
  emitAudit: LumenAuditEmitter;
}

interface WorklistRow {
  encounterId: string;
  tenantId: string;
  patientId: string;
  siteId: string;
  patientDisplayName: string;
  patientAge: number | null;
  professionalName: string;
  siteName: string;
  scheduledAt: Date | string;
  status: string;
  isDemo: boolean;
  payer: string | null;
  documentMasked: string | null;
  visitReason: string | null;
  subspecialty: string | null;
}

interface DictationRow {
  id: string;
  tenantId: string;
  encounterId: string;
  status: string;
  transcript: string;
  mimeType: string;
  source: string;
  provider: string | null;
  model: string | null;
  durationSeconds: number | null;
  providerTranscript: string | null;
  reviewedAt: Date | string | null;
  reviewedBy: string | null;
  processingAttemptId: string | null;
  createdAt: Date | string;
}

interface DictationSnapshot {
  transcript: string;
  providerTranscript: string | null;
  source: string;
  reviewedAt: Date | string | null;
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

  app.post(
    "/v1/tenants/:tenantId/lumen/encounters/:encounterId/transcriptions",
    { bodyLimit: 8 * 1024 * 1024 },
    async (request, reply) => {
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
        return reply
          .code(503)
          .send(envelope({ error: "Clinical transcription provider is not configured" }, request.id));
      }

      let prepared;
      try {
        prepared = decodeBase64SpeechToTextInput({
          audioBase64: input.audioBase64,
          mimeType: input.mimeType,
          durationSeconds: input.durationSeconds
        });
      } catch (error) {
        return sendSpeechToTextError(reply, request, error);
      }

      const reservation = await scope.db.transaction(async (client) => {
        const mutable = await lockMutableEncounter(client, scope.tenantId, encounterId);
        if (mutable === "not_found") return { state: "not_found" } as const;
        if (mutable === "approved") return { state: "approved" } as const;
        return reserveProcessingAttempt(client, {
          tenantId: scope.tenantId,
          encounterId,
          operation: "transcription",
          idempotencyKey: input.idempotencyKey,
          inputSha256: prepared.audioSha256,
          provider: dependencies.transcriber.name,
          model: dependencies.transcriber.model,
          mimeType: prepared.mimeType,
          source: input.source,
          durationSeconds: input.durationSeconds
        });
      });
      if (reservation.state === "not_found") {
        return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
      }
      if (reservation.state === "approved") {
        return reply.code(409).send(envelope({ error: "Approved encounters are immutable" }, request.id));
      }
      if (reservation.state === "replay") {
        const dictation = await loadDictation(scope.db, scope.tenantId, encounterId, reservation.resultEntityId);
        if (!dictation)
          return reply.code(409).send(envelope({ error: "Idempotent result is unavailable" }, request.id));
        return reply.header("x-idempotent-replay", "true").code(200).send(envelope(dictation, request.id));
      }
      if (reservation.state !== "reserved") return sendReservationConflict(reply, request, reservation);

      const requestAbort = createRequestAbortSignal(request, reply);
      let transcription: SpeechToTextResult | undefined;
      try {
        transcription = await dependencies.transcriber.transcribe({ ...prepared, signal: requestAbort.signal });
        throwIfRequestAborted(requestAbort.signal);
        const completedTranscription = transcription;
        const outcome = await scope.db.transaction(async (client) => {
          const mutable = await lockMutableEncounter(client, scope.tenantId, encounterId);
          if (mutable !== "mutable") return { state: mutable } as const;
          throwIfRequestAborted(requestAbort.signal);

          const result = await client.query<DictationRow>(
            `insert into lumen.dictations
             (tenant_id, encounter_id, status, transcript, mime_type, provider, model, duration_seconds,
              metadata, provider_transcript, processing_attempt_id)
           values ($1, $2, 'transcribed', $3, $4, $5, $6, $7,
                   jsonb_build_object('audioStored', false, 'source', $8::text,
                                      'temporaryAudioDeleted', true), $3, $9)
           returning id, tenant_id as "tenantId", encounter_id as "encounterId", status,
                     transcript, mime_type as "mimeType", metadata->>'source' as source, provider, model,
                     duration_seconds as "durationSeconds", provider_transcript as "providerTranscript",
                     reviewed_at as "reviewedAt", reviewed_by as "reviewedBy",
                     processing_attempt_id as "processingAttemptId", created_at as "createdAt"`,
            [
              scope.tenantId,
              encounterId,
              completedTranscription.transcript,
              prepared.mimeType,
              completedTranscription.provider,
              completedTranscription.model,
              Math.max(1, Math.min(90, Math.round(completedTranscription.durationSeconds))),
              input.source,
              reservation.attemptId
            ]
          );
          await client.query(
            `update lumen.encounters set status = 'in_progress', updated_at = now()
           where tenant_id = $1 and id = $2 and status <> 'approved'`,
            [scope.tenantId, encounterId]
          );
          const dictation = lumenDictationSchema.parse(result.rows[0]);
          await completeProcessingAttempt(client, {
            attemptId: reservation.attemptId,
            tenantId: scope.tenantId,
            encounterId,
            operation: "transcription",
            resultEntityId: dictation.id,
            provider: completedTranscription.provider,
            model: completedTranscription.model,
            requestIdHash: completedTranscription.requestIdHash,
            traceIdHash: completedTranscription.traceIdHash,
            temporaryAudioDeleted: completedTranscription.temporaryAudioDeleted
          });
          await insertDurableAudit(client, {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: "lumen.dictation.transcribed",
            entityType: "lumen_dictation",
            entityId: dictation.id,
            metadata: {
              encounterId,
              provider: completedTranscription.provider,
              model: completedTranscription.model,
              source: input.source,
              audioStored: false,
              temporaryAudioDeleted: true,
              processingAttemptId: reservation.attemptId
            }
          });
          throwIfRequestAborted(requestAbort.signal);
          return { state: "created", dictation } as const;
        });

        if (outcome.state === "not_found") {
          await failProcessingAttempt(scope.db, {
            attemptId: reservation.attemptId,
            errorCode: "encounter_not_found",
            cancelled: false,
            temporaryAudioDeleted: transcription.temporaryAudioDeleted
          });
          return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
        }
        if (outcome.state === "approved") {
          await failProcessingAttempt(scope.db, {
            attemptId: reservation.attemptId,
            errorCode: "encounter_approved",
            cancelled: false,
            temporaryAudioDeleted: transcription.temporaryAudioDeleted
          });
          return reply.code(409).send(envelope({ error: "Approved encounters are immutable" }, request.id));
        }
        return reply.code(201).send(envelope(outcome.dictation, request.id));
      } catch (error) {
        const cancelled = requestAbort.signal.aborted || (isSpeechToTextError(error) && error.code === "cancelled");
        await scope.db.transaction(async (client) => {
          await failProcessingAttempt(client, {
            attemptId: reservation.attemptId,
            errorCode: isSpeechToTextError(error) ? error.code : "transcription_failed",
            cancelled,
            temporaryAudioDeleted:
              transcription?.temporaryAudioDeleted === true ||
              (isSpeechToTextError(error) && error.temporaryAudioDeleted === true)
          });
          await insertDurableAudit(client, {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: cancelled ? "lumen.transcription.cancelled" : "lumen.transcription.failed",
            entityType: "lumen_processing_attempt",
            entityId: reservation.attemptId,
            metadata: {
              encounterId,
              provider: dependencies.transcriber.name,
              model: dependencies.transcriber.model,
              source: input.source,
              audioStored: false
            }
          });
        });
        if (cancelled && reply.raw.destroyed) return;
        return sendSpeechToTextError(reply, request, error);
      } finally {
        requestAbort.cleanup();
      }
    }
  );

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

    const requestedDictationId = input.dictationId;
    let dictationSnapshot: DictationSnapshot | undefined;
    let evidenceOrigin: LumenFieldEvidenceOrigin = "manual";
    if (requestedDictationId) {
      const dictation = await loadDictationSnapshot(scope.db, scope.tenantId, encounterId, requestedDictationId);
      if (!dictation) {
        return reply.code(422).send(envelope({ error: "dictationId does not belong to this encounter" }, request.id));
      }
      dictationSnapshot = dictation;
      evidenceOrigin = evidenceOriginForDictation(dictation);
    }

    const inputSha256 = structureInputSha256(requestedDictationId, input.transcript);
    const reservation = await scope.db.transaction(async (client) => {
      const mutable = await lockMutableEncounter(client, scope.tenantId, encounterId);
      if (mutable === "not_found") return { state: "not_found" } as const;
      if (mutable === "approved") return { state: "approved" } as const;
      return reserveProcessingAttempt(client, {
        tenantId: scope.tenantId,
        encounterId,
        operation: "structuring",
        idempotencyKey: input.idempotencyKey,
        inputSha256,
        provider: dependencies.structurer.name,
        model: dependencies.structurer.model
      });
    });
    if (reservation.state === "not_found") {
      return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
    }
    if (reservation.state === "approved") {
      return reply.code(409).send(envelope({ error: "Approved encounters are immutable" }, request.id));
    }
    if (reservation.state === "replay") {
      const record = parseStructuringReplaySnapshot(reservation, scope.tenantId, encounterId);
      if (!record) {
        return reply.code(409).send(envelope({ error: "Idempotent result is unavailable or invalid" }, request.id));
      }
      return reply.header("x-idempotent-replay", "true").code(200).send(envelope(record, request.id));
    }
    if (reservation.state !== "reserved") return sendReservationConflict(reply, request, reservation);

    const recordSnapshot = await scope.db.query<{ updatedAt: string }>(
      `select updated_at::text as "updatedAt" from lumen.clinical_records
       where tenant_id = $1 and encounter_id = $2`,
      [scope.tenantId, encounterId]
    );
    const expectedRecordVersion = recordSnapshot.rows[0]?.updatedAt ?? null;
    const requestAbort = createRequestAbortSignal(request, reply);
    try {
      const structured = await dependencies.structurer.structure(input.transcript, evidenceOrigin, requestAbort.signal);
      const structuredContent = normalizeStructuredClinicalContent(
        structured.content,
        input.transcript,
        evidenceOrigin
      );
      throwIfRequestAborted(requestAbort.signal);

      const outcome = await scope.db.transaction(async (client) => {
        const mutable = await lockMutableEncounter(client, scope.tenantId, encounterId);
        if (mutable !== "mutable") return { state: mutable } as const;
        throwIfRequestAborted(requestAbort.signal);

        const currentRecord = await client.query<{ updatedAt: string }>(
          `select updated_at::text as "updatedAt" from lumen.clinical_records
           where tenant_id = $1 and encounter_id = $2
           for update`,
          [scope.tenantId, encounterId]
        );
        if ((currentRecord.rows[0]?.updatedAt ?? null) !== expectedRecordVersion) {
          return { state: "record_changed" } as const;
        }
        throwIfRequestAborted(requestAbort.signal);

        let dictationId = requestedDictationId;
        if (requestedDictationId) {
          const dictation = await client.query<DictationSnapshot>(
            `select transcript, provider_transcript as "providerTranscript",
                    reviewed_at as "reviewedAt",
                    coalesce(metadata->>'source',
                      case when provider = 'manual' then 'manual_entry' else 'browser_microphone' end) as source
             from lumen.dictations
             where tenant_id = $1 and encounter_id = $2 and id = $3 and status = 'transcribed'
             for update`,
            [scope.tenantId, encounterId, requestedDictationId]
          );
          if (dictation.rowCount === 0) return { state: "dictation_not_found" } as const;
          if (!dictationSnapshot || !sameDictationSnapshot(dictation.rows[0]!, dictationSnapshot)) {
            return { state: "dictation_changed" } as const;
          }
          const previousTranscriptHash = sha256Text(dictation.rows[0]!.transcript);
          await client.query(
            `update lumen.dictations
             set transcript = $4, reviewed_at = now(), reviewed_by = $5
             where tenant_id = $1 and encounter_id = $2 and id = $3`,
            [scope.tenantId, encounterId, requestedDictationId, input.transcript, operatorId]
          );
          await insertDurableAudit(client, {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: "lumen.dictation.reviewed",
            entityType: "lumen_dictation",
            entityId: requestedDictationId,
            metadata: {
              encounterId,
              transcriptChanged: dictation.rows[0]!.transcript !== input.transcript,
              previousTranscriptHash,
              reviewedTranscriptHash: sha256Text(input.transcript),
              contentStoredInAudit: false
            }
          });
        } else {
          const dictation = await client.query<{ id: string }>(
            `insert into lumen.dictations
               (tenant_id, encounter_id, status, transcript, mime_type, provider, metadata,
                reviewed_at, reviewed_by)
             values ($1, $2, 'transcribed', $3, 'text/plain', 'manual',
                     '{"audioStored":false,"source":"manual_entry"}'::jsonb, now(), $4)
             returning id`,
            [scope.tenantId, encounterId, input.transcript, operatorId]
          );
          dictationId = dictation.rows[0]!.id;
          await insertDurableAudit(client, {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: "lumen.dictation.reviewed",
            entityType: "lumen_dictation",
            entityId: dictationId,
            metadata: {
              encounterId,
              transcriptChanged: false,
              reviewedTranscriptHash: sha256Text(input.transcript),
              contentStoredInAudit: false,
              source: "manual_entry"
            }
          });
        }

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
            JSON.stringify(structuredContent),
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
        throwIfRequestAborted(requestAbort.signal);
        await completeProcessingAttempt(client, {
          attemptId: reservation.attemptId,
          tenantId: scope.tenantId,
          encounterId,
          operation: "structuring",
          resultEntityId: record.id,
          provider: structured.provider,
          model: structured.model,
          requestIdHash: structured.requestIdHash,
          traceIdHash: structured.traceIdHash,
          resultSnapshot: record,
          resultSha256: processingResultSnapshotSha256(record),
          resultVersion: record.updatedAt
        });
        await insertDurableAudit(client, {
          tenantId: scope.tenantId,
          actorId: operatorId,
          eventType: "lumen.record.structured",
          entityType: "lumen_clinical_record",
          entityId: record.id,
          metadata: {
            encounterId,
            dictationId,
            provider: structured.provider,
            model: structured.model,
            evidenceOrigin,
            humanApprovalRequired: true,
            processingAttemptId: reservation.attemptId
          }
        });
        throwIfRequestAborted(requestAbort.signal);
        return { state: "created", record } as const;
      });

      if (outcome.state === "not_found") {
        await failProcessingAttempt(scope.db, {
          attemptId: reservation.attemptId,
          errorCode: "encounter_not_found",
          cancelled: false
        });
        return reply.code(404).send(envelope({ error: "Encounter not found" }, request.id));
      }
      if (outcome.state === "approved") {
        await failProcessingAttempt(scope.db, {
          attemptId: reservation.attemptId,
          errorCode: "record_approved",
          cancelled: false
        });
        return reply.code(409).send(envelope({ error: "Approved clinical records cannot be replaced" }, request.id));
      }
      if (outcome.state === "dictation_not_found") {
        await failProcessingAttempt(scope.db, {
          attemptId: reservation.attemptId,
          errorCode: "dictation_not_found",
          cancelled: false
        });
        return reply.code(422).send(envelope({ error: "dictationId does not belong to this encounter" }, request.id));
      }
      if (outcome.state === "record_changed" || outcome.state === "dictation_changed") {
        await failProcessingAttempt(scope.db, {
          attemptId: reservation.attemptId,
          errorCode: "clinical_input_changed",
          cancelled: false
        });
        return reply
          .code(409)
          .send(
            envelope({ error: "Clinical input changed while structuring; retry with the latest draft" }, request.id)
          );
      }
      return reply.code(201).send(envelope(outcome.record, request.id));
    } catch (error) {
      const cancelled = requestAbort.signal.aborted;
      await scope.db.transaction(async (client) => {
        await failProcessingAttempt(client, {
          attemptId: reservation.attemptId,
          errorCode: cancelled ? "cancelled" : providerErrorCode(error),
          cancelled
        });
        await insertDurableAudit(client, {
          tenantId: scope.tenantId,
          actorId: operatorId,
          eventType: cancelled ? "lumen.structuring.cancelled" : "lumen.structuring.failed",
          entityType: "lumen_processing_attempt",
          entityId: reservation.attemptId,
          metadata: {
            encounterId,
            provider: dependencies.structurer.name,
            model: dependencies.structurer.model,
            humanApprovalRequired: true
          }
        });
      });
      if (cancelled && reply.raw.destroyed) return;
      return sendProviderError(reply, request, error);
    } finally {
      requestAbort.cleanup();
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
      const requestedRemainingFields = new Set(input.content.uncertainties.map((uncertainty) => uncertainty.field));
      const resolvedFields = [
        ...new Set(
          previousContent.uncertainties
            .filter((uncertainty) => !requestedRemainingFields.has(uncertainty.field))
            .map((uncertainty) => uncertainty.field)
        )
      ];
      const manualEvidenceFields = new Set<LumenClinicalField>(
        changedLumenClinicalFields(previousContent, input.content)
      );
      for (const resolvedField of resolvedFields) {
        for (const clinicalField of LUMEN_CLINICAL_FIELDS) {
          if (clinicalField === resolvedField || clinicalField.startsWith(`${resolvedField}.`)) {
            manualEvidenceFields.add(clinicalField);
          }
        }
      }
      const nextContent = lumenClinicalRecordContentSchema.parse({
        ...input.content,
        fieldEvidence: [
          ...previousContent.fieldEvidence.filter((evidence) => !manualEvidenceFields.has(evidence.field)),
          ...[...manualEvidenceFields].map((field) => ({
            field,
            confidence: 1,
            origin: "manual" as const,
            sourceText: null
          }))
        ]
      });
      const result = await client.query<RecordRow>(
        `update lumen.clinical_records
         set content = $3::jsonb, updated_at = now()
         where tenant_id = $1 and encounter_id = $2 and status = 'draft'
         returning id, tenant_id as "tenantId", encounter_id as "encounterId",
                   dictation_id as "dictationId", status, schema_version as "schemaVersion",
                   content, provider, model, approved_by as "approvedBy",
                   approved_at as "approvedAt", created_at as "createdAt", updated_at as "updatedAt"`,
        [scope.tenantId, encounterId, JSON.stringify(nextContent)]
      );
      if (result.rowCount === 0) return undefined;
      const updated = parseRecord(result.rows[0]!);
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
            manualEvidenceFields: [...manualEvidenceFields],
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
      const current = await client.query<{
        content: unknown;
        status: string;
        transcript: string;
        providerTranscript: string | null;
        reviewedAt: Date | string | null;
        source: string;
      }>(
        `select record.content, record.status, dictation.transcript,
                dictation.provider_transcript as "providerTranscript",
                dictation.reviewed_at as "reviewedAt",
                coalesce(dictation.metadata->>'source',
                  case when dictation.provider = 'manual' then 'manual_entry' else 'browser_microphone' end) as source
         from lumen.clinical_records record
         join lumen.dictations dictation
           on dictation.tenant_id = record.tenant_id
          and dictation.encounter_id = record.encounter_id
          and dictation.id = record.dictation_id
         where record.tenant_id = $1 and record.encounter_id = $2
         for update of record`,
        [scope.tenantId, encounterId]
      );
      if (current.rowCount === 0) return { state: "record_not_found" } as const;
      if (current.rows[0]!.status === "approved") return { state: "approved" } as const;
      const content = lumenClinicalRecordContentSchema.parse(current.rows[0]!.content);
      if (content.uncertainties.length > 0) return { state: "unresolved" } as const;
      const requiredFieldBlockers = lumenClinicalRequiredFieldBlockers(content);
      if (requiredFieldBlockers.length > 0) {
        return { state: "incomplete", blockers: requiredFieldBlockers } as const;
      }
      const evidenceIssues = clinicalEvidenceIssues(
        content,
        current.rows[0]!.transcript,
        evidenceOriginForStoredDictation(current.rows[0]!)
      );
      if (evidenceIssues.length > 0) return { state: "invalid_evidence", issues: evidenceIssues } as const;

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
      return reply
        .code(422)
        .send(
          envelope(
            { error: "Complete every required clinical field before approval", blockers: outcome.blockers },
            request.id
          )
        );
    }
    if (outcome.state === "invalid_evidence") {
      return reply.code(422).send(
        envelope(
          {
            error: "Every populated clinical field requires transcript evidence or explicit human confirmation",
            issues: outcome.issues
          },
          request.id
        )
      );
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
             e.site_id as "siteId",
             coalesce(p.full_name, 'Paciente sin nombre') as "patientDisplayName",
             case when (p.metadata->>'demoAge') ~ '^[0-9]+$' then (p.metadata->>'demoAge')::int else null end as "patientAge",
             professional.name as "professionalName",
             coalesce(nullif(e.metadata->>'siteDisplayName', ''),
                      nullif(site.metadata->>'lumenDisplayName', ''), site.name) as "siteName",
             e.scheduled_at as "scheduledAt", e.status, e.is_demo as "isDemo",
             nullif(p.metadata->>'payer', '') as payer,
             coalesce(nullif(p.document_number_masked, ''), nullif(p.metadata->>'documentMasked', ''))
               as "documentMasked",
             nullif(e.metadata->>'visitReason', '') as "visitReason",
             coalesce(nullif(professional.metadata->>'subspecialty', ''), nullif(professional.subspecialty, ''))
               as subspecialty
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
              transcript, mime_type as "mimeType",
              coalesce(metadata->>'source',
                case when provider = 'manual' then 'manual_entry' else 'browser_microphone' end) as source,
              provider, model,
              duration_seconds as "durationSeconds", provider_transcript as "providerTranscript",
              reviewed_at as "reviewedAt", reviewed_by as "reviewedBy",
              processing_attempt_id as "processingAttemptId", created_at as "createdAt"
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

function parseStructuringReplaySnapshot(
  reservation: Extract<ProcessingAttemptReservation, { state: "replay" }>,
  tenantId: string,
  encounterId: string
): LumenClinicalRecord | undefined {
  if (!reservation.resultSnapshot || !reservation.resultSha256 || !reservation.resultVersion) return undefined;
  try {
    if (processingResultSnapshotSha256(reservation.resultSnapshot) !== reservation.resultSha256) return undefined;
    const parsed = lumenClinicalRecordSchema.safeParse(reservation.resultSnapshot);
    if (!parsed.success) return undefined;
    if (
      parsed.data.id !== reservation.resultEntityId ||
      parsed.data.tenantId !== tenantId ||
      parsed.data.encounterId !== encounterId ||
      parsed.data.status !== "draft" ||
      timestampValue(parsed.data.updatedAt) !== timestampValue(reservation.resultVersion)
    ) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

async function loadDictation(
  db: DatabaseExecutor,
  tenantId: string,
  encounterId: string,
  dictationId: string
): Promise<ReturnType<typeof lumenDictationSchema.parse> | undefined> {
  const result = await db.query<DictationRow>(
    `select id, tenant_id as "tenantId", encounter_id as "encounterId", status,
            transcript, mime_type as "mimeType",
            coalesce(metadata->>'source',
              case when provider = 'manual' then 'manual_entry' else 'browser_microphone' end) as source,
            provider, model, duration_seconds as "durationSeconds",
            provider_transcript as "providerTranscript", reviewed_at as "reviewedAt",
            reviewed_by as "reviewedBy", processing_attempt_id as "processingAttemptId",
            created_at as "createdAt"
     from lumen.dictations
     where tenant_id = $1 and encounter_id = $2 and id = $3 and status = 'transcribed'`,
    [tenantId, encounterId, dictationId]
  );
  return result.rows[0] ? lumenDictationSchema.parse(result.rows[0]) : undefined;
}

async function loadDictationSnapshot(
  db: DatabaseExecutor,
  tenantId: string,
  encounterId: string,
  dictationId: string
): Promise<DictationSnapshot | undefined> {
  const result = await db.query<DictationSnapshot>(
    `select transcript, provider_transcript as "providerTranscript", reviewed_at as "reviewedAt",
            coalesce(metadata->>'source',
              case when provider = 'manual' then 'manual_entry' else 'browser_microphone' end) as source
     from lumen.dictations
     where tenant_id = $1 and encounter_id = $2 and id = $3 and status = 'transcribed'`,
    [tenantId, encounterId, dictationId]
  );
  return result.rows[0];
}

function sameDictationSnapshot(current: DictationSnapshot, expected: DictationSnapshot): boolean {
  return (
    current.transcript === expected.transcript &&
    current.providerTranscript === expected.providerTranscript &&
    current.source === expected.source &&
    timestampValue(current.reviewedAt) === timestampValue(expected.reviewedAt)
  );
}

function evidenceOriginForDictation(dictation: DictationSnapshot): LumenFieldEvidenceOrigin {
  const original = evidenceOriginForSource(dictation.source);
  if (original === "voice" && dictation.providerTranscript !== null) {
    return "voice_reviewed";
  }
  return original;
}

function evidenceOriginForStoredDictation(dictation: DictationSnapshot): LumenFieldEvidenceOrigin {
  const original = evidenceOriginForSource(dictation.source);
  return original === "voice" && dictation.providerTranscript !== null && dictation.reviewedAt !== null
    ? "voice_reviewed"
    : original;
}

function evidenceOriginForSource(source: string): LumenFieldEvidenceOrigin {
  if (source === "synthetic_demo") return "synthetic_demo";
  if (source === "manual_entry") return "manual";
  return "voice";
}

function structureInputSha256(dictationId: string | undefined, transcript: string): string {
  return createHash("sha256")
    .update(dictationId ?? "manual")
    .update("\0")
    .update(transcript, "utf8")
    .digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timestampValue(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function throwIfRequestAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("Client request aborted", "AbortError");
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

function sendReservationConflict(
  reply: FastifyReply,
  request: FastifyRequest,
  reservation: Exclude<ProcessingAttemptReservation, { state: "reserved" | "replay" }>
): unknown {
  if (reservation.state === "input_mismatch") {
    return reply
      .code(409)
      .send(envelope({ error: "Idempotency key was already used with different clinical input" }, request.id));
  }
  if (reservation.state === "processing") {
    return reply
      .header("retry-after", "2")
      .code(409)
      .send(envelope({ error: "Clinical processing is already in progress" }, request.id));
  }
  return reply
    .code(409)
    .send(
      envelope({ error: "Previous clinical processing did not complete; retry with a new idempotency key" }, request.id)
    );
}

function sendSpeechToTextError(reply: FastifyReply, request: FastifyRequest, error: unknown): unknown {
  if (!isSpeechToTextError(error)) {
    return reply.code(500).send(envelope({ error: "Clinical transcription failed" }, request.id));
  }
  const status =
    error.code === "not_configured"
      ? 503
      : error.code === "unsupported_media_type"
        ? 415
        : error.code === "audio_too_large"
          ? 413
          : error.code === "rate_limited"
            ? 429
            : error.code === "timeout"
              ? 504
              : error.code === "invalid_audio" || error.code === "audio_too_long"
                ? 400
                : error.code === "cancelled"
                  ? 408
                  : 502;
  return reply.code(status).send(
    envelope(
      {
        error: error.message,
        code: error.code,
        retryable: error.retryable
      },
      request.id
    )
  );
}

function providerErrorCode(error: unknown): string {
  if (error instanceof ProviderNotConfiguredError) return "provider_not_configured";
  if (error instanceof ProviderRequestError) return "provider_request_failed";
  return error instanceof Error ? error.name : "structuring_failed";
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
