import { randomUUID } from "node:crypto";
import { envelope, tenantIdSchema } from "@hyperion/platform-contracts";
import {
  HttpOutboxDispatcher,
  JetStreamOutboxDispatcher,
  readNatsAuthentication,
  type NatsAuthentication
} from "@hyperion/durable-events";
import {
  createInternalAuthorizationHeaders,
  isRestrictedDeploymentEnvironment,
  readInternalCredential,
  validateInternalAuthorization,
  type InternalCredentialMap,
  type RouteRegistrar,
  type ServiceContext
} from "@hyperion/service-runtime";
import QRCode from "qrcode";
import { z } from "zod";
import { startAccessTenantProjectionJetStreamConsumer } from "./access-tenant-projection-jetstream.js";
import { BaileysWhatsAppWebTestProvider } from "./baileys-provider.js";
import { registerAccessTenantProjectionRoutes } from "./access-tenant-projections.js";
import { PostgresChannelAuditOutbox } from "./channel-audit-outbox.js";
import { PostgresChannelDeliveryOutbox } from "./channel-delivery-outbox.js";
import { PostgresChannelOutbox } from "./channel-outbox.js";
import { PostgresChannelRepository, OutboundEnqueueError } from "./channel-repository.js";
import { WhatsAppChannelService } from "./channel-service.js";
import { registerChannelEventPositionRoute } from "./event-position-routes.js";
import { registerThreadBindRoutes } from "./thread-bind-routes.js";
import { readWhatsAppProviderConfig } from "./provider-config.js";
import { WhatsAppProviderDisabledError } from "./types.js";
import { createPulsoDeliveryClient } from "./pulso-delivery-client.js";

const tenantParamsSchema = z.object({ tenantId: tenantIdSchema });
const eventParamsSchema = tenantParamsSchema.extend({ eventId: z.string().uuid() });
const outboundSchema = z.object({
  threadBindingId: z.string().uuid(),
  messageId: z.string().uuid(),
  text: z.string().trim().min(1).max(4_096),
  idempotencyKey: z.string().trim().min(8).max(200)
});
const claimSchema = z.object({
  workerId: z.string().trim().min(3).max(120),
  limit: z.number().int().min(1).max(20).default(1)
});
const completionSchema = z.object({ workerId: z.string().trim().min(3).max(120) });
const failureSchema = completionSchema.extend({
  errorCode: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]+$/)
    .min(3)
    .max(64)
});

