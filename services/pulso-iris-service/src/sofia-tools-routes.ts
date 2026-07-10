import { timingSafeEqual } from "node:crypto";
import { envelope } from "@hyperion/contracts";
import type { DatabaseClient } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AgendaProviderError } from "./agenda-provider.js";
import type { AuditEmitter } from "./audit-client.js";
import { InternalAgendaProvider } from "./internal-agenda-provider.js";
import { listSlotAlternatives } from "./availability-engine.js";
import { readTenantId } from "./shared.js";

const uuid = z.string().uuid();
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const idempotencyKey = z.string().trim().min(8).max(200);
const confirmationMessage = z.object({ confirmationMessageId: uuid });

const toolSchemas = {
  get_catalog: z.object({}),
  identify_patient_by_phone: z.object({
    phoneHash: z.string().regex(/^[a-f0-9]{64}$/),
    phoneMasked: z.string().min(3).max(32),
    threadBindingId: uuid,
    externalMessageId: z.string().trim().min(1).max(256),
    body: z.string().trim().min(1).max(2_000)
  }),
  update_patient_name: z.object({
    patientId: uuid,
    fullName: z.string().trim().min(2).max(160)
  }),
  search_availability: z.object({
    from: z.string().datetime().optional(),
    localDate: dateOnly.optional(),
    localTime: localTime.optional(),
    days: z.number().int().min(1).max(31).default(14),
    siteId: uuid.optional(),
    professionalId: uuid.optional(),
    payerId: uuid.optional(),
    appointmentTypeId: uuid.optional()
  }),
  create_appointment_hold: z
    .object({
      patientId: uuid,
      conversationId: uuid,
      siteId: uuid,
      professionalId: uuid,
      payerId: uuid,
      appointmentTypeId: uuid,
      scheduledAt: z.string().datetime(),
      idempotencyKey
    })
    .merge(confirmationMessage),
  book_appointment: z
    .object({
      patientId: uuid,
      conversationId: uuid,
      holdId: uuid,
      idempotencyKey
    })
    .merge(confirmationMessage),
  list_patient_appointments: z.object({ patientId: uuid }),
  cancel_appointment: z
    .object({
      patientId: uuid,
      conversationId: uuid,
      appointmentId: uuid,
      reason: z.string().trim().min(2).max(300),
      idempotencyKey
    })
    .merge(confirmationMessage),
  reschedule_appointment: z
    .object({
      patientId: uuid,
      conversationId: uuid,
      appointmentId: uuid,
      siteId: uuid,
      professionalId: uuid,
      payerId: uuid,
      appointmentTypeId: uuid,
      scheduledAt: z.string().datetime(),
      reason: z.string().trim().min(2).max(300),
      idempotencyKey
    })
    .merge(confirmationMessage),
  create_urgent_handoff: z.object({
    patientId: uuid,
    conversationId: uuid,
    triggerCode: z.literal("symptom_or_urgency_signal")
  })
} as const;

type ToolName = keyof typeof toolSchemas;
type Database = NonNullable<ServiceContext["db"]>;

export async function registerSofiaToolRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  emitAudit: AuditEmitter
): Promise<void> {
  app.post("/internal/v1/tenants/:tenantId/pulso-iris/sofia/tools/:toolName", async (request, reply) => {
    if (!authorizeInternal(request, reply, context.config.internalServiceToken)) return;
    const tenantId = readTenantId(request.params);
    if (!tenantId) return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    if (!context.db) return reply.code(503).send(envelope({ error: "Database unavailable" }, request.id));
    const toolName = readToolName(request.params);
    if (!toolName) return reply.code(404).send(envelope({ error: "Unknown SOFIA tool" }, request.id));
    const parsed = toolSchemas[toolName].safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(
        envelope(
          {
            error: "Invalid tool input",
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
          },
          request.id
        )
      );
    }

    try {
      const result = await executeTool(context.db, tenantId, toolName, parsed.data as never, emitAudit);
      emitAudit({
        tenantId,
        actorId: "agent:SOFIA",
        eventType: "agent.tool.executed",
        entityType: "sofia_tool",
        metadata: { tool: toolName }
      });
      return envelope(result, request.id);
    } catch (error) {
      if (error instanceof ToolError) {
        return reply
          .code(error.statusCode)
          .send(envelope({ error: error.message, code: error.code, ...error.data }, request.id));
      }
      if (error instanceof AgendaProviderError) {
        return reply
          .code(error.code === "hold_expired" ? 410 : 409)
          .send(envelope({ error: error.message, code: error.code }, request.id));
      }
      throw error;
    }
  });
}

