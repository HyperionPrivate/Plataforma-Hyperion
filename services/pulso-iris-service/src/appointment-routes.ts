import {
  pulsoIrisAppointmentCancellationInputSchema,
  pulsoIrisAppointmentHoldInputSchema,
  pulsoIrisAppointmentHoldListSchema,
  pulsoIrisAppointmentHoldSchema,
  pulsoIrisAppointmentInputSchema,
  pulsoIrisAppointmentListSchema,
  pulsoIrisAppointmentPatchSchema,
  pulsoIrisAppointmentRescheduleInputSchema,
  pulsoIrisAppointmentStatusHistoryListSchema,
  pulsoIrisExternalRejectionInputSchema,
  pulsoIrisManualVerificationInputSchema,
  type PulsoIrisAppointment
} from "@hyperion/pulso-contracts";
import { envelope, tenantIdSchema } from "@hyperion/platform-contracts";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AgendaProviderError, type AgendaHold } from "./agenda-provider.js";
import { AuditHistoryUnavailableError, type AuditHistoryReader } from "./audit-history-client.js";
import type { AuditEmitter } from "./audit-client.js";
import { readOperatorId, readOperatorRole } from "./audit-client.js";
import { expireAppointmentHolds } from "./appointment-hold-expiration.js";
import { isProfessionalExcludedForPayer, listSlotAlternatives } from "./availability-engine.js";
import { InternalAgendaProvider } from "./internal-agenda-provider.js";
import {
  ensureTenantReferences,
  mapDatabaseError,
  parseBody,
  readTenantId,
  readUuidParam,
  requireTenantDb,
  sendReferenceError
} from "./shared.js";

type Database = NonNullable<ServiceContext["db"]>;

interface AgendaSettingsRow {
  mode: "internal" | "hybrid_manual" | "legacy_integrated";
  bookingHorizonDays: number;
  holdDurationMinutes: number;
  maxAlternatives: number;
  maxReschedules: number;
  externalConfirmationSlaMinutes: number;
  externalReferenceRequired: boolean;
  status: "active" | "paused";
}