export interface ChannelRouteDependencies {
  channel?: WhatsAppChannelService;
  accessCredential?: string;
  integrationCredential?: string;
  pulsoCredential?: string;
  sofiaCredential?: string;
}

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const durableOutbox = readDurableOutboxConfiguration(process.env);
  const channelToPulsoToken = readInternalCredential(process.env, "CHANNEL_TO_PULSO_TOKEN");
  const channelToAuditToken = readInternalCredential(process.env, "CHANNEL_TO_AUDIT_TOKEN");
  const dependencies: ChannelRouteDependencies = {
    accessCredential: readInternalCredential(process.env, "ACCESS_TO_CHANNEL_TOKEN"),
    integrationCredential: readInternalCredential(process.env, "INTEGRATION_TO_CHANNEL_TOKEN"),
    pulsoCredential: readInternalCredential(process.env, "PULSO_TO_CHANNEL_TOKEN"),
    sofiaCredential: readInternalCredential(process.env, "SOFIA_TO_CHANNEL_TOKEN")
  };
  if (context.db) {
    const provider = new BaileysWhatsAppWebTestProvider(readWhatsAppProviderConfig(), undefined, (reason, metadata) =>
      context.logger.info("whatsapp channel diagnostic", { reason, ...metadata })
    );
    const repository = new PostgresChannelRepository(
      context.db,
      createPulsoDeliveryClient({
        pulsoIrisUrl: process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088",
        credential: channelToPulsoToken ?? ""
      })
    );
    const channel = new WhatsAppChannelService(provider, repository, 500, (errorCode) =>
      context.logger.warn("whatsapp runtime operation deferred", { errorCode })
    );
    dependencies.channel = channel;
    try {
      await channel.start();
    } catch {
      context.logger.warn("whatsapp runtime initialization deferred", {
        errorCode: "channel_schema_unavailable"
      });
    }
    app.addHook("onClose", async () => channel.stop());

    // Consumer lifecycle is independent from local outbox publication. Turning
    // off Channel producers must never make the Access-owned projection stale.
    if (durableOutbox.transport === "jetstream") {
      const consumer = await startAccessTenantProjectionJetStreamConsumer(
        (hook) => app.addHook("onClose", hook),
        context.db,
        {
          natsUrl: durableOutbox.natsUrl,
          ...durableOutbox.authentication
        }
      );
      context.registerReadinessCheck?.({
        name: "jetstream_access_tenant_projection_consumer",
        check: () => consumer.checkReadiness()
      });
    }

    if (durableOutbox.transport === "jetstream" || channelToPulsoToken) {
      const workerId = `channel-outbox-${randomUUID()}`;
      const outbox = new PostgresChannelOutbox(
        context.db,
        workerId,
        process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088"
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
                internalToken: channelToPulsoToken!,
                fetch: createWorkloadFetch("whatsapp-channel-service", channelToPulsoToken!),
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
            name: "jetstream_channel_publisher",
            check: () => dispatcher.checkReadiness()
          });
        }
        dispatcher.start();
      }
    }

    if (durableOutbox.transport === "jetstream" || channelToPulsoToken) {
      const deliveryWorkerId = `channel-delivery-outbox-${randomUUID()}`;
      const deliveryOutbox = new PostgresChannelDeliveryOutbox(
        context.db,
        deliveryWorkerId,
        process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088"
      );
      if (durableOutbox.enabled) {
        const deliveryDispatcher =
          durableOutbox.transport === "jetstream"
            ? new JetStreamOutboxDispatcher<Record<string, unknown>>({
                workerId: deliveryWorkerId,
                servers: durableOutbox.natsUrl,
                ...durableOutbox.authentication,
                connectionName: deliveryWorkerId,
                subjectPrefix: "hyperion.events",
                expectedStream: "HYPERION_EVENTS",
                claim: (limit) => deliveryOutbox.claim(limit),
                complete: (eventId) => deliveryOutbox.complete(eventId),
                fail: (eventId, errorCode) => deliveryOutbox.fail(eventId, errorCode),
                batchSize: 10,
                intervalMs: 750,
                connectTimeoutMs: 5_000,
                publishTimeoutMs: 5_000
              })
            : new HttpOutboxDispatcher<Record<string, unknown>>({
                workerId: deliveryWorkerId,
                internalToken: channelToPulsoToken!,
                fetch: createWorkloadFetch("whatsapp-channel-service", channelToPulsoToken!),
                claim: (limit) => deliveryOutbox.claim(limit),
                complete: (eventId) => deliveryOutbox.complete(eventId),
                fail: (eventId, errorCode) => deliveryOutbox.fail(eventId, errorCode),
                batchSize: 10,
                intervalMs: 750,
                timeoutMs: 5_000
              });
        app.addHook("onClose", async () => deliveryDispatcher.stop());
        if (deliveryDispatcher instanceof JetStreamOutboxDispatcher) {
          await deliveryDispatcher.initialize();
          context.registerReadinessCheck?.({
            name: "jetstream_channel_delivery_publisher",
            check: () => deliveryDispatcher.checkReadiness()
          });
        }
        deliveryDispatcher.start();
      }
    }

    if (durableOutbox.transport === "jetstream" || channelToAuditToken) {
      const auditWorkerId = `channel-audit-outbox-${randomUUID()}`;
      const auditOutbox = new PostgresChannelAuditOutbox(
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
                internalToken: channelToAuditToken!,
                fetch: createWorkloadFetch("whatsapp-channel-service", channelToAuditToken!),
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
            name: "jetstream_channel_audit_publisher",
            check: () => auditDispatcher.checkReadiness()
          });
        }
        auditDispatcher.start();
      }
    }
  }
  registerChannelRoutes(app, dependencies, context);
  registerAccessTenantProjectionRoutes(app, context, dependencies.accessCredential);
  registerChannelEventPositionRoute(app, context, dependencies.pulsoCredential);
  registerThreadBindRoutes(app, context, dependencies.pulsoCredential);
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
        allowToken: !isRestrictedDeploymentEnvironment(env)
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

