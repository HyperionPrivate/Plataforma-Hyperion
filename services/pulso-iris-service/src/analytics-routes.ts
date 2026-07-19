import { envelope } from "@hyperion/platform-contracts";
import { pulsoIrisWorkerListSchema } from "@hyperion/pulso-contracts";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { readUuidParam, requireTenantDb } from "./shared.js";

// Parametros de referencia transitorios. Deben contrastarse y moverse a
// configuracion por tenant antes de usarse como evidencia operacional.
const BASELINE_COST_PER_INTERACTION_COP = 3500;
const PLATFORM_COST_PER_INTERACTION_COP = 1899;
const BASELINE_NO_SHOW_PCT = 18;
const MINUTES_SAVED_PER_INTERACTION = 4.5;

export const registerAnalyticsRoutes: RouteRegistrar = (app, context) => {
  const base = "/v1/tenants/:tenantId/pulso-iris";

  // ----- Dashboard de operacion en vivo -----

  app.get(`${base}/dashboard/live`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const [kpis, hourly, resolution, handoffQueue, siteActivity, rpaHealth] = await Promise.all([
      scope.db.query(
        `select
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and status in ('active', 'handoff_required')) as "interactionsActive",
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and channel = 'whatsapp' and timezone('America/Bogota', started_at)::date = timezone('America/Bogota', now())::date) as "whatsappToday",
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and channel = 'voice' and timezone('America/Bogota', started_at)::date = timezone('America/Bogota', now())::date) as "voiceToday",
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and channel = 'whatsapp' and timezone('America/Bogota', started_at)::date = timezone('America/Bogota', now())::date - 1) as "whatsappYesterday",
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and channel = 'voice' and timezone('America/Bogota', started_at)::date = timezone('America/Bogota', now())::date - 1) as "voiceYesterday",
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and status = 'resolved' and timezone('America/Bogota', started_at)::date = timezone('America/Bogota', now())::date) as "resolvedToday",
           (select count(*)::int from pulso_iris.conversations c where c.tenant_id = $1 and timezone('America/Bogota', c.started_at)::date = timezone('America/Bogota', now())::date
              and exists (select 1 from pulso_iris.handoffs h where h.tenant_id = $1 and h.conversation_id = c.id)) as "handoffToday",
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and status = 'closed' and timezone('America/Bogota', started_at)::date = timezone('America/Bogota', now())::date) as "abandonedToday",
           (select count(*)::int from pulso_iris.appointments where tenant_id = $1 and timezone('America/Bogota', created_at)::date = timezone('America/Bogota', now())::date and origin in ('sofia_voz', 'sofia_wa')) as "appointmentsTodayBySofia",
           (select count(*)::int from pulso_iris.handoffs where tenant_id = $1 and status in ('open', 'assigned', 'in_progress')) as "handoffsOpen"`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select extract(hour from timezone('America/Bogota', started_at))::int as hour,
                count(*)::int as total,
                count(*) filter (where channel = 'voice')::int as voice,
                count(*) filter (where channel = 'whatsapp')::int as whatsapp
         from pulso_iris.conversations
         where tenant_id = $1 and timezone('America/Bogota', started_at)::date = timezone('America/Bogota', now())::date
         group by 1 order by 1`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select
           count(*) filter (where status = 'resolved')::int as "resolvedByIa",
           count(*) filter (where exists (select 1 from pulso_iris.handoffs h where h.tenant_id = $1 and h.conversation_id = c.id))::int as transferred,
           count(*) filter (where status = 'closed')::int as abandoned
         from pulso_iris.conversations c
         where tenant_id = $1 and timezone('America/Bogota', started_at)::date = timezone('America/Bogota', now())::date`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select h.id, h.trigger_code as "triggerCode", h.priority, h.status, h.summary,
                h.created_at as "createdAt",
                extract(epoch from (now() - h.created_at))::int as "waitingSeconds",
                p.full_name as "patientName",
                p.status as "patientStatus"
         from pulso_iris.handoffs h
         left join pulso_iris.administrative_patients p on p.id = h.patient_id
         where h.tenant_id = $1 and h.status in ('open', 'assigned', 'in_progress')
         order by case h.priority when 'max' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, h.created_at
         limit 8`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select s.id as "siteId", s.name as "siteName",
                count(c.id)::int as interactions,
                (select count(*)::int from pulso_iris.appointments a
                  where a.tenant_id = $1 and a.site_id = s.id and timezone('America/Bogota', a.created_at)::date = timezone('America/Bogota', now())::date) as appointments,
                round(avg((c.metadata->>'first_response_s')::numeric), 1) as "avgResponseSeconds",
                round(100.0 * count(c.id) filter (where c.status = 'resolved') / nullif(count(c.id), 0), 0)::int as "absorptionPct",
                round(100.0 * count(c.id) filter (where exists (select 1 from pulso_iris.handoffs h where h.conversation_id = c.id)) / nullif(count(c.id), 0), 0)::int as "handoffPct"
         from pulso_iris.sites s
         left join pulso_iris.conversations c
           on c.site_id = s.id and c.tenant_id = $1 and timezone('America/Bogota', c.started_at)::date = timezone('America/Bogota', now())::date
         where s.tenant_id = $1
         group by s.id, s.name
         order by interactions desc nulls last`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select
           (select count(*)::int from pulso_iris.rpa_workers where tenant_id = $1 and status = 'active') as "workersActive",
           (select count(*)::int from pulso_iris.rpa_workers where tenant_id = $1) as "workersTotal",
           (select count(*)::int from pulso_iris.rpa_actions where tenant_id = $1 and status = 'queued') as "queueDepth",
           (select count(*)::int from pulso_iris.rpa_actions where tenant_id = $1 and status = 'deferred') as deferred`,
        [scope.tenantId]
      )
    ]);

    const k = kpis.rows[0] as Record<string, number>;
    const totalToday = (k.whatsappToday ?? 0) + (k.voiceToday ?? 0);
    const closedToday = (k.resolvedToday ?? 0) + (k.handoffToday ?? 0) + (k.abandonedToday ?? 0);

    return envelope(
      {
        kpis: {
          interactionsActive: k.interactionsActive ?? 0,
          whatsappToday: k.whatsappToday ?? 0,
          voiceToday: k.voiceToday ?? 0,
          whatsappYesterday: k.whatsappYesterday ?? 0,
          voiceYesterday: k.voiceYesterday ?? 0,
          totalToday,
          absorptionPct: closedToday > 0 ? Math.round((100 * (k.resolvedToday ?? 0)) / closedToday) : null,
          handoffPct: closedToday > 0 ? Math.round((100 * (k.handoffToday ?? 0)) / closedToday) : null,
          appointmentsTodayBySofia: k.appointmentsTodayBySofia ?? 0,
          handoffsOpen: k.handoffsOpen ?? 0
        },
        interactionsByHour: hourly.rows,
        resolution: resolution.rows[0],
        handoffQueue: handoffQueue.rows,
        siteActivity: siteActivity.rows,
        rpaHealth: rpaHealth.rows[0]
      },
      request.id
    );
  });

  // ----- Agenda semanal -----

  app.get(`${base}/agenda/week`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const query = request.query as { siteId?: string; start?: string };
    const start = query.start && /^\d{4}-\d{2}-\d{2}$/.test(query.start) ? query.start : null;
    const siteId = query.siteId && readUuidParam({ value: query.siteId }, "value") ? query.siteId : null;

    const [appointments, summary, waitlist] = await Promise.all([
      scope.db.query(
        `select a.id, a.scheduled_at as "scheduledAt", a.status, a.origin,
                a.professional_id as "professionalId", a.site_id as "siteId",
                pr.name as "professionalName", pr.subspecialty, pr.is_pilot as "professionalIsPilot",
                t.name as "appointmentTypeName", t.category as "appointmentCategory",
                coalesce(a.appointment_type, t.name) as "appointmentTypeLabel",
                p.full_name as "patientName"
         from pulso_iris.appointments a
         left join pulso_iris.professionals pr on pr.tenant_id = a.tenant_id and pr.id = a.professional_id
         left join pulso_iris.appointment_types t on t.tenant_id = a.tenant_id and t.id = a.appointment_type_id
         left join pulso_iris.administrative_patients p on p.tenant_id = a.tenant_id and p.id = a.patient_id
         where a.tenant_id = $1
           and a.scheduled_at >= coalesce($2::date, date_trunc('week', current_date))
           and a.scheduled_at < coalesce($2::date, date_trunc('week', current_date)) + interval '7 days'
           and ($3::uuid is null or a.site_id = $3::uuid)
         order by a.scheduled_at`,
        [scope.tenantId, start, siteId]
      ),
      scope.db.query(
        `select count(*)::int as total,
                count(*) filter (where status = 'confirmed')::int as confirmed,
                count(*) filter (where origin in ('sofia_voz', 'sofia_wa'))::int as "bySofia",
                count(*) filter (where status = 'no_show')::int as "noShow",
                count(*) filter (where timezone('America/Bogota', scheduled_at)::date = timezone('America/Bogota', now())::date)::int as today,
                count(*) filter (where origin in ('sofia_voz', 'sofia_wa') and timezone('America/Bogota', scheduled_at)::date = timezone('America/Bogota', now())::date)::int as "bySofiaToday"
         from pulso_iris.appointments
         where tenant_id = $1
           and scheduled_at >= coalesce($2::date, date_trunc('week', current_date))
           and scheduled_at < coalesce($2::date, date_trunc('week', current_date)) + interval '7 days'
           and ($3::uuid is null or site_id = $3::uuid)`,
        [scope.tenantId, start, siteId]
      ),
      scope.db.query(
        `select w.id, w.clinical_priority as "clinicalPriority", w.status,
                w.created_at as "createdAt",
                p.full_name as "patientName",
                t.name as "appointmentTypeName"
         from pulso_iris.waitlist w
         left join pulso_iris.administrative_patients p on p.id = w.patient_id
         left join pulso_iris.appointment_types t on t.id = w.appointment_type_id
         where w.tenant_id = $1 and w.status in ('active', 'offered')
         order by w.clinical_priority, w.created_at
         limit 10`,
        [scope.tenantId]
      )
    ]);

    return envelope(
      {
        appointments: appointments.rows,
        summary: summary.rows[0],
        waitlist: waitlist.rows
      },
      request.id
    );
  });

  // ----- Timeline de conversacion con ficha -----

  app.get(`${base}/conversations/:conversationId/timeline`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const conversationId = readUuidParam(request.params, "conversationId");
    if (!conversationId) {
      return reply.code(400).send(envelope({ error: "conversationId must be a UUID" }, request.id));
    }

    const conversation = await scope.db.query(
      `select c.id, c.channel, c.direction, c.status, c.primary_intent as "primaryIntent",
              c.started_at as "startedAt", c.ended_at as "endedAt", c.patient_id as "patientId",
              c.metadata->>'provider' as provider,
              case when p.full_name is null then 'pending_name' else 'identified' end as "identityStatus",
              c.metadata->>'sofiaStatus' as "sofiaStatus",
              c.metadata->>'lastSofiaActivityAt' as "lastSofiaActivityAt",
              c.site_id as "siteId", s.name as "siteName"
       from pulso_iris.conversations c
       left join pulso_iris.sites s on s.tenant_id = c.tenant_id and s.id = c.site_id
       left join pulso_iris.administrative_patients p on p.tenant_id = c.tenant_id and p.id = c.patient_id
       where c.tenant_id = $1 and c.id = $2`,
      [scope.tenantId, conversationId]
    );

    if (conversation.rows.length === 0) {
      return reply.code(404).send(envelope({ error: "Conversation not found" }, request.id));
    }

    const row = conversation.rows[0] as { patientId: string | null };

    const [messages, rpaActions, handoffs, patient, patientAppointments] = await Promise.all([
      scope.db.query(
        `select id, sender, body, provider, provider_message_id as "providerMessageId",
                delivery_status as "deliveryStatus", delivered_at as "deliveredAt", created_at as "createdAt"
         from pulso_iris.messages where tenant_id = $1 and conversation_id = $2 order by created_at limit 200`,
        [scope.tenantId, conversationId]
      ),
      scope.db.query(
        `select id, action_type as "actionType", status, phase, duration_ms as "durationMs",
                created_at as "createdAt"
         from pulso_iris.rpa_actions where tenant_id = $1 and conversation_id = $2 order by created_at`,
        [scope.tenantId, conversationId]
      ),
      scope.db.query(
        `select id, trigger_code as "triggerCode", priority, status, created_at as "createdAt"
         from pulso_iris.handoffs where tenant_id = $1 and conversation_id = $2 order by created_at`,
        [scope.tenantId, conversationId]
      ),
      row.patientId
        ? scope.db.query(
            `select id, full_name as "fullName", document_type as "documentType",
                    document_number_masked as "documentNumberMasked", phone_masked as "phoneMasked",
                    preferred_channel as "preferredChannel", status
             from pulso_iris.administrative_patients where tenant_id = $1 and id = $2`,
            [scope.tenantId, row.patientId]
          )
        : Promise.resolve({ rows: [] }),
      row.patientId
        ? scope.db.query(
            `select a.id, a.scheduled_at as "scheduledAt", a.status,
                    coalesce(a.appointment_type, t.name) as "appointmentTypeLabel",
                    pr.name as "professionalName", s.name as "siteName"
             from pulso_iris.appointments a
             left join pulso_iris.appointment_types t on t.id = a.appointment_type_id
             left join pulso_iris.professionals pr on pr.id = a.professional_id
             left join pulso_iris.sites s on s.id = a.site_id
             where a.tenant_id = $1 and a.patient_id = $2
             order by a.scheduled_at desc nulls last limit 10`,
            [scope.tenantId, row.patientId]
          )
        : Promise.resolve({ rows: [] })
    ]);

    return envelope(
      {
        conversation: conversation.rows[0],
        messages: messages.rows,
        rpaActions: rpaActions.rows,
        handoffs: handoffs.rows,
        patient: patient.rows[0] ?? null,
        patientAppointments: patientAppointments.rows
      },
      request.id
    );
  });

  // ----- Bandeja de conversaciones enriquecida -----

  app.get(`${base}/conversations/inbox`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select c.id, c.channel, c.status, c.primary_intent as "primaryIntent",
              c.started_at as "startedAt", c.updated_at as "updatedAt",
              p.full_name as "patientName",
              c.metadata->>'provider' as provider,
              case when p.full_name is null then 'pending_name' else 'identified' end as "identityStatus",
              c.metadata->>'sofiaStatus' as "sofiaStatus",
              c.metadata->>'lastSofiaActivityAt' as "lastSofiaActivityAt",
              py.name as "payerName",
              (select body from pulso_iris.messages m where m.conversation_id = c.id order by m.created_at desc limit 1) as "lastMessage",
              exists (select 1 from pulso_iris.handoffs h where h.conversation_id = c.id and h.status in ('open','assigned','in_progress')) as "hasOpenHandoff"
       from pulso_iris.conversations c
       left join pulso_iris.administrative_patients p on p.tenant_id = c.tenant_id and p.id = c.patient_id
       left join lateral (
         select appointment.payer_id
         from pulso_iris.appointments appointment
         where appointment.tenant_id = c.tenant_id and appointment.conversation_id = c.id
         order by appointment.created_at desc, appointment.id desc
         limit 1
       ) a on true
       left join pulso_iris.payers py on py.tenant_id = c.tenant_id and py.id = a.payer_id
       where c.tenant_id = $1
       order by c.updated_at desc
       limit 60`,
      [scope.tenantId]
    );

    return envelope(result.rows, request.id);
  });

  // ----- Estado RPA -----

  app.get(`${base}/rpa/status`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const [workers, kpis, queue, telemetry, events] = await Promise.all([
      scope.db.query(
        `select id, tenant_id as "tenantId", name, vps_host as "vpsHost", status,
                session_started_at as "sessionStartedAt", last_keepalive_at as "lastKeepaliveAt",
                current_action as "currentAction", cpu_pct as "cpuPct",
                created_at as "createdAt", updated_at as "updatedAt"
         from pulso_iris.rpa_workers where tenant_id = $1 order by name`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select
           count(*) filter (where timezone('America/Bogota', created_at)::date = timezone('America/Bogota', now())::date)::int as "actionsToday",
           count(*) filter (where status = 'queued')::int as "queued",
           count(*) filter (where status = 'deferred')::int as "deferred",
           round(100.0 * count(*) filter (where status = 'succeeded' and timezone('America/Bogota', created_at)::date = timezone('America/Bogota', now())::date)
             / nullif(count(*) filter (where status in ('succeeded', 'failed', 'verification_failed') and timezone('America/Bogota', created_at)::date = timezone('America/Bogota', now())::date), 0), 1)::float as "successPctToday",
           round(avg(duration_ms) filter (where action_type = 'check_availability' and duration_ms is not null and timezone('America/Bogota', created_at)::date = timezone('America/Bogota', now())::date) / 1000.0, 1)::float as "avgConsultSeconds",
           round(((percentile_cont(0.95) within group (order by duration_ms) filter (where action_type = 'register_appointment' and duration_ms is not null and timezone('America/Bogota', created_at)::date = timezone('America/Bogota', now())::date))::numeric) / 1000.0, 1)::float as "p95RegisterSeconds"
         from pulso_iris.rpa_actions
         where tenant_id = $1`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select id, action_type as "actionType", status, priority, phase,
                duration_ms as "durationMs", conversation_id as "conversationId",
                created_at as "createdAt"
         from pulso_iris.rpa_actions
         where tenant_id = $1
         order by case status when 'running' then 0 when 'queued' then 1 else 2 end, created_at desc
         limit 20`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select date_trunc('hour', created_at) as hour,
                round(avg(duration_ms) / 1000.0, 1)::float as "avgSeconds",
                count(*)::int as actions
         from pulso_iris.rpa_actions
         where tenant_id = $1 and created_at > now() - interval '12 hours' and duration_ms is not null
         group by 1 order by 1`,
        [scope.tenantId]
      ),
      scope.db.query(
        `select e.id, e.level, e.message, e.created_at as "createdAt", w.name as "workerName"
         from pulso_iris.rpa_events e
         left join pulso_iris.rpa_workers w on w.id = e.worker_id
         where e.tenant_id = $1
         order by e.created_at desc limit 20`,
        [scope.tenantId]
      )
    ]);

    return envelope(
      {
        workers: pulsoIrisWorkerListSchema.parse(workers.rows),
        kpis: kpis.rows[0],
        queue: queue.rows,
        telemetry: telemetry.rows,
        events: events.rows
      },
      request.id
    );
  });

  // ----- Campanas -----

  app.get(`${base}/campaigns`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const result = await scope.db.query(
      `select id, tenant_id as "tenantId", name, campaign_type as "campaignType", status, channels,
              segment, cadence, budget_cop as "budgetCop", stats,
              created_at as "createdAt", updated_at as "updatedAt"
       from pulso_iris.campaigns
       where tenant_id = $1
       order by case status when 'active' then 0 when 'paused' then 1 when 'draft' then 2 else 3 end, updated_at desc`,
      [scope.tenantId]
    );

    return envelope(result.rows, request.id);
  });

  // ----- BI mensual -----

  app.get(`${base}/bi/monthly`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const query = request.query as { month?: string };
    const month = query.month && /^\d{4}-\d{2}$/.test(query.month) ? `${query.month}-01` : null;

    const [totals, weekly, funnel, payerDistribution, noShowWeekly] = await Promise.all([
      scope.db.query(
        `select
           count(*)::int as interactions,
           count(*) filter (where status = 'resolved')::int as resolved,
           count(*) filter (where exists (select 1 from pulso_iris.handoffs h where h.conversation_id = c.id))::int as transferred,
           round(avg((c.metadata->>'first_response_s')::numeric), 1)::float as "avgResponseSeconds"
         from pulso_iris.conversations c
         where tenant_id = $1
           and started_at >= coalesce($2::date, date_trunc('month', current_date))
           and started_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month'`,
        [scope.tenantId, month]
      ),
      scope.db.query(
        `select to_char(date_trunc('week', created_at), 'YYYY-MM-DD') as week,
                count(*) filter (where origin = 'sofia_wa')::int as whatsapp,
                count(*) filter (where origin = 'sofia_voz')::int as voice,
                count(*)::int as total
         from pulso_iris.appointments
         where tenant_id = $1
           and created_at >= coalesce($2::date, date_trunc('month', current_date))
           and created_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month'
         group by 1 order by 1`,
        [scope.tenantId, month]
      ),
      scope.db.query(
        `select
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1
             and started_at >= coalesce($2::date, date_trunc('month', current_date))
             and started_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month') as interactions,
           (select count(*)::int from pulso_iris.conversations where tenant_id = $1
             and primary_intent in ('agendar_cita', 'reagendar', 'confirmar_asistencia')
             and started_at >= coalesce($2::date, date_trunc('month', current_date))
             and started_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month') as "appointmentIntent",
           (select count(*)::int from pulso_iris.appointments where tenant_id = $1
             and created_at >= coalesce($2::date, date_trunc('month', current_date))
             and created_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month') as "availabilityChecked",
           (select count(*)::int from pulso_iris.appointments where tenant_id = $1 and status <> 'cancelled'
             and created_at >= coalesce($2::date, date_trunc('month', current_date))
             and created_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month') as registered,
           (select count(*)::int from pulso_iris.appointments where tenant_id = $1 and status in ('verified', 'confirmed')
             and created_at >= coalesce($2::date, date_trunc('month', current_date))
             and created_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month') as verified,
           (select count(*)::int from pulso_iris.appointments where tenant_id = $1 and status = 'confirmed'
             and created_at >= coalesce($2::date, date_trunc('month', current_date))
             and created_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month') as confirmed`,
        [scope.tenantId, month]
      ),
      scope.db.query(
        `select coalesce(py.payer_group, 'other') as "payerGroup", count(*)::int as total
         from pulso_iris.appointments a
         left join pulso_iris.payers py on py.id = a.payer_id
         where a.tenant_id = $1
           and a.created_at >= coalesce($2::date, date_trunc('month', current_date))
           and a.created_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month'
         group by 1 order by total desc`,
        [scope.tenantId, month]
      ),
      scope.db.query(
        `select to_char(date_trunc('week', scheduled_at), 'YYYY-MM-DD') as week,
                round(100.0 * count(*) filter (where status = 'no_show') / nullif(count(*) filter (where status in ('no_show', 'confirmed', 'verified', 'registered')), 0), 1)::float as "noShowPct"
         from pulso_iris.appointments
         where tenant_id = $1 and scheduled_at is not null
           and scheduled_at >= coalesce($2::date, date_trunc('month', current_date))
           and scheduled_at < coalesce($2::date, date_trunc('month', current_date)) + interval '1 month'
         group by 1 order by 1`,
        [scope.tenantId, month]
      )
    ]);

    const t = totals.rows[0] as { interactions: number; resolved: number; transferred: number };
    const absorbed = t.resolved ?? 0;
    const hoursFreed = Math.round((absorbed * MINUTES_SAVED_PER_INTERACTION) / 60);
    const savingsCop = absorbed * (BASELINE_COST_PER_INTERACTION_COP - PLATFORM_COST_PER_INTERACTION_COP);

    return envelope(
      {
        totals: {
          ...t,
          absorptionPct: t.interactions > 0 ? Math.round((100 * absorbed) / t.interactions) : null
        },
        weeklyAppointments: weekly.rows,
        funnel: funnel.rows[0],
        payerDistribution: payerDistribution.rows,
        noShowWeekly: noShowWeekly.rows,
        baseline: {
          noShowPct: BASELINE_NO_SHOW_PCT,
          costPerInteractionCop: BASELINE_COST_PER_INTERACTION_COP
        },
        savings: {
          interactionsAbsorbed: absorbed,
          hoursFreed,
          savingsCop,
          platformCostPerInteractionCop: PLATFORM_COST_PER_INTERACTION_COP
        }
      },
      request.id
    );
  });
};