async function executeTool(
  db: Database,
  tenantId: string,
  toolName: ToolName,
  input: never,
  emitAudit: AuditEmitter
): Promise<unknown> {
  switch (toolName) {
    case "get_catalog":
      return getCatalog(db, tenantId);
    case "identify_patient_by_phone":
      return identifyPatient(
        db,
        tenantId,
        input as z.infer<(typeof toolSchemas)["identify_patient_by_phone"]>,
        emitAudit
      );
    case "update_patient_name":
      return updatePatientName(db, tenantId, input as z.infer<(typeof toolSchemas)["update_patient_name"]>);
    case "search_availability":
      return searchAvailability(db, tenantId, input as z.infer<(typeof toolSchemas)["search_availability"]>);
    case "create_appointment_hold":
      return createHold(db, tenantId, input as z.infer<(typeof toolSchemas)["create_appointment_hold"]>, emitAudit);
    case "book_appointment":
      return bookAppointment(db, tenantId, input as z.infer<(typeof toolSchemas)["book_appointment"]>, emitAudit);
    case "list_patient_appointments":
      return listAppointments(db, tenantId, input as z.infer<(typeof toolSchemas)["list_patient_appointments"]>);
    case "cancel_appointment":
      return cancelAppointment(db, tenantId, input as z.infer<(typeof toolSchemas)["cancel_appointment"]>, emitAudit);
    case "reschedule_appointment":
      return rescheduleAppointment(
        db,
        tenantId,
        input as z.infer<(typeof toolSchemas)["reschedule_appointment"]>,
        emitAudit
      );
    case "create_urgent_handoff":
      return createUrgentHandoff(
        db,
        tenantId,
        input as z.infer<(typeof toolSchemas)["create_urgent_handoff"]>,
        emitAudit
      );
  }
}

async function getCatalog(db: Database, tenantId: string) {
  const [sites, payers, appointmentTypes, professionals, agendaSettings] = await Promise.all([
    db.query(
      `select id, name, city, address from pulso_iris.sites where tenant_id = $1 and status = 'active' order by name`,
      [tenantId]
    ),
    db.query(
      `select id, name, payer_group as "group", requires_authorization as "requiresAuthorization"
       from pulso_iris.payers where tenant_id = $1 and status = 'active' order by name`,
      [tenantId]
    ),
    db.query(
      `select id, name, category, duration_min as "durationMin", preparation_text as "preparationText",
              bookable_by_ia as "bookableByIa"
       from pulso_iris.appointment_types where tenant_id = $1 and status = 'active' order by slot_priority, name`,
      [tenantId]
    ),
    db.query(
      `select p.id, p.name, p.professional_type as "professionalType", p.subspecialty,
              p.is_pilot as "isPilot", p.status
       from pulso_iris.professionals p where p.tenant_id = $1 and p.status = 'active' order by p.name`,
      [tenantId]
    ),
    db.query(`select timezone from pulso_iris.agenda_settings where tenant_id = $1`, [tenantId])
  ]);
  return {
    sites: sites.rows,
    payers: payers.rows,
    appointmentTypes: appointmentTypes.rows,
    professionals: professionals.rows,
    agendaSettings: agendaSettings.rows[0] ?? null
  };
}

