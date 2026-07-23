import type { ServiceContext } from "@hyperion/service-runtime";
import {
  AgendaProviderError,
  type AgendaAppointmentRecord,
  type AgendaCancellationInput,
  type AgendaExpiredHold,
  type AgendaHold,
  type AgendaProvider,
  type AgendaReservationInput,
  type AgendaReservationResult,
  type AgendaRescheduleInput,
  type InternalVerificationInput
} from "./agenda-provider.js";
import { listAvailabilitySlots, reserveAppointmentSlotToken } from "./availability-engine.js";

type Database = NonNullable<ServiceContext["db"]>;

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
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const APPOINTMENT_RESULT_COLUMNS = `
  id,
  tenant_id as "tenantId",
  status,
  verification_mode as "verificationMode",
  scheduled_at as "scheduledAt",
  idempotency_key as "idempotencyKey",
  hold_id as "holdId"
`;

export class InternalAgendaProvider implements AgendaProvider {
  readonly kind = "internal" as const;

  constructor(private readonly db: Database) {}

  consultAvailability(filters: Parameters<AgendaProvider["consultAvailability"]>[0]) {
    return listAvailabilitySlots(this.db, filters);
  }

  async reserve(input: AgendaReservationInput): Promise<AgendaReservationResult> {
    const scheduledAt = new Date(input.scheduledAt);
    return this.db.transaction(async (tx) => {
      const expired = await tx.query<AgendaExpiredHold>(
        `update pulso_iris.appointment_holds
         set status = 'expired', updated_at = now()
         where tenant_id = $1 and status = 'active' and expires_at <= now()
         returning id, tenant_id as "tenantId"`,
        [input.tenantId]
      );

      await tx.query(`select pg_advisory_xact_lock(hashtextextended(concat_ws(':', 'hold', $1::text, $2::text), 0))`, [
        input.tenantId,
        input.idempotencyKey
      ]);

      const existing = await tx.query<AgendaHold>(
        `select ${HOLD_COLUMNS}
         from pulso_iris.appointment_holds
         where tenant_id = $1 and idempotency_key = $2
         for update`,
        [input.tenantId, input.idempotencyKey]
      );
      const prior = existing.rows[0];
      if (prior) {
        if (!sameReservation(prior, input)) {
          throw new AgendaProviderError("idempotency_conflict", "Idempotency key belongs to another hold");
        }
        return { hold: prior, idempotent: true, expiredHolds: expired.rows };
      }
      if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
        throw new AgendaProviderError("slot_unavailable", "Appointment slot must be in the future");
      }

      const normalizedScheduledAt = scheduledAt.toISOString();
      await tx.query(
        `select pg_advisory_xact_lock(
           hashtextextended(concat_ws(':', $1::text, $2::text, $3::text, $4::text, $5::text), 0)
         )`,
        [input.tenantId, input.siteId, input.professionalId, input.appointmentTypeId, normalizedScheduledAt]
      );

      const concurrent = await tx.query<AgendaHold>(
        `select ${HOLD_COLUMNS}
         from pulso_iris.appointment_holds
         where tenant_id = $1 and idempotency_key = $2
         for update`,
        [input.tenantId, input.idempotencyKey]
      );
      if (concurrent.rows[0]) {
        if (!sameReservation(concurrent.rows[0], input)) {
          throw new AgendaProviderError("idempotency_conflict", "Idempotency key belongs to another hold");
        }
        return { hold: concurrent.rows[0], idempotent: true, expiredHolds: expired.rows };
      }

      const reservation = await reserveAppointmentSlotToken(tx, input);
      if (!reservation) {
        throw new AgendaProviderError("slot_unavailable", "Appointment slot is not available");
      }

      const type = await tx.query<{ durationMin: number }>(
        `select duration_min as "durationMin"
         from pulso_iris.appointment_types
         where tenant_id = $1 and id = $2 and status = 'active' and bookable_by_ia is true`,
        [input.tenantId, input.appointmentTypeId]
      );
      const durationMin = type.rows[0]?.durationMin;
      if (!durationMin) {
        throw new AgendaProviderError("slot_unavailable", "Appointment type is not bookable by IA");
      }

      const inserted = await tx.query<AgendaHold>(
        `insert into pulso_iris.appointment_holds (
           tenant_id, patient_id, conversation_id, site_id, professional_id, payer_id,
           appointment_type_id, scheduled_at, duration_min, slot_capacity_token,
           expires_at, idempotency_key, created_by, metadata
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           now() + ($11::int * interval '1 minute'), $12, $13,
           jsonb_build_object('slotTimeZone', $14::text)
         )
         returning ${HOLD_COLUMNS}`,
        [
          input.tenantId,
          input.patientId ?? null,
          input.conversationId ?? null,
          input.siteId,
          input.professionalId,
          input.payerId ?? null,
          input.appointmentTypeId,
          input.scheduledAt,
          durationMin,
          reservation.slotCapacityToken,
          input.holdDurationMinutes,
          input.idempotencyKey,
          input.actorId ?? "system",
          reservation.slot.timeZone
        ]
      );

      return { hold: inserted.rows[0]!, idempotent: false, expiredHolds: expired.rows };
    });
  }

  async verify(input: InternalVerificationInput): Promise<{
    appointment: AgendaAppointmentRecord;
    idempotent: boolean;
  }> {
    return this.db.transaction(async (tx) => {
      await lockAppointmentIdempotency(tx, input.tenantId, input.appointmentIdempotencyKey);
      const existing = await tx.query<AgendaAppointmentRecord>(
        `select ${APPOINTMENT_RESULT_COLUMNS}
         from pulso_iris.appointments
         where tenant_id = $1 and idempotency_key = $2
         for update`,
        [input.tenantId, input.appointmentIdempotencyKey]
      );
      if (existing.rows[0]) {
        if (existing.rows[0].holdId !== input.holdId) {
          throw new AgendaProviderError("idempotency_conflict", "Idempotency key belongs to another appointment");
        }
        return { appointment: existing.rows[0], idempotent: true };
      }

      const settings = await tx.query<{ mode: string; status: string }>(
        `select mode, status from pulso_iris.agenda_settings where tenant_id = $1 for update`,
        [input.tenantId]
      );
      if (settings.rows[0]?.mode !== "internal" || settings.rows[0]?.status !== "active") {
        throw new AgendaProviderError("agenda_paused", "Internal agenda mode is not active");
      }

      const hold = await tx.query<AgendaHold>(
        `select ${HOLD_COLUMNS}
         from pulso_iris.appointment_holds
         where tenant_id = $1 and id = $2
         for update`,
        [input.tenantId, input.holdId]
      );
      const row = hold.rows[0];
      if (
        !row ||
        row.status !== "active" ||
        new Date(row.expiresAt).getTime() <= Date.now() ||
        new Date(row.scheduledAt).getTime() <= Date.now()
      ) {
        throw new AgendaProviderError("hold_expired", "Appointment hold is not active");
      }

      const created = await tx.query<AgendaAppointmentRecord>(
        `insert into pulso_iris.appointments (
           tenant_id, patient_id, conversation_id, site_id, professional_id, payer_id,
           appointment_type_id, appointment_type, origin, status, scheduled_at, duration_min,
           slot_capacity_token, idempotency_key, hold_id, verification_mode, verified_at, verified_by,
           previous_appointment_id, reschedule_count, metadata
         )
         select
           h.tenant_id, h.patient_id, h.conversation_id, h.site_id, h.professional_id, h.payer_id,
           h.appointment_type_id, t.name, $3, 'verified', h.scheduled_at, h.duration_min,
           h.slot_capacity_token, $4, h.id, 'internal', now(), $5, $6, coalesce($7, 0),
           coalesce(h.metadata, '{}'::jsonb) || jsonb_build_object('created_by', $5::text)
         from pulso_iris.appointment_holds h
         join pulso_iris.appointment_types t
           on t.tenant_id = h.tenant_id and t.id = h.appointment_type_id
          and t.status = 'active' and t.bookable_by_ia is true
         where h.tenant_id = $1 and h.id = $2 and h.scheduled_at > now()
         returning ${APPOINTMENT_RESULT_COLUMNS}`,
        [
          input.tenantId,
          input.holdId,
          input.origin,
          input.appointmentIdempotencyKey,
          input.actorId ?? "system",
          input.previousAppointmentId ?? null,
          input.rescheduleCount ?? 0
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

  async cancel(input: AgendaCancellationInput): Promise<AgendaAppointmentRecord> {
    const result = await this.db.query<AgendaAppointmentRecord>(
      `update pulso_iris.appointments
       set status = 'cancelled', cancellation_reason = $3, cancelled_at = now(),
           cancelled_by = $4, updated_at = now()
       where tenant_id = $1 and id = $2
         and status in ('pending_external_confirmation', 'verified', 'confirmed', 'deferred', 'verification_failed')
         and scheduled_at > now()
       returning ${APPOINTMENT_RESULT_COLUMNS}`,
      [input.tenantId, input.appointmentId, input.reason, input.actorId ?? "system"]
    );
    if (!result.rows[0]) throw new AgendaProviderError("invalid_transition", "Appointment cannot be cancelled");
    return result.rows[0];
  }

  async reschedule(input: AgendaRescheduleInput): Promise<AgendaAppointmentRecord> {
    const result = await this.db.query<AgendaAppointmentRecord>(
      `update pulso_iris.appointments
       set status = 'rescheduled', cancellation_reason = $4, cancelled_at = now(),
           cancelled_by = $5,
           metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('replacementAppointmentId', $3::text),
           updated_at = now()
       where tenant_id = $1 and id = $2
         and status in ('pending_external_confirmation', 'verified', 'confirmed', 'deferred', 'verification_failed')
         and scheduled_at > now()
       returning ${APPOINTMENT_RESULT_COLUMNS}`,
      [input.tenantId, input.appointmentId, input.replacementAppointmentId, input.reason, input.actorId ?? "system"]
    );
    if (!result.rows[0]) throw new AgendaProviderError("invalid_transition", "Appointment cannot be rescheduled");
    return result.rows[0];
  }
}

async function lockAppointmentIdempotency(
  db: Pick<Database, "query">,
  tenantId: string,
  idempotencyKey: string
): Promise<void> {
  await db.query(
    `select pg_advisory_xact_lock(hashtextextended(concat_ws(':', 'appointment', $1::text, $2::text), 0))`,
    [tenantId, idempotencyKey]
  );
}

function sameReservation(hold: AgendaHold, input: AgendaReservationInput): boolean {
  return (
    hold.siteId === input.siteId &&
    hold.professionalId === input.professionalId &&
    hold.appointmentTypeId === input.appointmentTypeId &&
    (hold.payerId ?? undefined) === input.payerId &&
    (hold.patientId ?? undefined) === input.patientId &&
    (hold.conversationId ?? undefined) === input.conversationId &&
    new Date(hold.scheduledAt).getTime() === new Date(input.scheduledAt).getTime()
  );
}
