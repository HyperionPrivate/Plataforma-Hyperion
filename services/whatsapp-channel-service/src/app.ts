import { timingSafeEqual } from "node:crypto";
import { envelope, tenantIdSchema } from "@hyperion/contracts";
import type { RouteRegistrar, ServiceContext } from "@hyperion/service-runtime";
import QRCode from "qrcode";
import { z } from "zod";
import { BaileysWhatsAppWebTestProvider } from "./baileys-provider.js";
import { PostgresChannelRepository } from "./channel-repository.js";
import { WhatsAppChannelService } from "./channel-service.js";
import { readWhatsAppProviderConfig } from "./provider-config.js";
import { WhatsAppProviderDisabledError } from "./types.js";

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
  internalServiceToken?: string;
}

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const dependencies: ChannelRouteDependencies = {
    internalServiceToken: context.config.internalServiceToken
  };
  if (context.db) {
    const provider = new BaileysWhatsAppWebTestProvider(readWhatsAppProviderConfig(), undefined, (reason, metadata) =>
      context.logger.info("whatsapp channel diagnostic", { reason, ...metadata })
    );
    const repository = new PostgresChannelRepository(context.db);
    const channel = new WhatsAppChannelService(
      provider,
      repository,
      500,
      (event) => {
        const token = context.config.internalServiceToken;
        if (!token) return;
        void fetch(`${process.env.AUDIT_SERVICE_URL ?? "http://localhost:8086"}/v1/audit/events`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ ...event, actorId: "agent:SOFIA" }),
          signal: AbortSignal.timeout(2_000)
        }).catch(() => context.logger.warn("whatsapp audit emission failed", { eventType: event.eventType }));
      },
      (errorCode) => context.logger.warn("whatsapp runtime operation deferred", { errorCode })
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
  }
  registerChannelRoutes(app, dependencies, context);
};

export function registerChannelRoutes(
  app: Parameters<RouteRegistrar>[0],
  dependencies: ChannelRouteDependencies,
  context?: ServiceContext
): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/internal/")) return;
    const authError = validateInternalToken(dependencies.internalServiceToken, request.headers.authorization);
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
    } catch {
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

function validateInternalToken(
  configuredToken: string | undefined,
  authorization: string | undefined
): { statusCode: number; message: string } | undefined {
  if (!configuredToken) return { statusCode: 503, message: "INTERNAL_SERVICE_TOKEN is required" };
  const expected = `Bearer ${configuredToken}`;
  if (!authorization || !constantTimeEquals(authorization, expected)) {
    return { statusCode: 401, message: "Unauthorized" };
  }
  return undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
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