async function identifyPatient(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["identify_patient_by_phone"]>,
  emitAudit: AuditEmitter
) {
  return db.transaction(async (tx) => {
    const binding = await tx.query<{ id: string; patientId?: string; conversationId?: string }>(
      `select id, patient_id as "patientId", conversation_id as "conversationId"
       from channel_runtime.thread_bindings where tenant_id = $1 and id = $2 for update`,
      [tenantId, input.threadBindingId]
    );
    if (!binding.rows[0])
      throw new ToolError(422, "thread_binding_not_found", "Channel thread does not belong to tenant");

    const patientResult = await tx.query<{ id: string; fullName?: string }>(
      `insert into pulso_iris.administrative_patients
         (tenant_id, status, preferred_channel, phone_e164_hash, phone_masked, metadata)
       values ($1, 'active', 'whatsapp', $2, $3, '{"source":"sofia_wa_pilot"}'::jsonb)
       on conflict (tenant_id, phone_e164_hash) where phone_e164_hash is not null
       do update set phone_masked = excluded.phone_masked, updated_at = now()
       returning id, full_name as "fullName"`,
      [tenantId, input.phoneHash, input.phoneMasked]
    );
    const patient = patientResult.rows[0]!;

    let conversationId = binding.rows[0].conversationId;
    if (conversationId) {
      const active = await tx.query<{ id: string }>(
        `select id from pulso_iris.conversations
         where tenant_id = $1 and id = $2 and status in ('active', 'handoff_required') for update`,
        [tenantId, conversationId]
      );
      if (!active.rows[0]) conversationId = undefined;
    }
    if (!conversationId) {
      const conversation = await tx.query<{ id: string }>(
        `insert into pulso_iris.conversations
           (tenant_id, patient_id, channel, direction, status, primary_intent, metadata)
         values ($1, $2, 'whatsapp', 'inbound', 'active', 'identifying',
                 '{"provider":"whatsapp_web_test","origin":"sofia_wa"}'::jsonb)
         returning id`,
        [tenantId, patient.id]
      );
      conversationId = conversation.rows[0]!.id;
    }

    const insertedMessage = await tx.query<{ id: string }>(
      `insert into pulso_iris.messages
         (tenant_id, conversation_id, sender, body, provider, external_message_id, delivery_status, metadata)
       values ($1, $2, 'patient', $3, 'whatsapp_web_test', $4, 'received', '{}'::jsonb)
       on conflict (tenant_id, provider, external_message_id)
         where provider is not null and external_message_id is not null
       do nothing
       returning id`,
      [tenantId, conversationId, input.body, input.externalMessageId]
    );
    const existingMessage = insertedMessage.rows[0]
      ? insertedMessage.rows[0]
      : (
          await tx.query<{ id: string }>(
            `select id from pulso_iris.messages
             where tenant_id = $1 and provider = 'whatsapp_web_test' and external_message_id = $2`,
            [tenantId, input.externalMessageId]
          )
        ).rows[0]!;

    await tx.query(
      `update channel_runtime.thread_bindings
       set patient_id = $3, conversation_id = $4, last_inbound_at = now(), updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, input.threadBindingId, patient.id, conversationId]
    );
    await tx.query(
      `update channel_runtime.inbound_events
       set thread_binding_id = $3, message_id = $4, updated_at = now()
       where tenant_id = $1 and external_message_id = $2 and provider = 'whatsapp_web_test'`,
      [tenantId, input.externalMessageId, input.threadBindingId, existingMessage.id]
    );

    if (insertedMessage.rows[0]) {
      emitAudit({
        tenantId,
        actorId: "agent:SOFIA",
        eventType: "channel.message.received",
        entityType: "message",
        entityId: existingMessage.id,
        metadata: { provider: "whatsapp_web_test", channel: "whatsapp" }
      });
    }
    return {
      patientId: patient.id,
      conversationId,
      messageId: existingMessage.id,
      nameRequired: !patient.fullName,
      idempotent: !insertedMessage.rows[0]
    };
  });
}

async function updatePatientName(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["update_patient_name"]>
) {
  const result = await db.query<{ id: string; fullName: string }>(
    `update pulso_iris.administrative_patients set full_name = $3, updated_at = now()
     where tenant_id = $1 and id = $2 returning id, full_name as "fullName"`,
    [tenantId, input.patientId, input.fullName]
  );
  if (!result.rows[0]) throw new ToolError(404, "patient_not_found", "Patient not found");
  return result.rows[0];
}

async function searchAvailability(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["search_availability"]>
) {
  const settings = await loadInternalSettings(db, tenantId);
  let from: Date;
  let requestedTo: Date;
  if (input.localDate) {
    const bounds = await db.query<{ from: Date; to: Date }>(
      `select (($1::date + coalesce($2::time, time '00:00'))::timestamp at time zone $3) as "from",
              (($1::date + $4::integer)::timestamp at time zone $3) as "to"`,
      [input.localDate, input.localTime ?? null, settings.timezone, input.days]
    );
    from = new Date(bounds.rows[0]!.from);
    requestedTo = new Date(bounds.rows[0]!.to);
    const now = new Date();
    if (requestedTo.getTime() <= now.getTime()) {
      throw new ToolError(422, "availability_window_elapsed", "Availability window is in the past");
    }
    if (input.localTime && from.getTime() <= now.getTime()) {
      throw new ToolError(422, "availability_start_in_past", "Availability start time is in the past");
    }
    if (from.getTime() < now.getTime()) from = now;
  } else {
    from = input.from ? new Date(input.from) : new Date();
    requestedTo = new Date(from.getTime() + input.days * 86_400_000);
  }
  const horizonEnd = new Date(Date.now() + settings.bookingHorizonDays * 86_400_000);
  const to = requestedTo < horizonEnd ? requestedTo : horizonEnd;
  let payerName: string | null = null;
  if (input.payerId) {
    const payer = await db.query<{ name: string }>(
      `select name from pulso_iris.payers where tenant_id = $1 and id = $2`,
      [tenantId, input.payerId]
    );
    if (!payer.rows[0]) throw new ToolError(404, "payer_not_found", "Payer not found");
    payerName = payer.rows[0].name;
  }
  const provider = new InternalAgendaProvider(db);
  const result = await provider.consultAvailability({
    tenantId,
    from,
    to,
    siteId: input.siteId,
    professionalId: input.professionalId,
    payerId: input.payerId,
    appointmentTypeId: input.appointmentTypeId,
    includeFull: false
  });
  return {
    ...result,
    slots: result.slots.slice(0, settings.maxAlternatives).map((slot) => ({
      ...slot,
      payerId: input.payerId ?? null,
      payerName,
      scheduledAt: slot.startsAt
    }))
  };
}

async function createHold(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["create_appointment_hold"]>,
  emitAudit: AuditEmitter
) {
  await requireExplicitConfirmation(db, tenantId, input.conversationId, input.confirmationMessageId, "book");
  const settings = await loadInternalSettings(db, tenantId);
  const provider = new InternalAgendaProvider(db);
  try {
    const result = await provider.reserve({
      tenantId,
      patientId: input.patientId,
      conversationId: input.conversationId,
      siteId: input.siteId,
      professionalId: input.professionalId,
      payerId: input.payerId,
      appointmentTypeId: input.appointmentTypeId,
      scheduledAt: input.scheduledAt,
      idempotencyKey: input.idempotencyKey,
      actorId: "agent:SOFIA",
      holdDurationMinutes: settings.holdDurationMinutes
    });
    emitExpiredHoldAudits(result.expiredHolds, emitAudit);
    if (!result.idempotent) {
      emitAudit({
        tenantId,
        actorId: "agent:SOFIA",
        eventType: "appointment.hold.created",
        entityType: "appointment_hold",
        entityId: result.hold.id,
        metadata: { expiresAt: result.hold.expiresAt, origin: "sofia_wa" }
      });
    }
    return result;
  } catch (error) {
    if (error instanceof AgendaProviderError && error.code === "slot_unavailable") {
      const alternatives = await listSlotAlternatives(db, {
        tenantId,
        siteId: input.siteId,
        professionalId: input.professionalId,
        appointmentTypeId: input.appointmentTypeId,
        payerId: input.payerId,
        from: input.scheduledAt,
        limit: settings.maxAlternatives,
        horizonEnd: new Date(Date.now() + settings.bookingHorizonDays * 86_400_000)
      });
      throw new ToolError(409, "slot_unavailable", "Appointment slot is not available", { alternatives });
    }
    throw error;
  }
}

async function bookAppointment(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["book_appointment"]>,
  emitAudit: AuditEmitter
) {
  await requireExplicitConfirmation(db, tenantId, input.conversationId, input.confirmationMessageId, "book");
  await assertHoldOwner(db, tenantId, input.holdId, input.patientId, input.conversationId);
  const result = await new InternalAgendaProvider(db).verify({
    tenantId,
    holdId: input.holdId,
    appointmentIdempotencyKey: input.idempotencyKey,
    origin: "sofia_wa",
    actorId: "agent:SOFIA"
  });
  if (!result.idempotent) {
    emitAudit({
      tenantId,
      actorId: "agent:SOFIA",
      eventType: "appointment.registered",
      entityType: "appointment",
      entityId: result.appointment.id,
      metadata: { mode: "internal", origin: "sofia_wa" }
    });
    emitAudit({
      tenantId,
      actorId: "agent:SOFIA",
      eventType: "appointment.verified",
      entityType: "appointment",
      entityId: result.appointment.id,
      metadata: { verificationMode: "internal", origin: "sofia_wa" }
    });
  }
  return { appointment: await findAppointmentView(db, tenantId, result.appointment.id), idempotent: result.idempotent };
}

async function listAppointments(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["list_patient_appointments"]>
) {
  const result = await db.query(
    `${appointmentViewSql()}
     where a.tenant_id = $1 and a.patient_id = $2
     order by coalesce(a.scheduled_at, a.created_at) desc limit 20`,
    [tenantId, input.patientId]
  );
  return { appointments: result.rows };
}

async function cancelAppointment(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["cancel_appointment"]>,
  emitAudit: AuditEmitter
) {
  await requireExplicitConfirmation(db, tenantId, input.conversationId, input.confirmationMessageId, "cancel");
  const result = await db.transaction(async (tx) => {
    const current = await tx.query<{ id: string; status: string; key?: string }>(
      `select id, status, metadata->>'sofiaCancelIdempotencyKey' as key
       from pulso_iris.appointments
       where tenant_id = $1 and id = $2 and patient_id = $3 for update`,
      [tenantId, input.appointmentId, input.patientId]
    );
    if (!current.rows[0]) throw new ToolError(404, "appointment_not_found", "Appointment not found");
    if (current.rows[0].status === "cancelled" && current.rows[0].key === input.idempotencyKey) return true;
    const transactionalDb = asTransactionalDatabase(tx);
    await new InternalAgendaProvider(transactionalDb).cancel({
      tenantId,
      appointmentId: input.appointmentId,
      actorId: "agent:SOFIA",
      reason: input.reason
    });
    await tx.query(
      `update pulso_iris.appointments
       set metadata = metadata || jsonb_build_object('sofiaCancelIdempotencyKey', $3::text)
       where tenant_id = $1 and id = $2`,
      [tenantId, input.appointmentId, input.idempotencyKey]
    );
    return false;
  });
  if (!result) {
    emitAudit({
      tenantId,
      actorId: "agent:SOFIA",
      eventType: "appointment.cancelled",
      entityType: "appointment",
      entityId: input.appointmentId,
      metadata: { origin: "sofia_wa" }
    });
  }
  return { appointment: await findAppointmentView(db, tenantId, input.appointmentId), idempotent: result };
}

async function rescheduleAppointment(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["reschedule_appointment"]>,
  emitAudit: AuditEmitter
) {
  await requireExplicitConfirmation(db, tenantId, input.conversationId, input.confirmationMessageId, "reschedule");
  const settings = await loadInternalSettings(db, tenantId);
  const preflight = await db.query<{ status: string; rescheduleCount: number }>(
    `select status, reschedule_count as "rescheduleCount"
     from pulso_iris.appointments
     where tenant_id = $1 and id = $2 and patient_id = $3`,
    [tenantId, input.appointmentId, input.patientId]
  );
  const initial = preflight.rows[0];
  if (!initial) throw new ToolError(404, "appointment_not_found", "Appointment not found");
  if (initial.status === "rescheduled") {
    const prior = await findReplacementByIdempotency(db, tenantId, input.appointmentId, input.idempotencyKey);
    if (prior) {
      return {
        previousAppointment: await findAppointmentView(db, tenantId, input.appointmentId),
        appointment: await findAppointmentView(db, tenantId, prior),
        idempotent: true
      };
    }
    throw new ToolError(409, "invalid_transition", "Appointment cannot be rescheduled");
  }
  if (!isReschedulable(initial.status)) {
    throw new ToolError(409, "invalid_transition", "Appointment cannot be rescheduled");
  }
  if (initial.rescheduleCount >= settings.maxReschedules) {
    throw new ToolError(409, "max_reschedules", "Maximum reschedules reached");
  }
  const provider = new InternalAgendaProvider(db);
  const reservation = await provider.reserve({
    tenantId,
    patientId: input.patientId,
    conversationId: input.conversationId,
    siteId: input.siteId,
    professionalId: input.professionalId,
    payerId: input.payerId,
    appointmentTypeId: input.appointmentTypeId,
    scheduledAt: input.scheduledAt,
    idempotencyKey: `reschedule-hold:${input.idempotencyKey}`,
    actorId: "agent:SOFIA",
    holdDurationMinutes: settings.holdDurationMinutes
  });
  emitExpiredHoldAudits(reservation.expiredHolds, emitAudit);
  if (!reservation.idempotent) {
    emitAudit({
      tenantId,
      actorId: "agent:SOFIA",
      eventType: "appointment.hold.created",
      entityType: "appointment_hold",
      entityId: reservation.hold.id,
      metadata: { expiresAt: reservation.hold.expiresAt, origin: "sofia_wa", operation: "reschedule" }
    });
  }

  let outcome: { replacementId: string; idempotent: boolean };
  try {
    outcome = await db.transaction(async (tx) => {
      const current = await tx.query<{ status: string; rescheduleCount: number }>(
        `select status, reschedule_count as "rescheduleCount" from pulso_iris.appointments
         where tenant_id = $1 and id = $2 and patient_id = $3 for update`,
        [tenantId, input.appointmentId, input.patientId]
      );
      const row = current.rows[0];
      if (!row) throw new ToolError(404, "appointment_not_found", "Appointment not found");
      if (row.status === "rescheduled") {
        const previous = await tx.query<{ id: string }>(
          `select id from pulso_iris.appointments
           where tenant_id = $1 and previous_appointment_id = $2 and idempotency_key = $3`,
          [tenantId, input.appointmentId, input.idempotencyKey]
        );
        if (previous.rows[0]) return { replacementId: previous.rows[0].id, idempotent: true };
      }
      if (!isReschedulable(row.status)) {
        throw new ToolError(409, "invalid_transition", "Appointment cannot be rescheduled");
      }
      if (row.rescheduleCount >= settings.maxReschedules) {
        throw new ToolError(409, "max_reschedules", "Maximum reschedules reached");
      }
      const transactionalDb = asTransactionalDatabase(tx);
      const transactionalProvider = new InternalAgendaProvider(transactionalDb);
      const created = await transactionalProvider.verify({
        tenantId,
        holdId: reservation.hold.id,
        appointmentIdempotencyKey: input.idempotencyKey,
        origin: "sofia_wa",
        actorId: "agent:SOFIA",
        previousAppointmentId: input.appointmentId,
        rescheduleCount: row.rescheduleCount + 1
      });
      await transactionalProvider.reschedule({
        tenantId,
        appointmentId: input.appointmentId,
        replacementAppointmentId: created.appointment.id,
        actorId: "agent:SOFIA",
        reason: input.reason
      });
      return { replacementId: created.appointment.id, idempotent: created.idempotent };
    });
  } catch (error) {
    if (!reservation.idempotent) {
      await db.query(
        `update pulso_iris.appointment_holds
         set status = 'cancelled', updated_at = now()
         where tenant_id = $1 and id = $2 and status = 'active'`,
        [tenantId, reservation.hold.id]
      );
    }
    throw error;
  }

  if (!outcome.idempotent) {
    emitAudit({
      tenantId,
      actorId: "agent:SOFIA",
      eventType: "appointment.registered",
      entityType: "appointment",
      entityId: outcome.replacementId,
      metadata: { mode: "internal", origin: "sofia_wa", rescheduledFrom: input.appointmentId }
    });
    emitAudit({
      tenantId,
      actorId: "agent:SOFIA",
      eventType: "appointment.verified",
      entityType: "appointment",
      entityId: outcome.replacementId,
      metadata: { verificationMode: "internal", origin: "sofia_wa", rescheduledFrom: input.appointmentId }
    });
    emitAudit({
      tenantId,
      actorId: "agent:SOFIA",
      eventType: "appointment.rescheduled",
      entityType: "appointment",
      entityId: input.appointmentId,
      metadata: { replacementAppointmentId: outcome.replacementId, origin: "sofia_wa" }
    });
  }
  return {
    previousAppointment: await findAppointmentView(db, tenantId, input.appointmentId),
    appointment: await findAppointmentView(db, tenantId, outcome.replacementId),
    idempotent: outcome.idempotent
  };
}

async function createUrgentHandoff(
  db: Database,
  tenantId: string,
  input: z.infer<(typeof toolSchemas)["create_urgent_handoff"]>,
  emitAudit: AuditEmitter
) {
  const handoff = await db.transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `select id from pulso_iris.handoffs
       where tenant_id = $1 and conversation_id = $2
         and trigger_code = $3 and status in ('open', 'assigned', 'in_progress')
       order by created_at desc limit 1 for update`,
      [tenantId, input.conversationId, input.triggerCode]
    );
    if (existing.rows[0]) return { ...existing.rows[0], idempotent: true };
    const created = await tx.query<{ id: string }>(
      `insert into pulso_iris.handoffs
         (tenant_id, patient_id, conversation_id, trigger_code, priority, status, summary, sla_due_at, metadata)
       values ($1, $2, $3, $4, 'max', 'open',
               'Señal administrativa de urgencia o síntomas; requiere revisión humana.',
               now() + interval '5 minutes', '{"origin":"sofia_wa","clinicalDataStored":false}'::jsonb)
       returning id`,
      [tenantId, input.patientId, input.conversationId, input.triggerCode]
    );
    await tx.query(
      `update pulso_iris.conversations
       set status = 'handoff_required', primary_intent = 'urgency', updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, input.conversationId]
    );
    return { ...created.rows[0]!, idempotent: false };
  });
  if (!handoff.idempotent) {
    emitAudit({
      tenantId,
      actorId: "agent:SOFIA",
      eventType: "handoff.assigned",
      entityType: "handoff",
      entityId: handoff.id,
      metadata: { triggerCode: input.triggerCode, origin: "sofia_wa" }
    });
  }
  return handoff;
}

