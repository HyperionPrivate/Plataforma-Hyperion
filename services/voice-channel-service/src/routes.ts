import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  envelope,
  novaCatalog,
  tenantIdSchema,
  voiceCallRequestedPayloadSchema,
  voiceCallDispatchedPayloadSchema,
  voiceCallCompletedPayloadSchema
} from "@hyperion/contracts";
import { isRestrictedDeploymentEnvironment, readServiceUrls } from "@hyperion/config";
import type { DatabaseClient } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DialerAdapter } from "./dialer-adapter.js";
import { insertVoiceOutboxEvent, listVoiceOutboxDlq, redriveVoiceOutboxDlq } from "./outbox.js";

const voiceCatalog = {
  product: novaCatalog.product.code,
  contexts: ["voice-channel"] as const,
  transports: ["dialer", "elevenlabs_sip_direct"] as const,
  eventTypes: ["voice.call.requested", "voice.call.dispatched", "voice.call.completed"] as const
};

const callCreateSchema = z.object({
  phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  contact_id: z.string().uuid(),
  campaign_id: z.string().uuid().optional(),
  enrollment_id: z.string().uuid().optional(),
  dynamic_vars: z.record(z.string()).optional()
});

/** Time-of-day greeting in Colombia (America/Bogota) so the agent never says "buenos días" at night. */
function colombianGreeting(now: Date = new Date()): string {
  let hour = 12;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Bogota",
        hour: "2-digit",
        hourCycle: "h23"
      }).format(now)
    );
  } catch {
    hour = (now.getUTCHours() + 24 - 5) % 24;
  }
  if (Number.isNaN(hour)) hour = 12;
  if (hour >= 5 && hour < 12) return "Buenos días";
  if (hour >= 12 && hour < 19) return "Buenas tardes";
  return "Buenas noches";
}

/**
 * Injects time-aware {{saludo}}, default {{disclosure_ai}} and
 * {{cupo_preaprobado_validado}}="no" when missing.
 * Callers may pass Excel Report fields: nombre, documento, phone_e164, agencia,
 * universidad, linea_credito, cuota, saldo_total, mora, estado_cuenta,
 * fecha_prox_pago, semestre, plazo, ciudad.
 * Only set cupo_preaprobado_validado to "si"/"true" when CRM/backend confirms it.
 */
function withGreeting(dynamicVars?: Record<string, string>): Record<string, string> {
  const vars = { ...(dynamicVars ?? {}) };
  if (!vars.saludo || vars.saludo.trim() === "") {
    vars.saludo = colombianGreeting();
  }
  if (!vars.disclosure_ai || vars.disclosure_ai.trim() === "") {
    vars.disclosure_ai = "asistente de voz de Coopfuturo";
  }
  if (!vars.cupo_preaprobado_validado || vars.cupo_preaprobado_validado.trim() === "") {
    vars.cupo_preaprobado_validado = "no";
  }
  return vars;
}

const campaignCreateSchema = z.object({
  name: z.string().min(2).max(160),
  agent_id: z.string().min(1).max(160).optional(),
  target_calls: z.number().int().nonnegative().optional()
});

const reconcileSchema = z.object({
  result_code: z.string().max(80),
  intent: z.string().max(80).optional(),
  disposition: z.string().max(80).optional(),
  resolution: z.enum(["confirmed_initiated", "confirmed_not_created", "abandoned"]).optional(),
  conversation_id: z.string().max(160).optional()
});

const internalEventSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(3).max(120),
  version: z.number().int().positive().default(1),
  occurredAt: z.string().datetime(),
  tenantId: z.string().uuid().nullable(),
  payload: z.record(z.unknown())
});

export interface VoiceRouteDependencies {
  dialer: DialerAdapter;
}