const APPOINTMENT_COLUMNS = `
  id,
  tenant_id as "tenantId",
  patient_id as "patientId",
  conversation_id as "conversationId",
  site_id as "siteId",
  professional_id as "professionalId",
  payer_id as "payerId",
  appointment_type_id as "appointmentTypeId",
  appointment_type as "appointmentType",
  origin,
  status,
  scheduled_at as "scheduledAt",
  duration_min as "durationMin",
  idempotency_key as "idempotencyKey",
  hold_id as "holdId",
  slot_capacity_token as "slotCapacityToken",
  verification_mode as "verificationMode",
  external_system as "externalSystem",
  external_reference as "externalReference",
  external_note as "externalNote",
  verified_at as "verifiedAt",
  verified_by as "verifiedBy",
  external_sla_due_at as "externalSlaDueAt",
  reschedule_count as "rescheduleCount",
  previous_appointment_id as "previousAppointmentId",
  cancellation_reason as "cancellationReason",
  cancelled_at as "cancelledAt",
  cancelled_by as "cancelledBy",
  external_rejection_reason as "externalRejectionReason",
  external_rejected_at as "externalRejectedAt",
  external_rejected_by as "externalRejectedBy",
  status_updated_at as "statusUpdatedAt",
  legacy_reference as "legacyReference",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;
const QUALIFIED_APPOINTMENT_COLUMNS = APPOINTMENT_COLUMNS.replace(/(^|\n)(\s*)([a-z][a-z0-9_]*)(?=,| as)/g, "$1$2a.$3");

const HOLD_COLUMNS = `
  id,
  tenant_id as "tenantId",
  patient_id as "patientId",
  conversation_id as "conversationId",
  site_id as "siteId",
  professional_id as "professionalId",
  payer_id as "payerId",
  appointment_type_id as "appointmentTypeId",
  scheduled_at as "scheduledAt",
  duration_min as "durationMin",
  slot_capacity_token as "slotCapacityToken",
  status,
  expires_at as "expiresAt",
  idempotency_key as "idempotencyKey",
  appointment_id as "appointmentId",
  created_by as "createdBy",
  consumed_at as "consumedAt",
  cancelled_at as "cancelledAt",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export async function registerAppointmentRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  emitAudit: AuditEmitter = async () => undefined,
  readAuditHistory: AuditHistoryReader = async () => {
    throw new AuditHistoryUnavailableError("Audit history reader is not configured", 503);
  }
): Promise<void> {
  const base = "/v1/tenants/:tenantId/pulso-iris";

  app.get(`${base}/appointment-holds`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const operatorId = readOperatorId(request.headers as Record<string, unknown>);
    const role = readOperatorRole(request.headers as Record<string, unknown>);
    const result = await scope.db.query(
      `select ${HOLD_COLUMNS}
       from pulso_iris.appointment_holds
       where tenant_id = $1
         and ($2::boolean is false or created_by = $3)
       order by created_at desc
       limit 200`,
      [scope.tenantId, role === "advisor", operatorId ?? null]
    );
    return envelope(pulsoIrisAppointmentHoldListSchema.parse(result.rows), request.id);
  });

  app.post(`${base}/appointment-holds`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisAppointmentHoldInputSchema, request, reply);
    if (!input) return;

    const settings = await loadActiveSettings(scope.db, scope.tenantId, request, reply);
    if (!settings) return;
    const invalidRef = await ensureTenantReferences(scope.db, scope.tenantId, [
      { id: input.patientId, table: "pulso_iris.administrative_patients", label: "patientId" },
      { id: input.conversationId, table: "pulso_iris.conversations", label: "conversationId" },
      { id: input.siteId, table: "pulso_iris.sites", label: "siteId" },
      { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
      { id: input.payerId, table: "pulso_iris.payers", label: "payerId" },
      { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
    ]);
    if (invalidRef) return sendReferenceError(reply, request, invalidRef.label);
    if (!(await validateBookableRequest(scope.db, scope.tenantId, input, settings, request, reply))) return;

    try {
      const result = await scope.db.transaction(async (tx) => {
        const provider = new InternalAgendaProvider(asTransactionalDatabase(tx));
        const reserved = await provider.reserve({
          ...input,
          tenantId: scope.tenantId,
          actorId: readOperatorId(request.headers as Record<string, unknown>),
          holdDurationMinutes: settings.holdDurationMinutes
        });
        await emitExpiredHolds(emitAudit, reserved.expiredHolds, tx);
        if (!reserved.idempotent) await emitHoldCreated(emitAudit, reserved.hold, request, tx);
        return reserved;
      });
      return reply
        .code(result.idempotent ? 200 : 201)
        .send(envelope(pulsoIrisAppointmentHoldSchema.parse(result.hold), request.id));
    } catch (error) {
      return handleReservationError(error, scope.db, scope.tenantId, input, settings, request, reply);
    }
  });

  app.post(`${base}/appointment-holds/:holdId/cancel`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const holdId = readUuidParam(request.params, "holdId");
    if (!holdId) return reply.code(400).send(envelope({ error: "holdId must be a UUID" }, request.id));
    const input = parseBody(pulsoIrisAppointmentCancellationInputSchema, request, reply);
    if (!input) return;
    const headers = request.headers as Record<string, unknown>;
    const operatorId = readOperatorId(headers);
    const role = readOperatorRole(headers);
    if (!operatorId || !role || role === "auditor") {
      return reply.code(403).send(envelope({ error: "Operational role required" }, request.id));
    }

    const cancelled = await scope.db.query(
      `update pulso_iris.appointment_holds
       set status = 'cancelled', cancelled_at = now(), updated_at = now(),
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
             'cancelledBy', $4::text,
             'reason', $5::text
           )
       where tenant_id = $1 and id = $2 and status = 'active'
         and ($3::boolean is false or created_by = $4)
       returning ${HOLD_COLUMNS}`,
      [scope.tenantId, holdId, role === "advisor", operatorId, input.reason]
    );
    const hold = pulsoIrisAppointmentHoldListSchema.parse(cancelled.rows)[0];
    if (!hold) return reply.code(409).send(envelope({ error: "Appointment hold cannot be cancelled" }, request.id));
    return envelope(hold, request.id);
  });

  app.post(`${base}/appointments`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisAppointmentInputSchema, request, reply);
    if (!input) return;
    if (!input.idempotencyKey) {
      return reply.code(422).send(envelope({ error: "idempotencyKey is required" }, request.id));
    }
    const appointmentIdempotencyKey = input.idempotencyKey;

    const settings = await loadActiveSettings(scope.db, scope.tenantId, request, reply);
    if (!settings) return;
    const operatorId = readOperatorId(request.headers as Record<string, unknown>);
    const operatorRole = readOperatorRole(request.headers as Record<string, unknown>);
    let holdId = input.holdId;
    let holdWasCreated = false;

    if (holdId && operatorRole === "advisor") {
      const ownership = await scope.db.query<{ createdBy: string }>(
        `select created_by as "createdBy"
         from pulso_iris.appointment_holds
         where tenant_id = $1 and id = $2`,
        [scope.tenantId, holdId]
      );
      if (!operatorId || ownership.rows[0]?.createdBy !== operatorId) {
        return reply.code(404).send(envelope({ error: "Appointment hold not found" }, request.id));
      }
    }

    if (!holdId) {
      if (!input.siteId || !input.professionalId || !input.appointmentTypeId || !input.scheduledAt) {
        return reply
          .code(422)
          .send(
            envelope(
              { error: "siteId, professionalId, appointmentTypeId and scheduledAt are required without holdId" },
              request.id
            )
          );
      }
      const holdInput = {
        tenantId: scope.tenantId,
        patientId: input.patientId,
        conversationId: input.conversationId,
        siteId: input.siteId,
        professionalId: input.professionalId,
        payerId: input.payerId,
        appointmentTypeId: input.appointmentTypeId,
        scheduledAt: input.scheduledAt,
        idempotencyKey: `hold:${input.idempotencyKey}`,
        actorId: operatorId,
        holdDurationMinutes: settings.holdDurationMinutes
      };
      const invalidRef = await ensureTenantReferences(scope.db, scope.tenantId, [
        { id: input.patientId, table: "pulso_iris.administrative_patients", label: "patientId" },
        { id: input.conversationId, table: "pulso_iris.conversations", label: "conversationId" },
        { id: input.siteId, table: "pulso_iris.sites", label: "siteId" },
        { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
        { id: input.payerId, table: "pulso_iris.payers", label: "payerId" },
        { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
      ]);
      if (invalidRef) return sendReferenceError(reply, request, invalidRef.label);
      if (!(await validateBookableRequest(scope.db, scope.tenantId, holdInput, settings, request, reply))) return;
      try {
        const completed = await scope.db.transaction(async (tx) => {
          const transactionalDb = asTransactionalDatabase(tx);
          const provider = new InternalAgendaProvider(transactionalDb);
          const reserved = await provider.reserve(holdInput);
          await emitExpiredHolds(emitAudit, reserved.expiredHolds, tx);
          if (!reserved.idempotent) await emitHoldCreated(emitAudit, reserved.hold, request, tx);
          const resolvedHoldId = reserved.hold.id;
          const wasCreated = !reserved.idempotent;
          const result =
            settings.mode === "internal"
              ? await provider.verify({
                  tenantId: scope.tenantId,
                  holdId: resolvedHoldId,
                  appointmentIdempotencyKey,
                  origin: input.origin ?? "advisor",
                  actorId: operatorId
                })
              : await submitHybridAppointment(transactionalDb, {
                  tenantId: scope.tenantId,
                  holdId: resolvedHoldId,
                  idempotencyKey: appointmentIdempotencyKey,
                  origin: input.origin ?? "advisor",
                  actorId: operatorId,
                  externalSlaMinutes: settings.externalConfirmationSlaMinutes
                });
          const appointment = await findAppointment(transactionalDb, scope.tenantId, result.appointment.id);
          if (!appointment) throw new Error("Appointment was not persisted");

          if (!result.idempotent) {
            await emitAudit(
              {
                tenantId: scope.tenantId,
                actorId: operatorId,
                eventType:
                  settings.mode === "internal" ? "appointment.verified" : "appointment.pending_external_confirmation",
                entityType: "appointment",
                entityId: appointment.id,
                metadata: { mode: settings.mode }
              },
              tx
            );
            await emitAudit(
              {
                tenantId: scope.tenantId,
                actorId: operatorId,
                eventType: "appointment.registered",
                entityType: "appointment",
                entityId: appointment.id,
                metadata: { mode: settings.mode }
              },
              tx
            );
          }
          return { appointment, result, holdWasCreated: wasCreated };
        });

        return reply
          .code(completed.result.idempotent && !completed.holdWasCreated ? 200 : 201)
          .send(envelope(completed.appointment, request.id));
      } catch (error) {
        return handleReservationError(error, scope.db, scope.tenantId, holdInput, settings, request, reply);
      }
    }

    try {
      const completed = await scope.db.transaction(async (tx) => {
        const transactionalDb = asTransactionalDatabase(tx);
        const provider = new InternalAgendaProvider(transactionalDb);
        const result =
          settings.mode === "internal"
            ? await provider.verify({
                tenantId: scope.tenantId,
                holdId,
                appointmentIdempotencyKey,
                origin: input.origin ?? "advisor",
                actorId: operatorId
              })
            : await submitHybridAppointment(transactionalDb, {
                tenantId: scope.tenantId,
                holdId,
                idempotencyKey: appointmentIdempotencyKey,
                origin: input.origin ?? "advisor",
                actorId: operatorId,
                externalSlaMinutes: settings.externalConfirmationSlaMinutes
              });
        const appointment = await findAppointment(transactionalDb, scope.tenantId, result.appointment.id);
        if (!appointment) throw new Error("Appointment was not persisted");

        if (!result.idempotent) {
          await emitAudit(
            {
              tenantId: scope.tenantId,
              actorId: operatorId,
              eventType:
                settings.mode === "internal" ? "appointment.verified" : "appointment.pending_external_confirmation",
              entityType: "appointment",
              entityId: appointment.id,
              metadata: { mode: settings.mode }
            },
            tx
          );
          await emitAudit(
            {
              tenantId: scope.tenantId,
              actorId: operatorId,
              eventType: "appointment.registered",
              entityType: "appointment",
              entityId: appointment.id,
              metadata: { mode: settings.mode }
            },
            tx
          );
        }
        return { appointment, result };
      });

      return reply
        .code(completed.result.idempotent && !holdWasCreated ? 200 : 201)
        .send(envelope(completed.appointment, request.id));
    } catch (error) {
      if (error instanceof AgendaProviderError && error.code === "hold_expired") {
        await expireAppointmentHolds(scope.db, emitAudit);
      }
      return handleAppointmentError(error, request, reply);
    }
  });

  app.get(`${base}/appointments/queue`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const query = request.query as { siteId?: unknown };
    const parsedSiteId = query.siteId === undefined ? undefined : tenantIdSchema.safeParse(query.siteId);
    if (parsedSiteId && !parsedSiteId.success) {
      return reply.code(400).send(envelope({ error: "siteId must be a UUID" }, request.id));
    }
    const siteId = parsedSiteId?.data;
    const role = readOperatorRole(request.headers as Record<string, unknown>);
    const operatorId = readOperatorId(request.headers as Record<string, unknown>);
    const appointments = await scope.db.query(
      `select ${QUALIFIED_APPOINTMENT_COLUMNS},
              s.name as "siteName", p.name as "professionalName", t.name as "appointmentTypeName",
              p.is_pilot as "professionalIsPilot",
              patient.full_name as "patientName",
              extract(epoch from (a.external_sla_due_at - now()))::int as "slaRemainingSeconds"
       from pulso_iris.appointments a
       left join pulso_iris.sites s on s.tenant_id = a.tenant_id and s.id = a.site_id
       left join pulso_iris.professionals p on p.tenant_id = a.tenant_id and p.id = a.professional_id
       left join pulso_iris.appointment_types t on t.tenant_id = a.tenant_id and t.id = a.appointment_type_id
       left join pulso_iris.administrative_patients patient
         on patient.tenant_id = a.tenant_id and patient.id = a.patient_id
       where a.tenant_id = $1
         and ($2::boolean is false or a.metadata ->> 'created_by' = $3)
         and ($4::uuid is null or a.site_id = $4)
       order by
         case a.status when 'pending_external_confirmation' then 0 when 'deferred' then 1 else 2 end,
         a.external_sla_due_at nulls last,
         a.created_at desc
       limit 300`,
      [scope.tenantId, role === "advisor", operatorId ?? null, siteId ?? null]
    );
    const holds = await scope.db.query(
      `select ${HOLD_COLUMNS}
       from pulso_iris.appointment_holds
       where tenant_id = $1
         and status in ('active', 'expired')
         and ($2::boolean is false or created_by = $3)
         and ($4::uuid is null or site_id = $4)
       order by created_at desc
       limit 200`,
      [scope.tenantId, role === "advisor", operatorId ?? null, siteId ?? null]
    );
    const counts = await scope.db.query<{ professionals: number; rules: number; relations: number }>(
      `select
         (select count(*)::int from pulso_iris.professionals where tenant_id = $1 and status = 'active') professionals,
         (select count(*)::int from pulso_iris.availability_rules where tenant_id = $1 and status = 'active') rules,
         (select count(*)::int from pulso_iris.professional_sites where tenant_id = $1 and status = 'active') relations`,
      [scope.tenantId]
    );
    const configurationErrors: string[] = [];
    if (!counts.rows[0]?.professionals) configurationErrors.push("No active professionals configured");
    if (!counts.rows[0]?.relations) configurationErrors.push("No professional-site relationships configured");
    if (!counts.rows[0]?.rules) configurationErrors.push("No active availability rules configured");

    return envelope(
      {
        appointments: appointments.rows,
        holds: pulsoIrisAppointmentHoldListSchema.parse(holds.rows),
        configurationErrors
      },
      request.id
    );
  });

  app.get(`${base}/appointments/:appointmentId/history`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const appointmentId = readUuidParam(request.params, "appointmentId");
    if (!appointmentId) return reply.code(400).send(envelope({ error: "appointmentId must be a UUID" }, request.id));
    const result = await scope.db.query(
      `select id, tenant_id as "tenantId", appointment_id as "appointmentId",
              from_status as "fromStatus", to_status as "toStatus", actor_id as "actorId",
              reason, metadata, created_at as "createdAt"
       from pulso_iris.appointment_status_history
       where tenant_id = $1 and appointment_id = $2
       order by created_at`,
      [scope.tenantId, appointmentId]
    );
    return envelope(pulsoIrisAppointmentStatusHistoryListSchema.parse(result.rows), request.id);
  });

  app.get(`${base}/appointments/:appointmentId/audit`, async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    const appointmentId = readUuidParam(request.params, "appointmentId");
    if (!appointmentId) return reply.code(400).send(envelope({ error: "appointmentId must be a UUID" }, request.id));
    try {
      return envelope(await readAuditHistory(tenantId, "appointment", appointmentId), request.id);
    } catch (error) {
      context.logger.warn("appointment audit history lookup failed", {
        tenantId,
        appointmentId,
        error: error instanceof Error ? error.message : String(error)
      });
      const statusCode = error instanceof AuditHistoryUnavailableError ? error.statusCode : 502;
      return reply.code(statusCode).send(envelope({ error: "Audit history unavailable" }, request.id));
    }
  });

  app.post(`${base}/appointments/:appointmentId/manual-verify`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const operatorId = requireCoordinator(request, reply);
    if (!operatorId) return;
    const appointmentId = readUuidParam(request.params, "appointmentId");
    if (!appointmentId) return reply.code(400).send(envelope({ error: "appointmentId must be a UUID" }, request.id));
    const input = parseBody(pulsoIrisManualVerificationInputSchema, request, reply);
    if (!input) return;

    try {
      const appointment = await scope.db.transaction(async (tx) => {
        const result = await tx.query(
          `update pulso_iris.appointments a
           set status = 'verified', verification_mode = 'manual_external',
               external_reference = $3, legacy_reference = $3, external_system = $4,
               external_note = $5, verified_at = now(), verified_by = $6, updated_at = now()
           from pulso_iris.agenda_settings settings
           where a.tenant_id = $1 and a.id = $2
             and settings.tenant_id = a.tenant_id and settings.mode = 'hybrid_manual'
             and a.status in ('pending_external_confirmation', 'deferred', 'verification_failed')
           returning ${QUALIFIED_APPOINTMENT_COLUMNS}`,
          [scope.tenantId, appointmentId, input.externalReference, input.externalSystem, input.note ?? null, operatorId]
        );
        const updated = pulsoIrisAppointmentListSchema.parse(result.rows)[0];
        if (!updated) return undefined;
        await emitAudit(
          {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: "appointment.manually_verified",
            entityType: "appointment",
            entityId: appointmentId,
            metadata: { verificationMode: "manual_external" }
          },
          tx
        );
        await emitAudit(
          {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: "appointment.verified",
            entityType: "appointment",
            entityId: appointmentId,
            metadata: { verificationMode: "manual_external" }
          },
          tx
        );
        return updated;
      });
      if (!appointment) {
        return reply.code(409).send(envelope({ error: "Appointment cannot be manually verified" }, request.id));
      }
      return envelope(appointment, request.id);
    } catch (error) {
      return handleAppointmentError(error, request, reply);
    }
  });

  app.post(`${base}/appointments/:appointmentId/reject`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const operatorId = requireCoordinator(request, reply);
    if (!operatorId) return;
    const appointmentId = readUuidParam(request.params, "appointmentId");
    if (!appointmentId) return reply.code(400).send(envelope({ error: "appointmentId must be a UUID" }, request.id));
    const input = parseBody(pulsoIrisExternalRejectionInputSchema, request, reply);
    if (!input) return;
    const appointment = await scope.db.transaction(async (tx) => {
      const result = await tx.query(
        `update pulso_iris.appointments
         set status = 'external_rejected', external_rejection_reason = $3,
             external_rejected_at = now(), external_rejected_by = $4, updated_at = now()
         where tenant_id = $1 and id = $2
           and status in ('pending_external_confirmation', 'deferred', 'verification_failed')
         returning ${APPOINTMENT_COLUMNS}`,
        [scope.tenantId, appointmentId, input.reason, operatorId]
      );
      const updated = pulsoIrisAppointmentListSchema.parse(result.rows)[0];
      if (!updated) return undefined;
      await emitAudit(
        {
          tenantId: scope.tenantId,
          actorId: operatorId,
          eventType: "appointment.external_rejected",
          entityType: "appointment",
          entityId: appointmentId
        },
        tx
      );
      return updated;
    });
    if (!appointment) return reply.code(409).send(envelope({ error: "Appointment cannot be rejected" }, request.id));
    return envelope(appointment, request.id);
  });

  app.post(`${base}/appointments/:appointmentId/cancel`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const operatorId = requireCoordinator(request, reply);
    if (!operatorId) return;
    const appointmentId = readUuidParam(request.params, "appointmentId");
    if (!appointmentId) return reply.code(400).send(envelope({ error: "appointmentId must be a UUID" }, request.id));
    const input = parseBody(pulsoIrisAppointmentCancellationInputSchema, request, reply);
    if (!input) return;
    try {
      const appointment = await scope.db.transaction(async (tx) => {
        const transactionalDb = asTransactionalDatabase(tx);
        const current = await lockAppointmentForCancellation(transactionalDb, scope.tenantId, appointmentId);
        if (
          current?.status === "cancelled" &&
          current.cancelledBy === operatorId &&
          current.cancellationReason === input.reason
        ) {
          return current;
        }
        if (current?.status === "cancelled") {
          throw new AgendaProviderError(
            "idempotency_conflict",
            "Appointment cancellation conflicts with the prior cancellation"
          );
        }
        const provider = new InternalAgendaProvider(transactionalDb);
        await provider.cancel({ tenantId: scope.tenantId, appointmentId, actorId: operatorId, reason: input.reason });
        const cancelled = await findAppointment(transactionalDb, scope.tenantId, appointmentId);
        await emitAudit(
          {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: "appointment.cancelled",
            entityType: "appointment",
            entityId: appointmentId
          },
          tx
        );
        return cancelled;
      });
      return envelope(appointment, request.id);
    } catch (error) {
      return handleAppointmentError(error, request, reply);
    }
  });

  app.post(`${base}/appointments/:appointmentId/reschedule`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const operatorId = requireCoordinator(request, reply);
    if (!operatorId) return;
    const appointmentId = readUuidParam(request.params, "appointmentId");
    if (!appointmentId) return reply.code(400).send(envelope({ error: "appointmentId must be a UUID" }, request.id));
    const input = parseBody(pulsoIrisAppointmentRescheduleInputSchema, request, reply);
    if (!input) return;
    const settings = await loadActiveSettings(scope.db, scope.tenantId, request, reply);
    if (!settings) return;
    const current = await findAppointment(scope.db, scope.tenantId, appointmentId);
    if (!current) return reply.code(404).send(envelope({ error: "Appointment not found" }, request.id));
    if (current.status === "rescheduled") {
      const priorReplacement = await findRescheduleReplacement(
        scope.db,
        scope.tenantId,
        appointmentId,
        input.idempotencyKey
      );
      if (priorReplacement) return envelope(priorReplacement, request.id);
    }
    if (
      !["pending_external_confirmation", "verified", "confirmed", "deferred", "verification_failed"].includes(
        current.status
      )
    ) {
      return reply.code(409).send(envelope({ error: "Appointment cannot be rescheduled" }, request.id));
    }
    if (current.rescheduleCount >= settings.maxReschedules) {
      return reply.code(409).send(envelope({ error: "Maximum reschedules reached" }, request.id));
    }

    let holdId = input.holdId;
    if (!holdId) {
      if (!input.siteId || !input.professionalId || !input.appointmentTypeId || !input.scheduledAt) {
        return reply.code(422).send(envelope({ error: "Replacement slot is required" }, request.id));
      }
      const siteId = input.siteId;
      const professionalId = input.professionalId;
      const appointmentTypeId = input.appointmentTypeId;
      const scheduledAt = input.scheduledAt;
      const invalidRef = await ensureTenantReferences(scope.db, scope.tenantId, [
        { id: input.siteId, table: "pulso_iris.sites", label: "siteId" },
        { id: input.professionalId, table: "pulso_iris.professionals", label: "professionalId" },
        { id: input.payerId, table: "pulso_iris.payers", label: "payerId" },
        { id: input.appointmentTypeId, table: "pulso_iris.appointment_types", label: "appointmentTypeId" }
      ]);
      if (invalidRef) return sendReferenceError(reply, request, invalidRef.label);
      if (
        !(await validateBookableRequest(
          scope.db,
          scope.tenantId,
          { professionalId: input.professionalId, payerId: input.payerId, scheduledAt: input.scheduledAt },
          settings,
          request,
          reply
        ))
      ) {
        return;
      }
      try {
        const reserved = await scope.db.transaction(async (tx) => {
          const provider = new InternalAgendaProvider(asTransactionalDatabase(tx));
          const result = await provider.reserve({
            tenantId: scope.tenantId,
            patientId: current.patientId,
            conversationId: current.conversationId,
            siteId,
            professionalId,
            payerId: input.payerId ?? current.payerId,
            appointmentTypeId,
            scheduledAt,
            idempotencyKey: `reschedule-hold:${input.idempotencyKey}`,
            actorId: operatorId,
            holdDurationMinutes: settings.holdDurationMinutes
          });
          await emitExpiredHolds(emitAudit, result.expiredHolds, tx);
          if (!result.idempotent) await emitHoldCreated(emitAudit, result.hold, request, tx);
          return result;
        });
        holdId = reserved.hold.id;
      } catch (error) {
        return handleReservationError(error, scope.db, scope.tenantId, input, settings, request, reply);
      }
    } else {
      const replacementHold = await findHold(scope.db, scope.tenantId, holdId);
      if (!replacementHold) return reply.code(404).send(envelope({ error: "Appointment hold not found" }, request.id));
      if (
        (replacementHold.patientId ?? undefined) !== (current.patientId ?? undefined) ||
        (replacementHold.conversationId ?? undefined) !== (current.conversationId ?? undefined)
      ) {
        return reply.code(422).send(envelope({ error: "Replacement hold belongs to another case" }, request.id));
      }
    }

    try {
      const outcome = await scope.db.transaction(async (tx) => {
        const locked = await tx.query<{ status: string; origin: string; rescheduleCount: number }>(
          `select status, origin, reschedule_count as "rescheduleCount"
           from pulso_iris.appointments
           where tenant_id = $1 and id = $2
           for update`,
          [scope.tenantId, appointmentId]
        );
        const lockedCurrent = locked.rows[0];
        if (!lockedCurrent) throw new AgendaProviderError("invalid_transition", "Appointment not found");
        let created: { appointment: { id: string }; idempotent: boolean } | undefined;
        if (lockedCurrent.status === "rescheduled") {
          const prior = await findRescheduleReplacement(tx, scope.tenantId, appointmentId, input.idempotencyKey);
          if (prior) created = { appointment: { id: prior.id }, idempotent: true };
        }

        const transactionalDb = asTransactionalDatabase(tx);
        const transactionalProvider = new InternalAgendaProvider(transactionalDb);
        if (!created) {
          if (
            !["pending_external_confirmation", "verified", "confirmed", "deferred", "verification_failed"].includes(
              lockedCurrent.status
            )
          ) {
            throw new AgendaProviderError("invalid_transition", "Appointment cannot be rescheduled");
          }
          if (lockedCurrent.rescheduleCount >= settings.maxReschedules) {
            throw new AgendaProviderError("invalid_transition", "Maximum reschedules reached");
          }

          created =
            settings.mode === "internal"
              ? await transactionalProvider.verify({
                  tenantId: scope.tenantId,
                  holdId,
                  appointmentIdempotencyKey: input.idempotencyKey,
                  origin: lockedCurrent.origin,
                  actorId: operatorId,
                  previousAppointmentId: appointmentId,
                  rescheduleCount: lockedCurrent.rescheduleCount + 1
                })
              : await submitHybridAppointment(transactionalDb, {
                  tenantId: scope.tenantId,
                  holdId,
                  idempotencyKey: input.idempotencyKey,
                  origin: lockedCurrent.origin,
                  actorId: operatorId,
                  externalSlaMinutes: settings.externalConfirmationSlaMinutes,
                  previousAppointmentId: appointmentId,
                  rescheduleCount: lockedCurrent.rescheduleCount + 1
                });
          await transactionalProvider.reschedule({
            tenantId: scope.tenantId,
            appointmentId,
            replacementAppointmentId: created.appointment.id,
            actorId: operatorId,
            reason: input.reason
          });
        }

        const fullReplacement = await findAppointment(transactionalDb, scope.tenantId, created.appointment.id);
        if (!created.idempotent) {
          await emitAudit(
            {
              tenantId: scope.tenantId,
              actorId: operatorId,
              eventType:
                settings.mode === "internal" ? "appointment.verified" : "appointment.pending_external_confirmation",
              entityType: "appointment",
              entityId: created.appointment.id,
              metadata: { mode: settings.mode, rescheduledFrom: appointmentId }
            },
            tx
          );
          await emitAudit(
            {
              tenantId: scope.tenantId,
              actorId: operatorId,
              eventType: "appointment.registered",
              entityType: "appointment",
              entityId: created.appointment.id,
              metadata: { mode: settings.mode, rescheduledFrom: appointmentId }
            },
            tx
          );
        }
        await emitAudit(
          {
            tenantId: scope.tenantId,
            actorId: operatorId,
            eventType: "appointment.rescheduled",
            entityType: "appointment",
            entityId: appointmentId,
            metadata: { replacementAppointmentId: created.appointment.id }
          },
          tx
        );
        return { replacement: created, fullReplacement };
      });
      return reply.code(outcome.replacement.idempotent ? 200 : 201).send(envelope(outcome.fullReplacement, request.id));
    } catch (error) {
      if (error instanceof AgendaProviderError && error.code === "hold_expired") {
        await expireAppointmentHolds(scope.db, emitAudit);
      }
      return handleAppointmentError(error, request, reply);
    }
  });

  app.patch(`${base}/appointments/:appointmentId`, async (request, reply) => {
    const scope = await requireTenantDb(context, request, reply);
    if (!scope) return;
    const operatorId = requireCoordinator(request, reply);
    if (!operatorId) return;
    const appointmentId = readUuidParam(request.params, "appointmentId");
    if (!appointmentId) return reply.code(400).send(envelope({ error: "appointmentId must be a UUID" }, request.id));
    const input = parseBody(pulsoIrisAppointmentPatchSchema, request, reply);
    if (!input) return;
    if (input.status !== "confirmed" || input.scheduledAt || input.siteId || input.professionalId || input.holdId) {
      return reply.code(422).send(envelope({ error: "Use explicit cancel or reschedule routes" }, request.id));
    }
    const result = await scope.db.query(
      `update pulso_iris.appointments
       set status = 'confirmed',
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('status_actor', $3::text),
           updated_at = now()
       where tenant_id = $1 and id = $2 and status = 'verified'
       returning ${APPOINTMENT_COLUMNS}`,
      [scope.tenantId, appointmentId, operatorId]
    );
    const appointment = pulsoIrisAppointmentListSchema.parse(result.rows)[0];
    if (!appointment)
      return reply.code(409).send(envelope({ error: "Only verified appointments can be confirmed" }, request.id));
    return envelope(appointment, request.id);
  });
}