async function requireExplicitConfirmation(
  db: Database,
  tenantId: string,
  conversationId: string,
  messageId: string,
  expectedAction: ConfirmationAction
): Promise<void> {
  const result = await db.query<{ body: string }>(
    `select body from pulso_iris.messages
     where tenant_id = $1 and id = $2 and conversation_id = $3 and sender = 'patient'`,
    [tenantId, messageId, conversationId]
  );
  const body = result.rows[0]?.body;
  const confirmation = body ? parseExplicitConfirmation(body) : undefined;
  if (!confirmation) {
    throw new ToolError(409, "explicit_confirmation_required", "Explicit patient confirmation is required");
  }
  if (confirmation !== "generic" && confirmation !== expectedAction) {
    throw new ToolError(409, "confirmation_action_mismatch", "Patient confirmation belongs to another action");
  }
}

export function isExplicitConfirmation(body: string): boolean {
  return parseExplicitConfirmation(body) !== undefined;
}

type ConfirmationAction = "generic" | "book" | "cancel" | "reschedule";

function parseExplicitConfirmation(body: string): ConfirmationAction | undefined {
  const normalized = body
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const match = /^(?:si\s+)?confirmo(?:\s+(agendar|reservar|cancelar|reagendar|la\s+cita|el\s+cambio))?$/.exec(
    normalized
  );
  const suffix = match?.[1];
  if (!match) return undefined;
  if (!suffix) return "generic";
  if (suffix === "cancelar") return "cancel";
  if (suffix === "reagendar" || suffix === "el cambio") return "reschedule";
  return "book";
}

