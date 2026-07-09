import {
  envelope,
  pulsoIrisAgentCode,
  pulsoIrisAppointmentListSchema,
  pulsoIrisCatalog,
  pulsoIrisConversationListSchema,
  pulsoIrisHandoffListSchema,
  pulsoIrisOperationalKpisSchema,
  pulsoIrisProductCode,
  pulsoIrisRpaActionListSchema
} from "@hyperion/contracts";
import type { RouteRegistrar, ServiceContext } from "@hyperion/service-runtime";
import { registerAnalyticsRoutes } from "./analytics-routes.js";
import { registerAppointmentRoutes } from "./appointment-routes.js";
import { startAppointmentHoldExpiration } from "./appointment-hold-expiration.js";
import { startAppointmentVerificationSimulator } from "./appointment-verification-simulator.js";
import { createAuditClient } from "./audit-client.js";
import { registerAvailabilityRoutes } from "./availability-routes.js";
import { registerConfigRoutes } from "./config-routes.js";
import { registerOperationsRoutes } from "./operations-routes.js";
import { registerSofiaToolRoutes } from "./sofia-tools-routes.js";
import { readTenantId } from "./shared.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  if (context.db) {
    await verifyPulsoIrisSchema(context);
  }

  const emitAudit = createAuditClient({
    auditServiceUrl: process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086",
    internalServiceToken: context.config.internalServiceToken,
    logger: context.logger
  });

  await registerConfigRoutes(app, context, emitAudit);
  await registerAppointmentRoutes(app, context, emitAudit);
  await registerOperationsRoutes(app, context, emitAudit);
  await registerAvailabilityRoutes(app, context);
  await registerAnalyticsRoutes(app, context);
  await registerSofiaToolRoutes(app, context, emitAudit);

  const stopSimulator = startAppointmentVerificationSimulator(context, emitAudit);
  const stopHoldExpiration = startAppointmentHoldExpiration(context, emitAudit);
  app.addHook("onClose", async () => {
    stopSimulator();
    stopHoldExpiration();
  });

  app.get("/v1/pulso-iris/health", async (request) => {
    return envelope(
      {
        service: "pulso-iris-service",
        product: pulsoIrisProductCode,
        agent: pulsoIrisAgentCode,
        status: "ok"
      },
      request.id
    );
  });

  app.get("/v1/pulso-iris/catalog", async (request) => {
    return envelope(pulsoIrisCatalog, request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/overview", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(
      `
      select
        (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and status = 'active') as "conversationsActive",
        (select count(*)::int from pulso_iris.conversations where tenant_id = $1 and status in ('resolved', 'closed') and date(updated_at) = current_date) as "conversationsResolvedToday",
        (select count(*)::int from pulso_iris.appointments where tenant_id = $1 and status in ('verified', 'confirmed') and date(updated_at) = current_date) as "appointmentsVerifiedToday",
        (select count(*)::int from pulso_iris.handoffs where tenant_id = $1 and status in ('open', 'assigned', 'in_progress')) as "handoffsOpen",
        (select count(*)::int from pulso_iris.rpa_actions where tenant_id = $1 and status = 'queued') as "rpaActionsQueued",
        (select count(*)::int from pulso_iris.rpa_actions where tenant_id = $1 and status = 'deferred') as "rpaActionsDeferred"
    `,
      [tenantId]
    );

    const kpis = pulsoIrisOperationalKpisSchema.parse(result.rows[0]);

    return envelope(
      {
        tenantId,
        product: pulsoIrisCatalog.product,
        agent: pulsoIrisCatalog.agent,
        kpis
      },
      request.id
    );
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/conversations", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(
      `
      select
        id,
        tenant_id as "tenantId",
        patient_id as "patientId",
        site_id as "siteId",
        channel,
        direction,
        status,
        primary_intent as "primaryIntent",
        metadata->>'provider' as provider,
        case when patient_id is null then 'pending_name'
             when exists (select 1 from pulso_iris.administrative_patients p
                          where p.tenant_id = pulso_iris.conversations.tenant_id
                            and p.id = patient_id and p.full_name is not null) then 'identified'
             else 'pending_name' end as "identityStatus",
        metadata->>'sofiaStatus' as "sofiaStatus",
        metadata->>'lastSofiaActivityAt' as "lastSofiaActivityAt",
        started_at as "startedAt",
        ended_at as "endedAt",
        created_at as "createdAt",
        updated_at as "updatedAt"
      from pulso_iris.conversations
      where tenant_id = $1
      order by started_at desc
      limit 100
    `,
      [tenantId]
    );

    return envelope(pulsoIrisConversationListSchema.parse(result.rows), request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/appointments", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(
      `
      select
        a.id,
        a.tenant_id as "tenantId",
        a.patient_id as "patientId",
        a.conversation_id as "conversationId",
        a.site_id as "siteId",
        a.professional_id as "professionalId",
        professional.is_pilot as "professionalIsPilot",
        a.payer_id as "payerId",
        a.appointment_type_id as "appointmentTypeId",
        a.appointment_type as "appointmentType",
        a.origin,
        a.status,
        a.scheduled_at as "scheduledAt",
        a.legacy_reference as "legacyReference",
        a.created_at as "createdAt",
        a.updated_at as "updatedAt"
      from pulso_iris.appointments a
      left join pulso_iris.professionals professional
        on professional.tenant_id = a.tenant_id and professional.id = a.professional_id
      where a.tenant_id = $1
      order by coalesce(a.scheduled_at, a.created_at) desc
      limit 100
    `,
      [tenantId]
    );

    return envelope(pulsoIrisAppointmentListSchema.parse(result.rows), request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/handoffs", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(
      `
      select
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
      from pulso_iris.handoffs
      where tenant_id = $1
      order by created_at desc
      limit 100
    `,
      [tenantId]
    );

    return envelope(pulsoIrisHandoffListSchema.parse(result.rows), request.id);
  });

  app.get("/v1/tenants/:tenantId/pulso-iris/rpa/actions", async (request, reply) => {
    const tenantId = readTenantId(request.params);
    if (!tenantId) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query(
      `
      select
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
      from pulso_iris.rpa_actions
      where tenant_id = $1
      order by created_at desc
      limit 100
    `,
      [tenantId]
    );

    return envelope(pulsoIrisRpaActionListSchema.parse(result.rows), request.id);
  });
};

// Schema is owned by @hyperion/migrations; the service only checks it is present.
async function verifyPulsoIrisSchema(context: ServiceContext): Promise<void> {
  if (!context.db) {
    return;
  }

  try {
    const result = await context.db.query<{ table_ref: string | null }>(
      "select to_regclass('pulso_iris.conversations')::text as table_ref"
    );

    if (!result.rows[0]?.table_ref) {
      context.logger.warn("pulso_iris schema is missing; run migrations before serving tenant data");
    }
  } catch (error) {
    context.logger.warn("could not verify pulso_iris schema", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
