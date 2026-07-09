import {
  envelope,
  pulsoIrisAppointmentInputSchema,
  pulsoIrisAppointmentListSchema,
  pulsoIrisAppointmentPatchSchema,
  pulsoIrisCampaignInputSchema,
  pulsoIrisCampaignListSchema,
  pulsoIrisConversationInputSchema,
  pulsoIrisConversationListSchema,
  pulsoIrisConversationPatchSchema,
  pulsoIrisHandoffInputSchema,
  pulsoIrisHandoffListSchema,
  pulsoIrisHandoffPatchSchema,
  pulsoIrisMessageInputSchema,
  pulsoIrisPatientInputSchema,
  pulsoIrisRpaActionInputSchema,
  pulsoIrisRpaActionListSchema,
  pulsoIrisRpaActionPatchSchema,
  pulsoIrisWaitlistInputSchema
} from "@hyperion/contracts";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { parseBody, readUuidParam, requireTenantDb } from "./shared.js";

const CONVERSATION_COLUMNS = `
  id,
  tenant_id as "tenantId",
  patient_id as "patientId",
  site_id as "siteId",
  channel,
  direction,
  status,
  primary_intent as "primaryIntent",
  started_at as "startedAt",
  ended_at as "endedAt",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

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
  legacy_reference as "legacyReference",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const HANDOFF_COLUMNS = `
  id,
  tenant_id as "tenantId",
  patient_id as "patientId",
  conversation_id as "conversationId",
  trigger_code as "triggerCode",
  priority,
  status,
  summary,
  sla_due_at as "slaDueAt",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

const RPA_ACTION_COLUMNS = `
  id,
  tenant_id as "tenantId",
  appointment_id as "appointmentId",
  conversation_id as "conversationId",
  worker_id as "workerId",
  action_type as "actionType",
  status,
  priority,
  phase,
  duration_ms as "durationMs",
  executed_at as "executedAt",
  idempotency_key as "idempotencyKey",
  created_at as "createdAt",
  updated_at as "updatedAt"
`;