function emitExpiredHoldAudits(expiredHolds: Array<{ id: string; tenantId: string }>, emitAudit: AuditEmitter): void {
  for (const hold of expiredHolds) {
    emitAudit({
      tenantId: hold.tenantId,
      actorId: "system:hold-expiration",
      eventType: "appointment.hold.expired",
      entityType: "appointment_hold",
      entityId: hold.id,
      metadata: { origin: "sofia_wa" }
    });
  }
}

async function findReplacementByIdempotency(
  db: Pick<Database, "query">,
  tenantId: string,
  appointmentId: string,
  idempotency: string
): Promise<string | undefined> {
  const result = await db.query<{ id: string }>(
    `select id from pulso_iris.appointments
     where tenant_id = $1 and previous_appointment_id = $2 and idempotency_key = $3`,
    [tenantId, appointmentId, idempotency]
  );
  return result.rows[0]?.id;
}

function isReschedulable(status: string): boolean {
  return ["pending_external_confirmation", "verified", "confirmed", "deferred", "verification_failed"].includes(status);
}

async function assertHoldOwner(
  db: Database,
  tenantId: string,
  holdId: string,
  patientId: string,
  conversationId: string
) {
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1 from pulso_iris.appointment_holds
       where tenant_id = $1 and id = $2 and patient_id = $3 and conversation_id = $4
     ) as exists`,
    [tenantId, holdId, patientId, conversationId]
  );
  if (!result.rows[0]?.exists)
    throw new ToolError(422, "hold_owner_mismatch", "Appointment hold belongs to another case");
}

async function loadInternalSettings(db: Database, tenantId: string) {
  const result = await db.query<{
    mode: string;
    status: string;
    bookingHorizonDays: number;
    holdDurationMinutes: number;
    maxAlternatives: number;
    maxReschedules: number;
    timezone: string;
  }>(
    `select mode, status, booking_horizon_days as "bookingHorizonDays",
            hold_duration_minutes as "holdDurationMinutes", max_alternatives as "maxAlternatives",
             max_reschedules as "maxReschedules", timezone
     from pulso_iris.agenda_settings where tenant_id = $1`,
    [tenantId]
  );
  const settings = result.rows[0];
  if (!settings || settings.mode !== "internal" || settings.status !== "active") {
    throw new ToolError(409, "internal_agenda_not_active", "Internal agenda mode is not active");
  }
  return settings;
}

function appointmentViewSql(): string {
  return `select a.id, a.patient_id as "patientId", a.conversation_id as "conversationId",
                 a.status, a.origin, a.verification_mode as "verificationMode",
                 a.scheduled_at as "scheduledAt", a.duration_min as "durationMin",
                 to_char(a.scheduled_at at time zone
                   coalesce(nullif(a.metadata ->> 'slotTimeZone', ''), settings.timezone),
                   'YYYY-MM-DD') as "localDate",
                 to_char(a.scheduled_at at time zone
                   coalesce(nullif(a.metadata ->> 'slotTimeZone', ''), settings.timezone),
                   'HH24:MI') as "localTime",
                 coalesce(nullif(a.metadata ->> 'slotTimeZone', ''), settings.timezone) as "timeZone",
                 a.reschedule_count as "rescheduleCount", a.previous_appointment_id as "previousAppointmentId",
                 s.id as "siteId", s.name as "siteName",
                 p.id as "professionalId", p.name as "professionalName", p.is_pilot as "professionalIsPilot",
                 py.id as "payerId", py.name as "payerName",
                 t.id as "appointmentTypeId", t.name as "appointmentTypeName", t.preparation_text as "preparationText"
          from pulso_iris.appointments a
          join pulso_iris.agenda_settings settings on settings.tenant_id = a.tenant_id
          left join pulso_iris.sites s on s.tenant_id = a.tenant_id and s.id = a.site_id
          left join pulso_iris.professionals p on p.tenant_id = a.tenant_id and p.id = a.professional_id
          left join pulso_iris.payers py on py.tenant_id = a.tenant_id and py.id = a.payer_id
          left join pulso_iris.appointment_types t on t.tenant_id = a.tenant_id and t.id = a.appointment_type_id`;
}

async function findAppointmentView(db: Database, tenantId: string, appointmentId: string) {
  const result = await db.query(`${appointmentViewSql()} where a.tenant_id = $1 and a.id = $2`, [
    tenantId,
    appointmentId
  ]);
  if (!result.rows[0]) throw new ToolError(404, "appointment_not_found", "Appointment not found");
  return result.rows[0];
}

function readToolName(params: unknown): ToolName | undefined {
  const value =
    typeof params === "object" && params !== null && "toolName" in params
      ? (params as { toolName?: unknown }).toolName
      : undefined;
  return typeof value === "string" && value in toolSchemas ? (value as ToolName) : undefined;
}

function authorizeInternal(request: FastifyRequest, reply: FastifyReply, token: string | undefined): boolean {
  const authorization = request.headers.authorization;
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || !safeEqual(supplied, token)) {
    void reply.code(401).send(envelope({ error: "Internal authentication required" }, request.id));
    return false;
  }
  return true;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

type TransactionExecutor = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

function asTransactionalDatabase(transaction: TransactionExecutor): DatabaseClient {
  return {
    query: (text, params) => transaction.query(text, params),
    transaction: (work) => work(transaction),
    close: async () => undefined
  };
}

class ToolError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {}
  ) {
    super(message);
  }
}
