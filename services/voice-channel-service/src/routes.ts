import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  envelope,
  novaCatalog,
  tenantIdSchema,
  voiceCallRequestedPayloadSchema,
  voiceCallRequestedV2PayloadSchema,
  voiceCallDispatchedPayloadSchema,
  voiceCallCompletedPayloadSchema
} from "@hyperion/nova-contracts";
import { isRestrictedDeploymentEnvironment, readServiceUrls } from "@hyperion/nova-config";
import type { DatabaseClient } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/nova-service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DialerAdapter } from "./dialer-adapter.js";
import { insertVoiceOutboxEvent, listVoiceOutboxDlq, redriveVoiceOutboxDlq } from "./outbox.js";

const rawJsonBodies = new WeakMap<FastifyRequest, Buffer>();

export function registerVoiceRawJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    rawJsonBodies.set(request, rawBody);
    try {
      done(null, JSON.parse(rawBody.toString("utf8")));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
}

const voiceCatalog = {
  product: novaCatalog.product.code,
  contexts: ["voice-channel"] as const,
  transports: ["dialer", "elevenlabs_sip_direct"] as const,
  eventTypes: [
    "voice.call.requested",
    "voice.call.requested.v2",
    "voice.call.dispatched",
    "voice.call.completed"
  ] as const
};

/** Time-of-day greeting in Colombia (America/Bogota) so the agent never says "buenos días" at night. */
function colombianGreeting(now: Date = new Date()): string {
  let hour: number;
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
 * Spoken-safe defaults so ElevenLabs never utters raw "{{universidad}}" etc.
 * Empty/missing keys become neutral Spanish phrases the prompt treats as "sin dato".
 */
const SPOKEN_DEFAULTS: Record<string, string> = {
  nombre: "Asociado",
  documento: "",
  agencia: "su sede",
  universidad: "su universidad",
  linea_credito: "su línea de crédito",
  cuota: "",
  saldo_total: "",
  mora: "",
  estado_cuenta: "",
  fecha_prox_pago: "",
  semestre: "",
  plazo: "",
  ciudad: "su ciudad"
};

function titleCaseName(raw: string): string {
  const cleaned = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!cleaned) return "Asociado";
  // Prefer first given name(s); avoid shouting full legal names every turn.
  const parts = cleaned.split(" ").slice(0, 2);
  return parts.map((p) => p.charAt(0).toLocaleUpperCase("es-CO") + p.slice(1).toLocaleLowerCase("es-CO")).join(" ");
}

function isGenericSpokenValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (/^\{\{[a-z0-9_]+\}\}$/i.test(v)) return true;
  return /^(su |asociado|n\/a|na|null|undefined|desconocid)/i.test(v);
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
  const vars: Record<string, string> = {};
  for (const [key, raw] of Object.entries(dynamicVars ?? {})) {
    const value = String(raw ?? "").trim();
    if (!value || /^\{\{[a-z0-9_]+\}\}$/i.test(value)) continue;
    vars[key] = value;
  }
  if (!vars.saludo) vars.saludo = colombianGreeting();
  if (!vars.disclosure_ai) {
    vars.disclosure_ai = process.env.VOICE_AI_DISCLOSURE_NAME?.trim() || "asistente de voz con inteligencia artificial";
  }
  if (!vars.cupo_preaprobado_validado) vars.cupo_preaprobado_validado = "no";
  if (vars.nombre) vars.nombre = titleCaseName(vars.nombre);
  else vars.nombre = SPOKEN_DEFAULTS.nombre;
  for (const [key, fallback] of Object.entries(SPOKEN_DEFAULTS)) {
    if (key === "nombre") continue;
    if (!vars[key] || isGenericSpokenValue(vars[key]!)) {
      if (fallback) vars[key] = fallback;
      else delete vars[key];
    }
  }
  // Always present so prompt placeholders never leak as literal braces.
  if (!vars.agencia) vars.agencia = SPOKEN_DEFAULTS.agencia;
  if (!vars.universidad) vars.universidad = SPOKEN_DEFAULTS.universidad;
  if (!vars.ciudad) vars.ciudad = SPOKEN_DEFAULTS.ciudad;
  if (!vars.linea_credito) vars.linea_credito = SPOKEN_DEFAULTS.linea_credito;
  return vars;
}

