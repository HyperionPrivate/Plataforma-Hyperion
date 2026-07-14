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
import { randomUUID } from "node:crypto";
import {
  HttpOutboxDispatcher,
  JetStreamOutboxDispatcher,
  isHttpDurableEventIngressEnabled,
  readNatsAuthentication,
  type NatsAuthentication
} from "@hyperion/durable-events";
import {
  createInternalAuthorizationHeaders,
  readInternalCredential,
  validateInternalAuthorization,
  type RouteRegistrar,
  type ServiceContext
} from "@hyperion/service-runtime";
import { registerAnalyticsRoutes } from "./analytics-routes.js";
import { registerAppointmentRoutes } from "./appointment-routes.js";
import { startAppointmentHoldExpiration } from "./appointment-hold-expiration.js";
import { startAppointmentVerificationSimulator } from "./appointment-verification-simulator.js";
import { createAuditClient } from "./audit-client.js";
import { registerAvailabilityRoutes } from "./availability-routes.js";
import { createLegacyChannelPositionResolver } from "./channel-position-client.js";
import {
  readChannelInboundV1Compatibility,
  registerChannelInboundEventRoutesWithCompatibility
} from "./channel-inbound-events.js";
import { startChannelInboundJetStreamConsumer } from "./channel-inbound-jetstream.js";
import { createChannelThreadClient } from "./channel-thread-client.js";
import { registerConfigRoutes } from "./config-routes.js";
import { registerPulsoEventPositionRoute } from "./event-position-routes.js";
import { registerOperationsRoutes } from "./operations-routes.js";
import { PostgresPulsoAuditOutbox } from "./pulso-audit-outbox.js";
import { PostgresPulsoOutbox } from "./pulso-outbox.js";
import { registerChannelDeliveryRoutes } from "./channel-delivery-routes.js";
import { registerSofiaOwnerRoutes } from "./sofia-owner-routes.js";
import { registerSofiaToolRoutes } from "./sofia-tools-routes.js";
import { readTenantId } from "./shared.js";

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const durableOutbox = readDurableOutboxConfiguration(process.env);
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_PULSO_TOKEN");
  const sofiaToken = readInternalCredential(process.env, "PULSO_TO_SOFIA_TOKEN");
  const sofiaToPulsoToken = readInternalCredential(process.env, "SOFIA_TO_PULSO_TOKEN");
  const channelToPulsoToken = readInternalCredential(process.env, "CHANNEL_TO_PULSO_TOKEN");
  const pulsoToChannelToken = readInternalCredential(process.env, "PULSO_TO_CHANNEL_TOKEN");
  const auditToken = readInternalCredential(process.env, "PULSO_TO_AUDIT_TOKEN");
  const allowLegacyChannelInboundV1 = readChannelInboundV1Compatibility(process.env);
  const channelServiceUrl = process.env.WHATSAPP_CHANNEL_SERVICE_URL ?? "http://localhost:8089";
  const resolveLegacyChannelPosition = allowLegacyChannelInboundV1
    ? createLegacyChannelPositionResolver({
        channelServiceUrl,
        credential: pulsoToChannelToken ?? ""
      })
    : undefined;
  const channelThreads = pulsoToChannelToken
    ? createChannelThreadClient({
        channelServiceUrl,
        credential: pulsoToChannelToken
      })
    : undefined;
  if (allowLegacyChannelInboundV1) {
    context.logger.warn("Channel inbound v1 compatibility window is enabled", {
      compatibilityMode: "channel_inbound_v1",
      targetContract: "channel.inbound.received.v2"
    });
  }
  if (context.db) {
    await verifyPulsoIrisSchema(context);
  }

  const emitAudit = createAuditClient({
    db: context.db,
    logger: context.logger
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.split("?", 1)[0]?.startsWith("/v1/tenants/")) return;
    const authError = validateInternalAuthorization(request.headers, { "api-gateway": gatewayToken });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
  });

  await registerConfigRoutes(app, context, emitAudit);
  await registerAppointmentRoutes(app, context, emitAudit);
  await registerOperationsRoutes(app, context, emitAudit);
  await registerAvailabilityRoutes(app, context);
  await registerAnalyticsRoutes(app, context);
  await registerSofiaToolRoutes(app, context, emitAudit);
  registerSofiaOwnerRoutes(app, context, sofiaToPulsoToken);
  registerChannelDeliveryRoutes(app, context, channelToPulsoToken);
  registerPulsoEventPositionRoute(app, context, sofiaToPulsoToken);
  if (isHttpDurableEventIngressEnabled(durableOutbox.transport)) {
    await registerChannelInboundEventRoutesWithCompatibility(app, context, {
      allowLegacyV1: allowLegacyChannelInboundV1,
      resolveLegacyPosition: resolveLegacyChannelPosition,
      channelThreads
    });
  }

  if (context.db && durableOutbox.transport === "jetstream") {
    const consumer = await startChannelInboundJetStreamConsumer((hook) => app.addHook("onClose", hook), context.db, {
      natsUrl: durableOutbox.natsUrl,
      allowLegacyV1: allowLegacyChannelInboundV1,
      resolveLegacyPosition: resolveLegacyChannelPosition,
      channelThreads,
      ...durableOutbox.authentication
    });
    context.registerReadinessCheck?.({
      name: "jetstream_channel_inbound_consumer",
      check: () => consumer.checkReadiness()
    });
  }

  if (context.db && (durableOutbox.transport === "jetstream" || sofiaToken)) {
    const workerId = `pulso-outbox-${randomUUID()}`;
    const outbox = new PostgresPulsoOutbox(
      context.db,
      workerId,
      process.env.AGENT_SERVICE_URL ?? "http://localhost:8083"
    );
    if (durableOutbox.enabled) {
      const dispatcher =
        durableOutbox.transport === "jetstream"
          ? new JetStreamOutboxDispatcher<Record<string, unknown>>({
              workerId,
              servers: durableOutbox.natsUrl,
              ...durableOutbox.authentication,
              connectionName: workerId,
              subjectPrefix: "hyperion.events",
              expectedStream: "HYPERION_EVENTS",
              claim: (limit) => outbox.claim(limit),
              complete: (eventId) => outbox.complete(eventId),
              fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
              batchSize: 10,
              intervalMs: 750,
              connectTimeoutMs: 5_000,
              publishTimeoutMs: 5_000
            })
          : new HttpOutboxDispatcher<Record<string, unknown>>({
              workerId,
              internalToken: sofiaToken!,
              fetch: createWorkloadFetch("pulso-iris-service", sofiaToken!),
              claim: (limit) => outbox.claim(limit),
              complete: (eventId) => outbox.complete(eventId),
              fail: (eventId, errorCode) => outbox.fail(eventId, errorCode),
              batchSize: 10,
              intervalMs: 750,
              timeoutMs: 5_000
            });
      app.addHook("onClose", async () => dispatcher.stop());
      if (dispatcher instanceof JetStreamOutboxDispatcher) {
        await dispatcher.initialize();
        context.registerReadinessCheck?.({
          name: "jetstream_pulso_publisher",
          check: () => dispatcher.checkReadiness()
        });
      }
      dispatcher.start();
    }
  }

  if (context.db && (durableOutbox.transport === "jetstream" || auditToken)) {
    const auditWorkerId = `pulso-audit-outbox-${randomUUID()}`;
    const auditOutbox = new PostgresPulsoAuditOutbox(
      context.db,
      auditWorkerId,
      process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086"
    );
    if (durableOutbox.enabled) {
      const auditDispatcher =
        durableOutbox.transport === "jetstream"
          ? new JetStreamOutboxDispatcher<Record<string, unknown>>({
              workerId: auditWorkerId,
              servers: durableOutbox.natsUrl,
              ...durableOutbox.authentication,
              connectionName: auditWorkerId,
              subjectPrefix: "hyperion.events",
              expectedStream: "HYPERION_EVENTS",
              claim: (limit) => auditOutbox.claim(limit),
              complete: (eventId) => auditOutbox.complete(eventId),
              fail: (eventId, errorCode) => auditOutbox.fail(eventId, errorCode),
              batchSize: 10,
              intervalMs: 750,
              connectTimeoutMs: 5_000,
              publishTimeoutMs: 5_000
            })
          : new HttpOutboxDispatcher<Record<string, unknown>>({
              workerId: auditWorkerId,
              internalToken: auditToken!,
              fetch: createWorkloadFetch("pulso-iris-service", auditToken!),
              claim: (limit) => auditOutbox.claim(limit),
              complete: (eventId) => auditOutbox.complete(eventId),
              fail: (eventId, errorCode) => auditOutbox.fail(eventId, errorCode),
              batchSize: 10,
              intervalMs: 750,
              timeoutMs: 5_000
            });
      app.addHook("onClose", async () => auditDispatcher.stop());
      if (auditDispatcher instanceof JetStreamOutboxDispatcher) {
        await auditDispatcher.initialize();
        context.registerReadinessCheck?.({
          name: "jetstream_pulso_audit_publisher",
          check: () => auditDispatcher.checkReadiness()
        });
      }
      auditDispatcher.start();
    }
  }

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