async function loadActiveSettings(
  db: Database,
  tenantId: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AgendaSettingsRow | undefined> {
  const result = await db.query<AgendaSettingsRow>(
    `select mode, booking_horizon_days as "bookingHorizonDays",
            hold_duration_minutes as "holdDurationMinutes", max_alternatives as "maxAlternatives",
            max_reschedules as "maxReschedules",
            external_confirmation_sla_minutes as "externalConfirmationSlaMinutes",
            external_reference_required as "externalReferenceRequired", status
     from pulso_iris.agenda_settings where tenant_id = $1`,
    [tenantId]
  );
  const settings = result.rows[0];
  if (!settings) {
    void reply.code(409).send(envelope({ error: "Agenda settings are not configured" }, request.id));
    return undefined;
  }
  if (settings.status !== "active") {
    void reply.code(409).send(envelope({ error: "Agenda is paused" }, request.id));
    return undefined;
  }
  if (settings.mode === "legacy_integrated") {
    void reply.code(409).send(envelope({ error: "Legacy integrated mode requires a real provider" }, request.id));
    return undefined;
  }
  return settings;
}

async function validateBookableRequest(
  db: Database,
  tenantId: string,
  input: { professionalId: string; payerId?: string; scheduledAt: string },
  settings: AgendaSettingsRow,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const scheduledAt = new Date(input.scheduledAt);
  const now = new Date();
  if (scheduledAt.getTime() <= now.getTime()) {
    void reply.code(422).send(envelope({ error: "scheduledAt must be in the future" }, request.id));
    return false;
  }
  if (scheduledAt.getTime() > now.getTime() + settings.bookingHorizonDays * 86_400_000) {
    void reply.code(422).send(envelope({ error: "scheduledAt exceeds booking horizon" }, request.id));
    return false;
  }
  if (input.payerId && (await isProfessionalExcludedForPayer(db, tenantId, input.professionalId, input.payerId))) {
    void reply.code(422).send(envelope({ error: "Professional is excluded for this payer" }, request.id));
    return false;
  }
  return true;
}

async function submitHybridAppointment(
  db: Database,
  input: {
    tenantId: string;
    holdId: string;
    idempotencyKey: string;
    origin: string;
    actorId?: string;
    externalSlaMinutes: number;
    previousAppointmentId?: string;
    rescheduleCount?: number;
  }
): Promise<{ appointment: { id: string }; idempotent: boolean }> {
  return db.transaction(async (tx) => {
    await tx.query(
      `select pg_advisory_xact_lock(hashtextextended(concat_ws(':', 'appointment', $1::text, $2::text), 0))`,
      [input.tenantId, input.idempotencyKey]
    );
    const existing = await tx.query<{ id: string; holdId: string }>(
      `select id, hold_id as "holdId" from pulso_iris.appointments
       where tenant_id = $1 and idempotency_key = $2 for update`,
      [input.tenantId, input.idempotencyKey]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].holdId !== input.holdId) {
        throw new AgendaProviderError("idempotency_conflict", "Idempotency key belongs to another appointment");
      }
      return { appointment: existing.rows[0], idempotent: true };
    }

    const hold = await tx.query<AgendaHold>(
      `select ${HOLD_COLUMNS}
       from pulso_iris.appointment_holds
       where tenant_id = $1 and id = $2 for update`,
      [input.tenantId, input.holdId]
    );
    const row = hold.rows[0];
    if (!row || row.status !== "active" || new Date(row.expiresAt).getTime() <= Date.now()) {
      throw new AgendaProviderError("hold_expired", "Appointment hold is not active");
    }

    const created = await tx.query<{ id: string }>(
      `insert into pulso_iris.appointments (
         tenant_id, patient_id, conversation_id, site_id, professional_id, payer_id,
         appointment_type_id, appointment_type, origin, status, scheduled_at, duration_min,
         slot_capacity_token, idempotency_key, hold_id, external_sla_due_at,
         previous_appointment_id, reschedule_count, metadata
       )
       select
         h.tenant_id, h.patient_id, h.conversation_id, h.site_id, h.professional_id, h.payer_id,
         h.appointment_type_id, t.name, $3, 'pending_external_confirmation', h.scheduled_at, h.duration_min,
         h.slot_capacity_token, $4, h.id, now() + ($5::int * interval '1 minute'),
         $6, coalesce($7, 0), jsonb_build_object('created_by', $8::text)
       from pulso_iris.appointment_holds h
       join pulso_iris.appointment_types t
         on t.tenant_id = h.tenant_id and t.id = h.appointment_type_id
        and t.status = 'active' and t.bookable_by_ia is true
       where h.tenant_id = $1 and h.id = $2
       returning id`,
      [
        input.tenantId,
        input.holdId,
        input.origin,
        input.idempotencyKey,
        input.externalSlaMinutes,
        input.previousAppointmentId ?? null,
        input.rescheduleCount ?? 0,
        input.actorId ?? "system"
      ]
    );
    const appointment = created.rows[0];
    if (!appointment) {
      throw new AgendaProviderError("slot_unavailable", "Appointment type is not bookable by IA");
    }
    await tx.query(
      `update pulso_iris.appointment_holds
       set status = 'consumed', appointment_id = $3, consumed_at = now(), updated_at = now()
       where tenant_id = $1 and id = $2`,
      [input.tenantId, input.holdId, appointment.id]
    );
    return { appointment, idempotent: false };
  });
}