const reconcileSchema = z
  .object({
    result_code: z.string().max(80),
    intent: z.string().max(80).optional(),
    disposition: z.string().max(80).optional(),
    resolution: z.enum(["confirmed_initiated", "confirmed_not_created", "abandoned"]).optional(),
    conversation_id: z.string().max(160).optional(),
    provider_record_absent: z.literal(true).optional()
  })
  .superRefine((value, context) => {
    if (value.provider_record_absent && value.resolution !== "abandoned") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resolution"],
        message: "provider_record_absent requires resolution=abandoned"
      });
    }
  });

const internalEventSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(3).max(120),
  version: z.number().int().positive().default(1),
  occurredAt: z.string().datetime(),
  tenantId: z.string().uuid().nullable(),
  correlationId: z.string().uuid().optional(),
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
  app.get("/v1/voice/catalog", async (request) => envelope(voiceCatalog, request.id));

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

  app.get("/v1/tenants/:tenantId/voice/operations/readiness", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (readHeader(request, "x-operator-role") !== "admin") {
      return reply.code(403).send(envelope({ error: "NOVA admin role required" }, request.id));
    }

    const result = await scope.db.query<{
      pendingAged: string;
      failed: string;
      unresolvedDlq: string;
      reconciliation: string;
      reconciliationStale: string;
      dispatchedStale: string;
    }>(
      `select
         (select count(*)::text from voice.outbox_events
           where tenant_id = $1 and status = 'pending' and available_at < now() - interval '5 minutes') as "pendingAged",
         (select count(*)::text from voice.outbox_events
           where tenant_id = $1 and status = 'failed') as failed,
         (select count(*)::text from voice.outbox_dlq
           where tenant_id = $1 and redriven_at is null) as "unresolvedDlq",
         (select count(*)::text from voice.calls
           where tenant_id = $1 and status = 'needs_reconciliation') as reconciliation,
         (select count(*)::text from voice.calls
           where tenant_id = $1 and status = 'needs_reconciliation'
             and updated_at < now() - interval '15 minutes') as "reconciliationStale",
         (select count(*)::text from voice.calls
           where tenant_id = $1 and status in ('requested', 'dispatched', 'ringing', 'answered')
             and updated_at < now() - interval '30 minutes') as "dispatchedStale"`,
      [scope.tenantId]
    );
    const row = result.rows[0]!;
    const metrics = {
      outbox_pending_aged: Number(row.pendingAged),
      outbox_failed: Number(row.failed),
      outbox_dlq_unresolved: Number(row.unresolvedDlq),
      calls_needs_reconciliation: Number(row.reconciliation),
      calls_reconciliation_stale: Number(row.reconciliationStale),
      calls_nonterminal_stale: Number(row.dispatchedStale)
    };
    const degraded =
      metrics.outbox_pending_aged > 0 ||
      metrics.outbox_failed > 0 ||
      metrics.outbox_dlq_unresolved > 0 ||
      metrics.calls_reconciliation_stale > 0 ||
      metrics.calls_nonterminal_stale > 0;
    return envelope(
      {
        status: degraded ? "degraded" : "ok",
        measured_at: new Date().toISOString(),
        thresholds: {
          outbox_pending_age_seconds: 300,
          reconciliation_age_seconds: 900,
          nonterminal_call_age_seconds: 1800,
          failed_or_dlq: 0
        },
        metrics
      },
      request.id
    );
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
      correlationId: string | null;
    }>(
      `select contact_id as "contactId", campaign_ref as "campaignId", enrollment_id as "enrollmentId",
              dialer_call_ref as "dialerCallRef", correlation_id as "correlationId"
         from voice.calls
        where tenant_id = $1 and call_id = $2 and status = 'needs_reconciliation'`,
      [scope.tenantId, callId]
    );
    if (existing.rowCount === 0 || !existing.rows[0]!.contactId) {
      return reply.code(404).send(envelope({ error: "Call not found or not reconcilable" }, request.id));
    }

    const row = existing.rows[0]!;
    if (row.dialerCallRef && parsed.data.resolution && !parsed.data.provider_record_absent) {
      await dependencies.dialer.reconcileCall(row.dialerCallRef, parsed.data.resolution, {
        conversationId: parsed.data.conversation_id,
        note: parsed.data.result_code
      });
    }

    const correlationId = row.correlationId ?? randomUUID();
    const terminalStatus =
      parsed.data.resolution === "confirmed_not_created" || parsed.data.resolution === "abandoned"
        ? "failed"
        : "completed";
    await scope.db.transaction(async (tx) => {
      await tx.query(
        `update voice.calls
            set status = $3, result_code = $4, intent = $5, disposition = $6,
                provider_conversation_id = coalesce($7, provider_conversation_id),
                completed_at = now(), updated_at = now()
          where tenant_id = $1 and call_id = $2`,
        [
          scope.tenantId,
          callId,
          terminalStatus,
          parsed.data.result_code,
          parsed.data.intent ?? null,
          parsed.data.disposition ?? null,
          parsed.data.conversation_id ?? null
        ]
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
          status: terminalStatus,
          result_code: parsed.data.result_code,
          intent: parsed.data.intent,
          disposition: parsed.data.disposition,
          provider_conversation_id: parsed.data.conversation_id
        }),
        destination: novaDestination
      });
    });

    return envelope({ call_id: callId, contact_id: row.contactId, status: terminalStatus }, request.id);
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

    const verification = verifyElevenLabsWebhook(request, process.env);
    if (!verification.accepted) {
      return reply.code(verification.statusCode).send(envelope({ error: verification.message }, request.id));
    }

    const payload = (request.body ?? {}) as Record<string, unknown>;
    const data = (payload.data as Record<string, unknown> | undefined) ?? payload;
    const conversationId = String(
      data.conversation_id ?? data.conversationId ?? payload.conversation_id ?? payload.conversationId ?? ""
    ).trim();
    const externalId = String(payload.event_id ?? payload.eventId ?? (conversationId || randomUUID()));
    const analysis = (data.analysis as Record<string, unknown> | undefined) ?? {};
    const dataCollection = (analysis.data_collection_results as Record<string, unknown> | undefined) ?? {};
    const intent =
      readElevenLabsField(dataCollection.intencion) ||
      readElevenLabsField(dataCollection.intent) ||
      readElevenLabsField(dataCollection.disposition) ||
      readElevenLabsField(dataCollection.pedir_whatsapp) ||
      readElevenLabsField(dataCollection.quiere_whatsapp) ||
      readElevenLabsField(data.intent) ||
      readElevenLabsField(payload.intent) ||
      undefined;

    const insert = await context.db.query(
      `insert into voice.webhook_receipts (receipt_id, source, external_id, signature_valid, payload)
       values ($1, 'elevenlabs', $2, $3, $4::jsonb)
       on conflict (source, external_id) do nothing
       returning receipt_id`,
      [randomUUID(), externalId, verification.signatureValid, JSON.stringify(payload)]
    );

    if (!conversationId) {
      return envelope(
        {
          accepted: true,
          signature_valid: verification.signatureValid,
          mode: "receipt_only",
          reason: "no_conversation_id"
        },
        request.id
      );
    }

    // Deduped receipt → still ok, but skip double tipify.
    if (!insert.rowCount) {
      return envelope(
        {
          accepted: true,
          signature_valid: verification.signatureValid,
          mode: "deduped",
          conversation_id: conversationId
        },
        request.id
      );
    }

    const call = await context.db.query<{
      tenantId: string;
      callId: string;
      contactId: string | null;
      campaignId: string | null;
      enrollmentId: string | null;
      status: string;
      correlationId: string | null;
    }>(
      `select tenant_id as "tenantId", call_id as "callId", contact_id as "contactId",
              campaign_ref as "campaignId", enrollment_id as "enrollmentId", status,
              correlation_id as "correlationId"
         from voice.calls
        where provider_conversation_id = $1
        order by updated_at desc
        limit 1`,
      [conversationId]
    );

    const row = call.rows[0];
    if (!row?.contactId) {
      return envelope(
        {
          accepted: true,
          signature_valid: verification.signatureValid,
          mode: "receipt_only",
          reason: "call_not_matched",
          conversation_id: conversationId
        },
        request.id
      );
    }

    if (row.status === "completed" || row.status === "failed") {
      return envelope(
        {
          accepted: true,
          signature_valid: verification.signatureValid,
          mode: "already_terminal",
          call_id: row.callId
        },
        request.id
      );
    }

    const correlationId = row.correlationId ?? randomUUID();
    await context.db.transaction(async (tx) => {
      await tx.query(
        `update voice.calls
            set status = 'completed', updated_at = now()
          where tenant_id = $1 and call_id = $2`,
        [row.tenantId, row.callId]
      );
      await insertVoiceOutboxEvent(tx, {
        eventId: randomUUID(),
        eventType: "voice.call.completed",
        tenantId: row.tenantId,
        correlationId,
        businessIdempotencyKey: `voice-el-webhook:${row.callId}`,
        payload: voiceCallCompletedPayloadSchema.parse({
          call_id: row.callId,
          contact_id: row.contactId!,
          campaign_id: row.campaignId && tenantIdSchema.safeParse(row.campaignId).success ? row.campaignId : undefined,
          enrollment_id:
            row.enrollmentId && tenantIdSchema.safeParse(row.enrollmentId).success ? row.enrollmentId : undefined,
          status: "completed",
          result_code: "elevenlabs_webhook",
          intent,
          disposition: intent,
          provider_conversation_id: conversationId
        }),
        destination: novaDestination
      });
    });

    return envelope(
      {
        accepted: true,
        signature_valid: verification.signatureValid,
        mode: "tipify",
        call_id: row.callId,
        contact_id: row.contactId,
        intent
      },
      request.id
    );
  });

  app.post("/v1/voice/internal/events", async (request, reply) => {
    if (!context.db) return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));

    const parsed = internalEventSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(envelope({ error: "Invalid event envelope" }, request.id));
    if (parsed.data.type !== "voice.call.requested" && parsed.data.type !== "voice.call.requested.v2") {
      return reply.code(400).send(envelope({ error: "Unsupported event type" }, request.id));
    }
    const tenantId = parsed.data.tenantId;
    if (!tenantId) return reply.code(400).send(envelope({ error: "tenantId is required" }, request.id));

    const callPayload: z.infer<typeof voiceCallRequestedV2PayloadSchema> =
      parsed.data.type === "voice.call.requested.v2"
        ? voiceCallRequestedV2PayloadSchema.parse(parsed.data.payload)
        : { ...voiceCallRequestedPayloadSchema.parse(parsed.data.payload), dynamic_vars: undefined };
    const correlationId = parsed.data.correlationId ?? randomUUID();

    let claimed: boolean;
    try {
      claimed = await context.db.transaction(async (tx) => {
        const inbox = await tx.query(
          `insert into voice.inbox_events (event_id, event_type, tenant_id, payload)
         values ($1, $2, $3, $4::jsonb)
         on conflict do nothing
         returning event_id`,
          [parsed.data.id, parsed.data.type, tenantId, JSON.stringify(callPayload)]
        );
        if ((inbox.rowCount ?? 0) === 0) {
          const existing = await tx.query<{ identityMatches: boolean }>(
            `select (event_type = $2 and tenant_id = $3 and payload = $4::jsonb) as "identityMatches"
             from voice.inbox_events where event_id = $1 for update`,
            [parsed.data.id, parsed.data.type, tenantId, JSON.stringify(callPayload)]
          );
          if (!existing.rows[0]?.identityMatches) throw new Error("voice_inbox_event_conflict");
          return false;
        }

        const insertedCall = await tx.query(
          `insert into voice.calls (
           tenant_id, call_id, contact_id, enrollment_id, contact_phone_e164, campaign_ref,
           transport, status, correlation_id
         ) values ($1, $2, $3, $4, $5, $6, 'dialer', 'requested', $7)
         on conflict (tenant_id, call_id) do nothing
         returning call_id`,
          [
            tenantId,
            callPayload.call_id,
            callPayload.contact_id,
            callPayload.enrollment_id ?? null,
            callPayload.phone_e164,
            callPayload.campaign_id ?? null,
            correlationId
          ]
        );
        if ((insertedCall.rowCount ?? 0) === 0) throw new Error("voice_call_identity_conflict");
        return true;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "voice_inbox_event_conflict" || message === "voice_call_identity_conflict") {
        return reply.code(409).send(envelope({ error: message }, request.id));
      }
      throw error;
    }

    if (!claimed) {
      return reply
        .code(202)
        .send(
          envelope(
            { status: "duplicate", call_id: callPayload.call_id, contact_id: callPayload.contact_id },
            request.id
          )
        );
    }

    try {
      const placed = await dependencies.dialer.placeCall({
        phoneE164: callPayload.phone_e164,
        dynamicVars: withGreeting(callPayload.dynamic_vars),
        idempotencyKey: `requested:${tenantId}:${callPayload.call_id}`
      });

      if (placed.status.trim().toLowerCase() !== "initiated") {
        await context.db.transaction(async (tx) => {
          await tx.query(
            `update voice.calls
                set status = 'needs_reconciliation', result_code = 'dispatch_ambiguous',
                    dialer_call_ref = $3, provider_conversation_id = $4, updated_at = now()
              where tenant_id = $1 and call_id = $2 and status = 'requested'`,
            [tenantId, callPayload.call_id, placed.callRef, placed.conversationId ?? null]
          );
          await tx.query(`update voice.inbox_events set processed_at = now() where event_id = $1`, [parsed.data.id]);
        });
        return reply.code(202).send(
          envelope(
            {
              status: "needs_reconciliation",
              call_id: callPayload.call_id,
              contact_id: callPayload.contact_id,
              error: `Dialer returned ${placed.status}; provider outcome requires reconciliation`
            },
            request.id
          )
        );
      }

      await context.db.transaction(async (tx) => {
        const updated = await tx.query(
          `update voice.calls
              set status = 'dispatched', dialer_call_ref = $3,
                  provider_conversation_id = $4, updated_at = now()
            where tenant_id = $1 and call_id = $2 and status = 'requested'`,
          [tenantId, callPayload.call_id, placed.callRef, placed.conversationId ?? null]
        );
        if ((updated.rowCount ?? 0) === 0) throw new Error("voice_call_not_requestable");

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
        await tx.query(`update voice.inbox_events set processed_at = now() where event_id = $1`, [parsed.data.id]);
      });

      return envelope(
        { status: "accepted", call_id: callPayload.call_id, contact_id: callPayload.contact_id },
        request.id
      );
    } catch (error) {
      await context.db.transaction(async (tx) => {
        await tx.query(
          `update voice.calls
              set status = 'needs_reconciliation', result_code = 'dispatch_ambiguous', updated_at = now()
            where tenant_id = $1 and call_id = $2 and status = 'requested'`,
          [tenantId, callPayload.call_id]
        );
        await tx.query(`update voice.inbox_events set processed_at = now() where event_id = $1`, [parsed.data.id]);
      });
      return reply.code(202).send(
        envelope(
          {
            status: "needs_reconciliation",
            call_id: callPayload.call_id,
            contact_id: callPayload.contact_id,
            error: error instanceof Error ? error.message : "Dialer placeCall outcome is ambiguous"
          },
          request.id
        )
      );
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

  const body = rawJsonBodies.get(request) ?? Buffer.from(JSON.stringify(request.body ?? {}));
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (signature.length !== expected.length) {
    return { accepted: false, signatureValid: false, statusCode: 401, message: "Invalid signature" };
  }
  const validSignature = timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  return validSignature
    ? { accepted: true, signatureValid: true, statusCode: 200 }
    : { accepted: false, signatureValid: false, statusCode: 401, message: "Invalid signature" };
}

/** ElevenLabs post-call webhook: HMAC optional locally; required in restricted envs. */
function verifyElevenLabsWebhook(
  request: FastifyRequest,
  env: NodeJS.ProcessEnv
): { accepted: boolean; signatureValid: boolean; statusCode: number; message?: string } {
  const secret = env.ELEVENLABS_WEBHOOK_SECRET?.trim() || env.ELEVENLABS_WEBHOOK_HMAC_SECRET?.trim();
  const signature =
    readHeader(request, "x-elevenlabs-signature") ||
    readHeader(request, "elevenlabs-signature") ||
    readHeader(request, "x-webhook-signature");

  if (!secret) {
    if (isRestrictedDeploymentEnvironment(env)) {
      return { accepted: false, signatureValid: false, statusCode: 401, message: "ElevenLabs webhook secret required" };
    }
    return { accepted: true, signatureValid: false, statusCode: 200 };
  }

  if (!signature) {
    return { accepted: false, signatureValid: false, statusCode: 401, message: "Missing ElevenLabs webhook signature" };
  }

  const body = rawJsonBodies.get(request) ?? Buffer.from(JSON.stringify(request.body ?? {}));
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const normalized = signature.replace(/^sha256=/i, "");
  if (normalized.length !== expected.length) {
    return { accepted: false, signatureValid: false, statusCode: 401, message: "Invalid ElevenLabs signature" };
  }
  const validSignature = timingSafeEqual(Buffer.from(expected), Buffer.from(normalized));
  return validSignature
    ? { accepted: true, signatureValid: true, statusCode: 200 }
    : { accepted: false, signatureValid: false, statusCode: 401, message: "Invalid ElevenLabs signature" };
}

/** Unwrap ElevenLabs data_collection `{ value: "..." }` or plain scalars. */
function readElevenLabsField(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    const text = String(raw).trim();
    return text.length > 0 ? text : undefined;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["value", "result", "answer", "selected"]) {
      const nested = readElevenLabsField(obj[key]);
      if (nested) return nested;
    }
  }
  return undefined;
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