type DurableOutboxConfiguration =
  | { readonly transport: "http"; readonly enabled: boolean }
  | {
      readonly transport: "jetstream";
      readonly enabled: boolean;
      readonly natsUrl: string;
      readonly authentication: NatsAuthentication;
    };

export function readDurableOutboxConfiguration(env: NodeJS.ProcessEnv): DurableOutboxConfiguration {
  const transport = env.DURABLE_EVENT_TRANSPORT?.trim() || "http";
  if (transport !== "http" && transport !== "jetstream") {
    throw new Error("DURABLE_EVENT_TRANSPORT must be either http or jetstream");
  }

  const globallyEnabled = env.DURABLE_OUTBOX_ENABLED !== "false";
  if (transport === "http") {
    return {
      transport,
      enabled: globallyEnabled && env.DURABLE_HTTP_OUTBOX_ENABLED !== "false"
    };
  }

  return {
    transport,
    enabled: globallyEnabled,
    natsUrl: requireCredentialFreeNatsUrl(env.NATS_URL),
    authentication: readNatsAuthentication(
      { authToken: env.NATS_AUTH_TOKEN, username: env.NATS_USERNAME, password: env.NATS_PASSWORD },
      {
        required: true,
        minimumSecretLength: 24,
        serverConfigurationSafe: true,
        allowToken: env.NODE_ENV !== "production"
      }
    )!
  };
}

function requireCredentialFreeNatsUrl(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error("NATS_URL is required when DURABLE_EVENT_TRANSPORT=jetstream");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("NATS_URL must be a valid credential-free URL");
  }
  if (parsed.username || parsed.password) {
    throw new Error("NATS_URL must not contain credentials");
  }
  if (
    (parsed.protocol !== "nats:" && parsed.protocol !== "tls:") ||
    !parsed.hostname ||
    parsed.pathname !== "" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("NATS_URL must be a nats: or tls: endpoint without path, query, or hash");
  }
  return normalized;
}

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

function createWorkloadFetch(caller: string, token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(createInternalAuthorizationHeaders(caller, token))) {
      headers.set(name, value);
    }
    return fetch(input, { ...init, headers });
  };
}