export async function registerVoiceRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  dependencies: VoiceRouteDependencies
): Promise<void> {
  const serviceUrls = readServiceUrls();
  const novaDestination = `${serviceUrls.novaCore.replace(/\/$/, "")}/internal/events`;
  const defaultAgentId = process.env.ELEVENLABS_AGENT_ID?.trim() || process.env.DIALER_DEFAULT_AGENT_ID?.trim() || "";

  app.get("/v1/voice/catalog", async (request) => envelope(voiceCatalog, request.id));

  app.post("/v1/tenants/:tenantId/voice/calls", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const parsed = callCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid call payload", issues: parsed.error.issues }, request.id));
    }

    const callId = randomUUID();
    const correlationId = randomUUID();

    try {
      const placed = await dependencies.dialer.placeCall({
        phoneE164: parsed.data.phone_e164,
        dynamicVars: withGreeting(parsed.data.dynamic_vars),
        idempotencyKey: `manual:${scope.tenantId}:${callId}`
      });

      await scope.db.transaction(async (tx) => {
        await tx.query(
          `insert into voice.calls (
             tenant_id, call_id, contact_id, enrollment_id, contact_phone_e164, campaign_ref,
             transport, status, dialer_call_ref, provider_conversation_id, correlation_id
           ) values ($1, $2, $3, $4, $5, $6, 'dialer', 'dispatched', $7, $8, $9)`,
          [
            scope.tenantId,
            callId,
            parsed.data.contact_id,
            parsed.data.enrollment_id ?? null,
            parsed.data.phone_e164,
            parsed.data.campaign_id ?? null,
            placed.callRef,
            placed.conversationId ?? null,
            correlationId
          ]
        );

        await insertVoiceOutboxEvent(tx, {
          eventId: randomUUID(),
          eventType: "voice.call.dispatched",
          tenantId: scope.tenantId,
          correlationId,
          businessIdempotencyKey: `voice-dispatched:${callId}`,
          payload: voiceCallDispatchedPayloadSchema.parse({
            call_id: callId,
            contact_id: parsed.data.contact_id,
            campaign_id: parsed.data.campaign_id,
            transport: "dialer",
            dialer_call_ref: placed.callRef,
            provider_conversation_id: placed.conversationId
          }),
          destination: novaDestination
        });
      });

      return reply.code(201).send(
        envelope(
          {
            call_id: callId,
            contact_id: parsed.data.contact_id,
            status: "dispatched",
            dialer_call_ref: placed.callRef
          },
          request.id
        )
      );
    } catch (error) {
      return reply
        .code(502)
        .send(envelope({ error: error instanceof Error ? error.message : "Dialer placeCall failed" }, request.id));
    }
  });

  app.post("/v1/tenants/:tenantId/voice/campaigns", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const parsed = campaignCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(envelope({ error: "Invalid campaign payload" }, request.id));

    const agentId = parsed.data.agent_id || defaultAgentId;
    if (!agentId) {
      return reply.code(400).send(envelope({ error: "agent_id or ELEVENLABS_AGENT_ID is required" }, request.id));
    }

    const campaignId = randomUUID();
    try {
      const dialer = await dependencies.dialer.createCampaign({
        name: parsed.data.name,
        agentId,
        targetCalls: parsed.data.target_calls,
        idempotencyKey: `campaign:${scope.tenantId}:${campaignId}`
      });
      await scope.db.query(
        `insert into voice.campaigns (tenant_id, campaign_id, name, dialer_campaign_ref, status)
         values ($1, $2, $3, $4, 'draft')`,
        [scope.tenantId, campaignId, parsed.data.name, dialer.campaignRef]
      );
      return reply
        .code(201)
        .send(envelope({ campaign_id: campaignId, dialer_campaign_ref: dialer.campaignRef }, request.id));
    } catch (error) {
      return reply
        .code(502)
        .send(envelope({ error: error instanceof Error ? error.message : "Dialer createCampaign failed" }, request.id));
    }
  });

  app.get("/v1/tenants/:tenantId/voice/campaigns", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const result = await scope.db.query(
      `select campaign_id, name, dialer_campaign_ref, status, created_at from voice.campaigns where tenant_id = $1`,
      [scope.tenantId]
    );
    return envelope(result.rows, request.id);
  });

  app.get("/v1/tenants/:tenantId/voice/campaigns/:campaignId/stats", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const campaignId = readUuid(request.params, "campaignId");
    if (!campaignId) return reply.code(400).send(envelope({ error: "campaignId must be a UUID" }, request.id));

    const row = await scope.db.query<{ dialerCampaignRef: string | null }>(
      `select dialer_campaign_ref as "dialerCampaignRef" from voice.campaigns where tenant_id = $1 and campaign_id = $2`,
      [scope.tenantId, campaignId]
    );
    if (row.rowCount === 0) return reply.code(404).send(envelope({ error: "Campaign not found" }, request.id));
    const ref = row.rows[0]!.dialerCampaignRef;
    if (!ref) return envelope({ campaign_id: campaignId, stats: null }, request.id);

    try {
      const stats = await dependencies.dialer.getCampaign(ref);
      return envelope({ campaign_id: campaignId, dialer_campaign_ref: ref, stats }, request.id);
    } catch (error) {
      return reply
        .code(502)
        .send(envelope({ error: error instanceof Error ? error.message : "Dialer stats failed" }, request.id));
    }
  });

  for (const action of ["start", "pause", "stop", "cancel"] as const) {
    app.post(`/v1/tenants/:tenantId/voice/campaigns/:campaignId/${action}`, async (request, reply) => {
      const scope = requireTenantDb(context, request, reply);
      if (!scope) return;
      const campaignId = readUuid(request.params, "campaignId");
      if (!campaignId) return reply.code(400).send(envelope({ error: "campaignId must be a UUID" }, request.id));

      const row = await scope.db.query<{ dialerCampaignRef: string | null }>(
        `select dialer_campaign_ref as "dialerCampaignRef" from voice.campaigns where tenant_id = $1 and campaign_id = $2`,
        [scope.tenantId, campaignId]
      );
      if (row.rowCount === 0) return reply.code(404).send(envelope({ error: "Campaign not found" }, request.id));

      const ref = row.rows[0]!.dialerCampaignRef;
      if (ref) {
        if (action === "start") await dependencies.dialer.start(ref);
        if (action === "pause") await dependencies.dialer.pause(ref);
        if (action === "stop") await dependencies.dialer.stop(ref);
        if (action === "cancel") await dependencies.dialer.cancel(ref);
      }

      const status =
        action === "start" ? "running" : action === "pause" ? "paused" : action === "stop" ? "stopped" : "cancelled";
      await scope.db.query(
        `update voice.campaigns set status = $3, updated_at = now() where tenant_id = $1 and campaign_id = $2`,
        [scope.tenantId, campaignId, status]
      );
      return envelope({ campaign_id: campaignId, status }, request.id);
    });
  }

  app.get("/v1/tenants/:tenantId/voice/calls/reconciliation", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const result = await scope.db.query(
      `select call_id, contact_id, contact_phone_e164, campaign_ref, dialer_call_ref, result_code, intent,
              disposition, amd_label, updated_at
         from voice.calls
        where tenant_id = $1 and status = 'needs_reconciliation'
        order by updated_at desc`,
      [scope.tenantId]
    );
    return envelope({ needs_reconciliation: result.rows }, request.id);
  });

  app.post("/v1/tenants/:tenantId/voice/calls/:callId/reconcile", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const callId = readUuid(request.params, "callId");
    if (!callId) return reply.code(400).send(envelope({ error: "callId must be a UUID" }, request.id));

    const parsed = reconcileSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(envelope({ error: "Invalid reconcile payload" }, request.id));

    const existing = await scope.db.query<{
      contactId: string | null;
      campaignId: string | null;
      enrollmentId: string | null;
      dialerCallRef: string | null;
    }>(
      `select contact_id as "contactId", campaign_ref as "campaignId", enrollment_id as "enrollmentId",
              dialer_call_ref as "dialerCallRef"
         from voice.calls
        where tenant_id = $1 and call_id = $2 and status = 'needs_reconciliation'`,
      [scope.tenantId, callId]
    );
    if (existing.rowCount === 0 || !existing.rows[0]!.contactId) {
      return reply.code(404).send(envelope({ error: "Call not found or not reconcilable" }, request.id));
    }

    const row = existing.rows[0]!;
    if (row.dialerCallRef && parsed.data.resolution) {
      await dependencies.dialer.reconcileCall(row.dialerCallRef, parsed.data.resolution, {
        conversationId: parsed.data.conversation_id,
        note: parsed.data.result_code
      });
    }

    const correlationId = randomUUID();
    await scope.db.transaction(async (tx) => {
      await tx.query(
        `update voice.calls
            set status = 'completed', result_code = $3, intent = $4, disposition = $5,
                completed_at = now(), updated_at = now()
          where tenant_id = $1 and call_id = $2`,
        [scope.tenantId, callId, parsed.data.result_code, parsed.data.intent ?? null, parsed.data.disposition ?? null]
      );

      await insertVoiceOutboxEvent(tx, {
        eventId: randomUUID(),
        eventType: "voice.call.completed",
        tenantId: scope.tenantId,
        correlationId,
        businessIdempotencyKey: `voice-reconcile:${callId}`,
        payload: voiceCallCompletedPayloadSchema.parse({
          call_id: callId,
          contact_id: row.contactId!,
          campaign_id: row.campaignId ?? undefined,
          enrollment_id: row.enrollmentId ?? undefined,
          status: "completed",
          result_code: parsed.data.result_code,
          intent: parsed.data.intent,
          disposition: parsed.data.disposition,
          provider_conversation_id: parsed.data.conversation_id
        }),
        destination: novaDestination
      });
    });

    return envelope({ call_id: callId, contact_id: row.contactId, status: "completed" }, request.id);
  });

  app.post("/v1/voice/webhooks/dialer", async (request, reply) => {
    if (!context.db) return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));

    const verification = verifyDialerWebhook(request, process.env);
    if (!verification.accepted) {
      return reply.code(verification.statusCode).send(envelope({ error: verification.message }, request.id));
    }

    const payload = (request.body ?? {}) as Record<string, unknown>;
    const externalId = String(payload.event_id ?? payload.id ?? randomUUID());
    await context.db.query(
      `insert into voice.webhook_receipts (receipt_id, source, external_id, signature_valid, payload)
       values ($1, 'dialer', $2, $3, $4::jsonb)
       on conflict (source, external_id) do nothing`,
      [randomUUID(), externalId, verification.signatureValid, JSON.stringify(payload)]
    );

    // Dialer business outcomes are ingested via poller; webhook is receipt-only.
    return envelope({ accepted: true, signature_valid: verification.signatureValid, mode: "receipt_only" }, request.id);
  });

  app.post("/v1/voice/webhooks/elevenlabs", async (request, reply) => {
    if (!context.db) return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));

    const payload = (request.body ?? {}) as Record<string, unknown>;
    const externalId = String(payload.event_id ?? payload.conversation_id ?? randomUUID());
    await context.db.query(
      `insert into voice.webhook_receipts (receipt_id, source, external_id, signature_valid, payload)
       values ($1, 'elevenlabs', $2, true, $3::jsonb)
       on conflict (source, external_id) do nothing`,
      [randomUUID(), externalId, JSON.stringify(payload)]
    );
    return envelope({ accepted: true }, request.id);
  });

  app.post("/v1/voice/internal/events", async (request, reply) => {
    if (!context.db) return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));

    const parsed = internalEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(envelope({ error: "Invalid event envelope" }, request.id));
    if (parsed.data.type !== "voice.call.requested") {
      return reply.code(400).send(envelope({ error: "Unsupported event type" }, request.id));
    }
    const tenantId = parsed.data.tenantId;
    if (!tenantId) return reply.code(400).send(envelope({ error: "tenantId is required" }, request.id));

    const callPayload = voiceCallRequestedPayloadSchema.parse(parsed.data.payload);
    const correlationId = randomUUID();

    try {
      const placed = await dependencies.dialer.placeCall({
        phoneE164: callPayload.phone_e164,
        dynamicVars: withGreeting(),
        idempotencyKey: `requested:${tenantId}:${callPayload.call_id}`
      });

      await context.db.transaction(async (tx) => {
        await tx.query(
          `insert into voice.calls (
             tenant_id, call_id, contact_id, enrollment_id, contact_phone_e164, campaign_ref,
             transport, status, dialer_call_ref, provider_conversation_id, correlation_id
           ) values ($1, $2, $3, $4, $5, $6, 'dialer', 'dispatched', $7, $8, $9)
           on conflict (tenant_id, call_id) do update
           set contact_id = excluded.contact_id,
               enrollment_id = excluded.enrollment_id,
               dialer_call_ref = excluded.dialer_call_ref,
               provider_conversation_id = excluded.provider_conversation_id,
               status = 'dispatched',
               updated_at = now()`,
          [
            tenantId,
            callPayload.call_id,
            callPayload.contact_id,
            callPayload.enrollment_id ?? null,
            callPayload.phone_e164,
            callPayload.campaign_id ?? null,
            placed.callRef,
            placed.conversationId ?? null,
            correlationId
          ]
        );

        await insertVoiceOutboxEvent(tx, {
          eventId: randomUUID(),
          eventType: "voice.call.dispatched",
          tenantId,
          correlationId,
          businessIdempotencyKey: `voice-dispatched:${callPayload.call_id}`,
          payload: voiceCallDispatchedPayloadSchema.parse({
            call_id: callPayload.call_id,
            contact_id: callPayload.contact_id,
            campaign_id: callPayload.campaign_id,
            transport: "dialer",
            dialer_call_ref: placed.callRef,
            provider_conversation_id: placed.conversationId
          }),
          destination: novaDestination
        });
      });

      return envelope(
        { status: "accepted", call_id: callPayload.call_id, contact_id: callPayload.contact_id },
        request.id
      );
    } catch (error) {
      return reply
        .code(502)
        .send(envelope({ error: error instanceof Error ? error.message : "Dialer placeCall failed" }, request.id));
    }
  });

  app.get("/v1/tenants/:tenantId/voice/outbox/dlq", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const query = typeof request.query === "object" && request.query ? (request.query as Record<string, unknown>) : {};
    const pendingOnly = query.pending === "true";
    const limit = typeof query.limit === "string" ? Number(query.limit) : 50;
    const rows = await listVoiceOutboxDlq(scope.db, scope.tenantId, {
      pendingOnly,
      limit: Number.isFinite(limit) ? limit : 50
    });

    return envelope(
      {
        items: rows.map((row) => ({
          event_id: row.eventId,
          event_type: row.eventType,
          tenant_id: row.tenantId,
          payload: row.payload,
          destination: row.destination,
          last_error: row.lastError,
          failed_at: row.failedAt.toISOString(),
          redriven_at: row.redrivenAt?.toISOString() ?? null
        }))
      },
      request.id
    );
  });

  app.post("/v1/tenants/:tenantId/voice/outbox/dlq/:eventId/redrive", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const eventId = readUuid(request.params, "eventId");
    if (!eventId) return reply.code(400).send(envelope({ error: "eventId must be a UUID" }, request.id));

    const redriven = await redriveVoiceOutboxDlq(scope.db, scope.tenantId, eventId);
    if (!redriven) {
      return reply.code(404).send(envelope({ error: "DLQ event not found for tenant" }, request.id));
    }

    return envelope({ event_id: eventId, status: "pending", redriven: true }, request.id);
  });
}