async function findAppointment(
  db: Pick<Database, "query">,
  tenantId: string,
  appointmentId: string
): Promise<PulsoIrisAppointment | undefined> {
  const result = await db.query(
    `select ${APPOINTMENT_COLUMNS}
     from pulso_iris.appointments where tenant_id = $1 and id = $2`,
    [tenantId, appointmentId]
  );
  return pulsoIrisAppointmentListSchema.parse(result.rows)[0];
}

async function lockAppointmentForCancellation(
  db: Pick<Database, "query">,
  tenantId: string,
  appointmentId: string
): Promise<PulsoIrisAppointment | undefined> {
  const result = await db.query(
    `select ${APPOINTMENT_COLUMNS}
     from pulso_iris.appointments
     where tenant_id = $1 and id = $2
     for update`,
    [tenantId, appointmentId]
  );
  return pulsoIrisAppointmentListSchema.parse(result.rows)[0];
}

async function findHold(
  db: Pick<Database, "query">,
  tenantId: string,
  holdId: string
): Promise<AgendaHold | undefined> {
  const result = await db.query<AgendaHold>(
    `select ${HOLD_COLUMNS}
     from pulso_iris.appointment_holds
     where tenant_id = $1 and id = $2`,
    [tenantId, holdId]
  );
  return result.rows[0];
}