export const registerOperationsRoutes: RouteRegistrar = (app, context) => {
  const base = "/v1/tenants/:tenantId/pulso-iris";

  // ----- Pacientes administrativos (sinteticos / de prueba) -----

  app.post(`${base}/patients`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisPatientInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.administrative_patients
         (tenant_id, full_name, document_type, document_number_masked, phone, preferred_channel, status)
       values ($1, $2, $3, $4, $5, $6, coalesce($7, 'active'))
       returning id, tenant_id as "tenantId", full_name as "fullName", status`,
      [
        scope.tenantId,
        input.fullName ?? null,
        input.documentType ?? null,
        input.documentNumberMasked ?? null,
        input.phone ?? null,
        input.preferredChannel ?? null,
        input.status ?? null
      ]
    );
    return reply.code(201).send(envelope(result.rows[0], request.id));
  });

  // ----- Conversaciones y mensajes -----

  app.post(`${base}/conversations`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisConversationInputSchema, request, reply);
    if (!input) return;

    const metadata = input.firstResponseSeconds !== undefined ? { first_response_s: input.firstResponseSeconds } : {};

    const result = await scope.db.query(
      `insert into pulso_iris.conversations
         (tenant_id, patient_id, site_id, channel, direction, primary_intent, metadata)
       values ($1, $2, $3, $4, coalesce($5, 'inbound'), $6, $7::jsonb)
       returning ${CONVERSATION_COLUMNS}`,
      [
        scope.tenantId,
        input.patientId ?? null,
        input.siteId ?? null,
        input.channel,
        input.direction ?? null,
        input.primaryIntent ?? null,
        JSON.stringify(metadata)
      ]
    );
    return reply.code(201).send(envelope(pulsoIrisConversationListSchema.parse(result.rows)[0], request.id));
  });

  app.patch(`${base}/conversations/:conversationId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const conversationId = readUuidParam(request.params, "conversationId");
    if (!conversationId) {
      return reply.code(400).send(envelope({ error: "conversationId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisConversationPatchSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.conversations set
         status = coalesce($3, status),
         primary_intent = coalesce($4, primary_intent),
         site_id = coalesce($5, site_id),
         ended_at = case when $6::boolean is true then now() else ended_at end,
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning ${CONVERSATION_COLUMNS}`,
      [
        scope.tenantId,
        conversationId,
        input.status ?? null,
        input.primaryIntent ?? null,
        input.siteId ?? null,
        input.ended ?? null
      ]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Conversation not found" }, request.id));
    }
    return envelope(pulsoIrisConversationListSchema.parse(result.rows)[0], request.id);
  });

  app.post(`${base}/conversations/:conversationId/messages`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const conversationId = readUuidParam(request.params, "conversationId");
    if (!conversationId) {
      return reply.code(400).send(envelope({ error: "conversationId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisMessageInputSchema, request, reply);
    if (!input) return;

    const owner = await scope.db.query("select id from pulso_iris.conversations where tenant_id = $1 and id = $2", [
      scope.tenantId,
      conversationId
    ]);
    if (owner.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Conversation not found" }, request.id));
    }

    const result = await scope.db.query(
      `insert into pulso_iris.messages (conversation_id, sender, body)
       values ($1, $2, $3)
       returning id, conversation_id as "conversationId", sender, body, created_at as "createdAt"`,
      [conversationId, input.sender, input.body]
    );
    return reply.code(201).send(envelope(result.rows[0], request.id));
  });

  // ----- Citas administrativas -----

  app.post(`${base}/appointments`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisAppointmentInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.appointments
         (tenant_id, patient_id, conversation_id, site_id, professional_id, payer_id,
          appointment_type_id, appointment_type, origin, scheduled_at, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'sofia_wa'), $10, 'registered')
       returning ${APPOINTMENT_COLUMNS}`,
      [
        scope.tenantId,
        input.patientId ?? null,
        input.conversationId ?? null,
        input.siteId ?? null,
        input.professionalId ?? null,
        input.payerId ?? null,
        input.appointmentTypeId ?? null,
        input.appointmentType ?? null,
        input.origin ?? null,
        input.scheduledAt ?? null
      ]
    );
    const appointment = pulsoIrisAppointmentListSchema.parse(result.rows)[0];

    // Accion RPA simulada: el registro real contra el legado no existe todavia.
    if (appointment) {
      await scope.db.query(
        `insert into pulso_iris.rpa_actions
           (tenant_id, appointment_id, conversation_id, action_type, priority, idempotency_key, payload)
         values ($1, $2, $3, 'register_appointment', 20, $4, '{"simulated":true}'::jsonb)
         on conflict (tenant_id, idempotency_key) do nothing`,
        [scope.tenantId, appointment.id, input.conversationId ?? null, `register:${appointment.id}`]
      );
    }

    return reply.code(201).send(envelope(appointment, request.id));
  });

  app.patch(`${base}/appointments/:appointmentId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const appointmentId = readUuidParam(request.params, "appointmentId");
    if (!appointmentId) {
      return reply.code(400).send(envelope({ error: "appointmentId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisAppointmentPatchSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.appointments set
         status = coalesce($3, status),
         scheduled_at = coalesce($4, scheduled_at),
         site_id = coalesce($5, site_id),
         professional_id = coalesce($6, professional_id),
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning ${APPOINTMENT_COLUMNS}`,
      [
        scope.tenantId,
        appointmentId,
        input.status ?? null,
        input.scheduledAt ?? null,
        input.siteId ?? null,
        input.professionalId ?? null
      ]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Appointment not found" }, request.id));
    }

    // Cambios de estado relevantes generan su accion RPA simulada idempotente.
    const statusToAction: Record<string, string> = {
      cancelled: "cancel",
      rescheduled: "reschedule",
      confirmed: "confirm"
    };
    const actionType = input.status ? statusToAction[input.status] : undefined;
    if (actionType) {
      await scope.db.query(
        `insert into pulso_iris.rpa_actions
           (tenant_id, appointment_id, action_type, priority, idempotency_key, payload)
         values ($1, $2, $3, 30, $4, '{"simulated":true}'::jsonb)
         on conflict (tenant_id, idempotency_key) do nothing`,
        [scope.tenantId, appointmentId, actionType, `${actionType}:${appointmentId}:${input.scheduledAt ?? "now"}`]
      );
    }

    return envelope(pulsoIrisAppointmentListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Handoffs -----

  app.post(`${base}/handoffs`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisHandoffInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.handoffs
         (tenant_id, conversation_id, patient_id, trigger_code, priority, summary, sla_due_at)
       values ($1, $2, $3, $4, coalesce($5, 'medium'), $6, $7)
       returning ${HANDOFF_COLUMNS}`,
      [
        scope.tenantId,
        input.conversationId ?? null,
        input.patientId ?? null,
        input.triggerCode,
        input.priority ?? null,
        input.summary ?? null,
        input.slaDueAt ?? null
      ]
    );

    if (input.conversationId) {
      await scope.db.query(
        `update pulso_iris.conversations set status = 'handoff_required', updated_at = now()
         where tenant_id = $1 and id = $2 and status = 'active'`,
        [scope.tenantId, input.conversationId]
      );
    }

    return reply.code(201).send(envelope(pulsoIrisHandoffListSchema.parse(result.rows)[0], request.id));
  });

  app.patch(`${base}/handoffs/:handoffId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const handoffId = readUuidParam(request.params, "handoffId");
    if (!handoffId) {
      return reply.code(400).send(envelope({ error: "handoffId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisHandoffPatchSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.handoffs set
         status = coalesce($3, status),
         priority = coalesce($4, priority),
         summary = coalesce($5, summary),
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning ${HANDOFF_COLUMNS}`,
      [scope.tenantId, handoffId, input.status ?? null, input.priority ?? null, input.summary ?? null]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Handoff not found" }, request.id));
    }
    return envelope(pulsoIrisHandoffListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Acciones RPA simuladas -----

  app.post(`${base}/rpa/actions`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisRpaActionInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.rpa_actions
         (tenant_id, appointment_id, conversation_id, action_type, priority, idempotency_key, payload)
       values ($1, $2, $3, $4, coalesce($5, 50), $6, '{"simulated":true}'::jsonb)
       on conflict (tenant_id, idempotency_key) do update set updated_at = now()
       returning ${RPA_ACTION_COLUMNS}`,
      [
        scope.tenantId,
        input.appointmentId ?? null,
        input.conversationId ?? null,
        input.actionType,
        input.priority ?? null,
        input.idempotencyKey
      ]
    );
    return reply.code(201).send(envelope(pulsoIrisRpaActionListSchema.parse(result.rows)[0], request.id));
  });

  app.patch(`${base}/rpa/actions/:actionId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const actionId = readUuidParam(request.params, "actionId");
    if (!actionId) {
      return reply.code(400).send(envelope({ error: "actionId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisRpaActionPatchSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.rpa_actions set
         status = coalesce($3, status),
         worker_id = coalesce($4, worker_id),
         phase = coalesce($5, phase),
         duration_ms = coalesce($6, duration_ms),
         executed_at = case when $3 in ('succeeded', 'verification_failed', 'failed') then now() else executed_at end,
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning ${RPA_ACTION_COLUMNS}`,
      [
        scope.tenantId,
        actionId,
        input.status ?? null,
        input.workerId ?? null,
        input.phase ?? null,
        input.durationMs ?? null
      ]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "RPA action not found" }, request.id));
    }
    return envelope(pulsoIrisRpaActionListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Campanas -----

  app.post(`${base}/campaigns`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisCampaignInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.campaigns
         (tenant_id, name, campaign_type, status, channels, segment, cadence, budget_cop, stats)
       values ($1, $2, $3, coalesce($4, 'draft'), $5::jsonb, $6::jsonb, $7::jsonb, $8, $9::jsonb)
       returning id, tenant_id as "tenantId", name, campaign_type as "campaignType", status, channels, segment,
                 cadence, budget_cop as "budgetCop", stats, created_at as "createdAt", updated_at as "updatedAt"`,
      [
        scope.tenantId,
        input.name,
        input.campaignType,
        input.status ?? null,
        JSON.stringify(input.channels ?? []),
        JSON.stringify(input.segment ?? {}),
        JSON.stringify(input.cadence ?? {}),
        input.budgetCop ?? null,
        JSON.stringify(input.stats ?? {})
      ]
    );
    return reply.code(201).send(envelope(pulsoIrisCampaignListSchema.parse(result.rows)[0], request.id));
  });

  app.patch(`${base}/campaigns/:campaignId`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const campaignId = readUuidParam(request.params, "campaignId");
    if (!campaignId) {
      return reply.code(400).send(envelope({ error: "campaignId must be a UUID" }, request.id));
    }
    const input = parseBody(pulsoIrisCampaignInputSchema.partial(), request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `update pulso_iris.campaigns set
         name = coalesce($3, name),
         campaign_type = coalesce($4, campaign_type),
         status = coalesce($5, status),
         channels = coalesce($6::jsonb, channels),
         segment = coalesce($7::jsonb, segment),
         cadence = coalesce($8::jsonb, cadence),
         budget_cop = coalesce($9, budget_cop),
         stats = coalesce($10::jsonb, stats),
         updated_at = now()
       where tenant_id = $1 and id = $2
       returning id, tenant_id as "tenantId", name, campaign_type as "campaignType", status, channels, segment,
                 cadence, budget_cop as "budgetCop", stats, created_at as "createdAt", updated_at as "updatedAt"`,
      [
        scope.tenantId,
        campaignId,
        input.name ?? null,
        input.campaignType ?? null,
        input.status ?? null,
        input.channels ? JSON.stringify(input.channels) : null,
        input.segment ? JSON.stringify(input.segment) : null,
        input.cadence ? JSON.stringify(input.cadence) : null,
        input.budgetCop ?? null,
        input.stats ? JSON.stringify(input.stats) : null
      ]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Campaign not found" }, request.id));
    }
    return envelope(pulsoIrisCampaignListSchema.parse(result.rows)[0], request.id);
  });

  // ----- Lista de espera -----

  app.post(`${base}/waitlist`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const input = parseBody(pulsoIrisWaitlistInputSchema, request, reply);
    if (!input) return;

    const result = await scope.db.query(
      `insert into pulso_iris.waitlist
         (tenant_id, patient_id, appointment_type_id, sites, time_slots, clinical_priority, deadline, status)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, coalesce($6, 50), $7, coalesce($8, 'active'))
       returning id, tenant_id as "tenantId", patient_id as "patientId", status,
                 clinical_priority as "clinicalPriority", created_at as "createdAt"`,
      [
        scope.tenantId,
        input.patientId ?? null,
        input.appointmentTypeId ?? null,
        JSON.stringify(input.sites ?? []),
        JSON.stringify(input.timeSlots ?? []),
        input.clinicalPriority ?? null,
        input.deadline ?? null,
        input.status ?? null
      ]
    );
    return reply.code(201).send(envelope(result.rows[0], request.id));
  });
};