function verifyDialerWebhook(
  request: FastifyRequest,
  env: NodeJS.ProcessEnv
): { accepted: boolean; signatureValid: boolean; statusCode: number; message?: string } {
  const secret = env.DIALER_WEBHOOK_HMAC_SECRET?.trim() || env.WEBHOOK_HMAC_SECRET?.trim();
  const signature = readHeader(request, "x-dialer-signature") || readHeader(request, "x-webhook-signature");

  if (!secret) {
    if (isRestrictedDeploymentEnvironment(env)) {
      return { accepted: false, signatureValid: false, statusCode: 401, message: "Webhook secret required" };
    }
    return { accepted: true, signatureValid: false, statusCode: 200 };
  }

  if (!signature) {
    return { accepted: false, signatureValid: false, statusCode: 401, message: "Missing dialer webhook signature" };
  }

  const body = JSON.stringify(request.body ?? {});
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (signature.length !== expected.length) {
    return { accepted: false, signatureValid: false, statusCode: 401, message: "Invalid signature" };
  }
  const validSignature = timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  return validSignature
    ? { accepted: true, signatureValid: true, statusCode: 200 }
    : { accepted: false, signatureValid: false, statusCode: 401, message: "Invalid signature" };
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function requireTenantDb(
  context: ServiceContext,
  request: FastifyRequest,
  reply: FastifyReply
): { tenantId: string; db: DatabaseClient } | undefined {
  const raw =
    typeof request.params === "object" && request.params && "tenantId" in request.params
      ? (request.params as { tenantId?: unknown }).tenantId
      : undefined;
  const parsed = tenantIdSchema.safeParse(raw);
  if (!parsed.success) {
    void reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    return undefined;
  }
  if (!context.db) {
    void reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    return undefined;
  }
  return { tenantId: parsed.data, db: context.db };
}

function readUuid(params: unknown, key: string): string | undefined {
  const value =
    typeof params === "object" && params && key in params ? (params as Record<string, unknown>)[key] : undefined;
  const parsed = tenantIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