export function registerChannelRoutes(
  app: Parameters<RouteRegistrar>[0],
  dependencies: ChannelRouteDependencies,
  context?: ServiceContext
): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/internal/")) return;
    const authError = validateInternalAuthorization(
      request.headers,
      credentialsForChannelRoute(request.routeOptions.url, dependencies)
    );
    if (authError) {
      await reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
  });

  app.get("/internal/v1/tenants/:tenantId/whatsapp/status", async (request, reply) => {
    const params = tenantParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request.id);
    const channel = requireChannel(dependencies, reply, request.id);
    if (!channel) return;
    try {
      return envelope({ tenantId: params.data.tenantId, ...(await channel.status(params.data.tenantId)) }, request.id);
    } catch {
      return unavailable(reply, request.id);
    }
  });

  app.post("/internal/v1/tenants/:tenantId/whatsapp/connect", async (request, reply) => {
    const params = tenantParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request.id);
    const channel = requireChannel(dependencies, reply, request.id);
    if (!channel) return;
    try {
      const status = await channel.connect(params.data.tenantId);
      return reply.code(202).send(envelope({ tenantId: params.data.tenantId, ...status }, request.id));
    } catch (error) {
      if (error instanceof WhatsAppProviderDisabledError) {
        return reply.code(409).send(envelope({ error: "WhatsApp Web test provider is disabled" }, request.id));
      }
      context?.logger.warn("whatsapp connect rejected", { errorCode: "connect_failed" });
      return unavailable(reply, request.id);
    }
  });

  app.get("/internal/v1/tenants/:tenantId/whatsapp/qr", async (request, reply) => {
    reply.header("cache-control", "no-store, max-age=0");
    reply.header("pragma", "no-cache");
    const params = tenantParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request.id);
    const channel = requireChannel(dependencies, reply, request.id);
    if (!channel) return;
    const status = await channel.status(params.data.tenantId).catch(() => undefined);
    const qr = channel.qr(params.data.tenantId);
    const qrDataUrl = qr
      ? await QRCode.toDataURL(qr.qr, {
          errorCorrectionLevel: "M",
          margin: 1,
          width: 320
        })
      : null;
    return envelope(
      {
        tenantId: params.data.tenantId,
        providerMode: "whatsapp_web_test",
        state: status?.state ?? "disconnected",
        qrDataUrl,
        qrExpiresAt: qr?.expiresAt ?? null
      },
      request.id
    );
  });

  app.post("/internal/v1/tenants/:tenantId/whatsapp/disconnect", async (request, reply) => {
    const params = tenantParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, request.id);
    const channel = requireChannel(dependencies, reply, request.id);
    if (!channel) return;
    try {
      await channel.disconnect(params.data.tenantId);
      return envelope({ tenantId: params.data.tenantId, ...(await channel.status(params.data.tenantId)) }, request.id);
    } catch {
      return unavailable(reply, request.id);
    }
  });

  app.post("/internal/v1/tenants/:tenantId/whatsapp/messages", async (request, reply) => {
    const params = tenantParamsSchema.safeParse(request.params);
    const body = outboundSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request.id);
    const channel = requireChannel(dependencies, reply, request.id);
    if (!channel) return;
    try {
      const result = await channel.enqueueOutbound({
        tenantId: params.data.tenantId,
        threadBindingId: body.data.threadBindingId,
        messageId: body.data.messageId,
        body: body.data.text,
        idempotencyKey: body.data.idempotencyKey
      });
      return reply.code(result.inserted ? 202 : 200).send(envelope(result, request.id));
    } catch (error) {
      const reason =
        error instanceof OutboundEnqueueError
          ? error.reason
          : error instanceof Error
            ? error.message
            : "outbound_enqueue_failed";
      context?.logger.warn("whatsapp outbound enqueue rejected", {
        tenantId: params.data.tenantId,
        threadBindingId: body.data.threadBindingId,
        messageId: body.data.messageId,
        reason
      });
      return reply.code(404).send(envelope({ error: "Thread or message not found" }, request.id));
    }
  });

  app.post("/internal/v1/whatsapp/inbound/claim", async (request, reply) => {
    const body = claimSchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, request.id);
    const channel = requireChannel(dependencies, reply, request.id);
    if (!channel) return;
    try {
      const events = await channel.claimInbound(body.data.workerId, body.data.limit);
      return envelope({ events }, request.id);
    } catch {
      return unavailable(reply, request.id);
    }
  });

  app.post("/internal/v1/tenants/:tenantId/whatsapp/inbound/:eventId/complete", async (request, reply) => {
    const params = eventParamsSchema.safeParse(request.params);
    const body = completionSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request.id);
    const channel = requireChannel(dependencies, reply, request.id);
    if (!channel) return;
    const completed = await channel.completeInbound(params.data.tenantId, params.data.eventId, body.data.workerId);
    if (!completed) {
      return reply.code(409).send(envelope({ error: "Event lease is not active" }, request.id));
    }
    return envelope({ completed: true }, request.id);
  });

  app.post("/internal/v1/tenants/:tenantId/whatsapp/inbound/:eventId/fail", async (request, reply) => {
    const params = eventParamsSchema.safeParse(request.params);
    const body = failureSchema.safeParse(request.body);
    if (!params.success || !body.success) return invalidRequest(reply, request.id);
    const channel = requireChannel(dependencies, reply, request.id);
    if (!channel) return;
    const failed = await channel.failInbound(
      params.data.tenantId,
      params.data.eventId,
      body.data.workerId,
      body.data.errorCode
    );
    if (!failed) {
      return reply.code(409).send(envelope({ error: "Event lease is not active" }, request.id));
    }
    return envelope({ failed: true }, request.id);
  });
}