type TransactionExecutor = Parameters<Parameters<Database["transaction"]>[0]>[0];

function asTransactionalDatabase(transaction: TransactionExecutor): Database {
  return {
    query: (text, params) => transaction.query(text, params),
    transaction: (work) => work(transaction),
    close: async () => undefined
  };
}

async function findRescheduleReplacement(
  db: Pick<Database, "query">,
  tenantId: string,
  previousAppointmentId: string,
  idempotencyKey: string
): Promise<PulsoIrisAppointment | undefined> {
  const result = await db.query(
    `select ${APPOINTMENT_COLUMNS}
     from pulso_iris.appointments
     where tenant_id = $1 and previous_appointment_id = $2 and idempotency_key = $3`,
    [tenantId, previousAppointmentId, idempotencyKey]
  );
  return pulsoIrisAppointmentListSchema.parse(result.rows)[0];
}

function requireCoordinator(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const headers = request.headers as Record<string, unknown>;
  const role = readOperatorRole(headers);
  const operatorId = readOperatorId(headers);
  if ((role === "admin" || role === "coordinator") && operatorId) return operatorId;
  void reply.code(403).send(envelope({ error: "Coordinator role required" }, request.id));
  return undefined;
}

async function emitHoldCreated(
  emitAudit: AuditEmitter,
  hold: AgendaHold,
  request: FastifyRequest,
  tx: TransactionExecutor
): Promise<void> {
  await emitAudit(
    {
      tenantId: hold.tenantId,
      actorId: readOperatorId(request.headers as Record<string, unknown>),
      eventType: "appointment.hold.created",
      entityType: "appointment_hold",
      entityId: hold.id,
      metadata: { expiresAt: hold.expiresAt }
    },
    tx
  );
}

