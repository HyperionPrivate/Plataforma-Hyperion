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
import { registerAvailabilityRoutes } from "./availability-routes.js";
import { registerConfigRoutes } from "./config-routes.js";
import { registerOperationsRoutes } from "./operations-routes.js";
import { readTenantId } from "./shared.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  if (context.db) {
    await verifyPulsoIrisSchema(context);
  }

  await registerConfigRoutes(app, context);
  await registerOperationsRoutes(app, context);
  await registerAvailabilityRoutes(app, context);
  await registerAnalyticsRoutes(app, context);

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
      from pulso_iris.appointments
      where tenant_id = $1
      order by coalesce(scheduled_at, created_at) desc
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