function credentialsForChannelRoute(
  routeUrl: string | undefined,
  dependencies: ChannelRouteDependencies
): InternalCredentialMap {
  if (routeUrl === "/internal/v1/events/access-tenant-snapshots") {
    return { "identity-service": dependencies.accessCredential };
  }
  if (
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/messages" ||
    routeUrl === "/internal/v1/whatsapp/inbound/claim" ||
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/inbound/:eventId/complete" ||
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/inbound/:eventId/fail"
  ) {
    return { "agent-service": dependencies.sofiaCredential };
  }
  if (
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/status" ||
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/connect" ||
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/qr" ||
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/disconnect"
  ) {
    return { "integration-service": dependencies.integrationCredential };
  }
  if (routeUrl === "/internal/v1/tenants/:tenantId/channel-inbound/:eventId/stream-position") {
    return { "pulso-iris-service": dependencies.pulsoCredential };
  }
  if (
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/threads/:threadBindingId" ||
    routeUrl === "/internal/v1/tenants/:tenantId/whatsapp/threads/:threadBindingId/bind"
  ) {
    return { "pulso-iris-service": dependencies.pulsoCredential };
  }
  return {};
}

function createWorkloadFetch(caller: string, token: string): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(createInternalAuthorizationHeaders(caller, token))) {
      headers.set(name, value);
    }
    return fetch(input, { ...init, headers, redirect: "error" });
  };
}

function requireChannel(
  dependencies: ChannelRouteDependencies,
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  requestId: string
): WhatsAppChannelService | undefined {
  if (dependencies.channel) return dependencies.channel;
  void reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, requestId));
  return undefined;
}

function invalidRequest(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  requestId: string
): unknown {
  return reply.code(400).send(envelope({ error: "Invalid request" }, requestId));
}

function unavailable(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  requestId: string
): unknown {
  return reply.code(503).send(envelope({ error: "WhatsApp channel is unavailable" }, requestId));
}