async function emitExpiredHolds(
  emitAudit: AuditEmitter,
  holds: Array<{ id: string; tenantId: string }>,
  tx: TransactionExecutor
): Promise<void> {
  for (const hold of holds) {
    await emitAudit(
      {
        tenantId: hold.tenantId,
        actorId: "system",
        eventType: "appointment.hold.expired",
        entityType: "appointment_hold",
        entityId: hold.id
      },
      tx
    );
  }
}

async function handleReservationError(
  error: unknown,
  db: Database,
  tenantId: string,
  input: {
    siteId?: string;
    professionalId?: string;
    appointmentTypeId?: string;
    scheduledAt?: string;
    payerId?: string;
  },
  settings: AgendaSettingsRow,
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (
    (error instanceof AgendaProviderError && error.code === "slot_unavailable") ||
    mapDatabaseError(error)?.statusCode === 409
  ) {
    const alternatives =
      input.siteId && input.professionalId && input.appointmentTypeId && input.scheduledAt
        ? await listSlotAlternatives(db, {
            tenantId,
            siteId: input.siteId,
            professionalId: input.professionalId,
            appointmentTypeId: input.appointmentTypeId,
            from: input.scheduledAt,
            payerId: input.payerId,
            limit: settings.maxAlternatives,
            horizonEnd: new Date(Date.now() + settings.bookingHorizonDays * 86_400_000)
          })
        : [];
    return reply.code(409).send(envelope({ error: "Appointment slot is not available", alternatives }, request.id));
  }
  return handleAppointmentError(error, request, reply);
}

function handleAppointmentError(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof AgendaProviderError) {
    const statusCode = error.code === "idempotency_conflict" ? 409 : error.code === "hold_expired" ? 410 : 409;
    return reply.code(statusCode).send(envelope({ error: error.message, code: error.code }, request.id));
  }
  const mapped = mapDatabaseError(error);
  if (mapped) return reply.code(mapped.statusCode).send(envelope({ error: mapped.message }, request.id));
  throw error;
}
