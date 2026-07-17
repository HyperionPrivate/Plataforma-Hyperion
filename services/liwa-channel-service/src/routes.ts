import { randomUUID } from "node:crypto";
import {
  envelope,
  novaAgencyTagByCode,
  novaCatalog,
  novaIngressEventSchema,
  tenantIdSchema,
  waSendRequestedPayloadSchema,
  waMessageSentPayloadSchema,
  handoffRequestedPayloadSchema,
  documentReceivedPayloadSchema,
  prequalCompletedPayloadSchema,
  csatRecordedPayloadSchema,
  optOutPayloadSchema,
  tipificacionRecordedPayloadSchema
} from "@hyperion/contracts";
import { readServiceUrls } from "@hyperion/config";
import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createLiwaClient, LiwaTextWindowError, type LiwaClient } from "./liwa-client.js";
import { insertLiwaOutboxEvent } from "./outbox.js";
import {
  mapEventKind,
  normalizeLiwaPayload,
  normalizePhoneE164,
  type NormalizedLiwaPayload
} from "./liwa-webhook-normalize.js";

const liwaCatalog = {
  product: novaCatalog.product.code,
  provider: "LIWA",
  baseUrlDefault: "https://chat.liwa.co/api",
  authHeader: "X-ACCESS-TOKEN",
  discovery: {
    flowBot: true,
    humanInbox: true,
    flowEndpoint: "POST /contacts/{id}/send/{flow_id}",
    tagsEndpoint: "GET|POST /accounts/tags",
    applyTagEndpoint: "POST /contacts/{id}/tags/{tag_id}",
    handoffModel: "apply agency tag AG_* (no /handoff endpoint)",
    textWindowHours: 24,
    coldOutboundRequiresFlow: true
  },
  normalizedWebhookEvents: [
    "document_received",
    "prequal_completed",
    "handoff_requested",
    "csat",
    "opt_out",
    "tipificacion"
  ] as const
};

const sendSchema = z.object({
  contact_ref: z.string().min(3).max(160),
  contact_id: z.string().uuid().optional(),
  first_name: z.string().max(120).optional(),
  mode: z.enum(["flow", "text"]),
  flow_id: z.string().max(80).optional(),
  text: z.string().max(2000).optional(),
  agency_tag: z.string().max(40).optional(),
  product_flow: z.enum(["renovacion", "reactivacion"]).optional()
});

const replySchema = z.object({
  text: z.string().min(1).max(2000)
});

export interface LiwaRouteDependencies {
  client: LiwaClient;
}

export async function registerLiwaRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  dependencies: LiwaRouteDependencies
): Promise<void> {
  const serviceUrls = readServiceUrls();
  const novaDestination = `${serviceUrls.novaCore.replace(/\/$/, "")}/internal/events`;

  app.get("/v1/liwa/catalog", async (request) =>
    envelope(
      {
        ...liwaCatalog,
        summary: "LIWA actúa como bot de flujos WhatsApp y bandeja humana para asesores."
      },
      request.id
    )
  );

  app.post("/v1/tenants/:tenantId/liwa/send", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid send payload" }, request.id));
    }
    if (parsed.data.mode === "flow" && !parsed.data.flow_id) {
      return reply.code(400).send(envelope({ error: "flow_id required for flow mode" }, request.id));
    }
    if (parsed.data.mode === "text" && !parsed.data.text) {
      return reply.code(400).send(envelope({ error: "text required for text mode" }, request.id));
    }

    const messageId = randomUUID();
    const correlationId = randomUUID();
    let sendResult: { providerRef: string; status: "sent" | "accepted_pending" };

    try {
      sendResult = await dispatchOutboundMessage(dependencies.client, parsed.data);
    } catch (error) {
      if (error instanceof LiwaTextWindowError) {
        return reply.code(422).send(
          envelope(
            {
              error: error.message,
              code: error.code,
              hint: "Use mode=flow for cold outbound; text requires an open 24h session or LIWA_FORCE_TEXT"
            },
            request.id
          )
        );
      }
      throw error;
    }

    await scope.db.transaction(async (tx) => {
      await upsertContactBinding(tx, {
        tenantId: scope.tenantId,
        contactRef: parsed.data.contact_ref,
        contactId: parsed.data.contact_id,
        agencyTag: parsed.data.agency_tag
      });

      await tx.query(
        `insert into liwa.messages (
           tenant_id, message_id, contact_ref, direction, kind, status, flow_id, agency_tag, payload, correlation_id
         ) values ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8::jsonb, $9)`,
        [
          scope.tenantId,
          messageId,
          parsed.data.contact_ref,
          parsed.data.mode,
          sendResult.status,
          parsed.data.flow_id ?? null,
          parsed.data.agency_tag ?? null,
          JSON.stringify({
            text: parsed.data.text,
            provider_ref: sendResult.providerRef,
            send_status: sendResult.status
          }),
          correlationId
        ]
      );

      const payload = waMessageSentPayloadSchema.parse({
        message_id: messageId,
        contact_id: parsed.data.contact_id,
        contact_ref: parsed.data.contact_ref,
        provider_ref: sendResult.providerRef || `accepted_pending:${messageId}`,
        mode: parsed.data.mode
      });
      await insertLiwaOutboxEvent(tx, {
        eventId: randomUUID(),
        eventType: "wa.message.sent",
        tenantId: scope.tenantId,
        correlationId,
        businessIdempotencyKey: `wa-sent:${messageId}`,
        payload,
        destination: novaDestination
      });
    });

    return reply.code(201).send(
      envelope(
        {
          message_id: messageId,
          provider_ref: sendResult.providerRef,
          status: sendResult.status
        },
        request.id
      )
    );
  });

  const handleInboundWebhook = async (request: FastifyRequest, reply: FastifyReply, opts?: { simulate?: boolean }) => {
    if (!context.db) return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));

    const secret = process.env.LIWA_WEBHOOK_SECRET?.trim();
    const headerSecret = readHeader(request, "x-liwa-webhook-secret");
    const querySecret = (() => {
      const q = request.query as Record<string, unknown> | undefined;
      const raw = q?.secret ?? q?.webhook_secret;
      return typeof raw === "string" ? raw.trim() : "";
    })();
    const allowInsecure =
      process.env.LIWA_WEBHOOK_ALLOW_INSECURE?.trim() === "1" &&
      (process.env.HYPERION_ENVIRONMENT?.trim() === "local" ||
        process.env.HYPERION_DEPLOYMENT_ENVIRONMENT?.trim() === "development");
    const secretOk = Boolean(secret) && (headerSecret === secret || querySecret === secret);
    if (!secretOk && !allowInsecure) {
      return reply.code(401).send(envelope({ error: "Invalid webhook secret" }, request.id));
    }

    const raw = (request.body ?? {}) as Record<string, unknown>;
    const parsed = normalizeLiwaPayload(raw);
    const kind = mapEventKind(parsed.event);
    const externalId = parsed.externalId || randomUUID();

    await context.db.query(
      `insert into liwa.webhook_receipts (receipt_id, external_id, event_name, payload)
       values ($1, $2, $3, $4::jsonb)
       on conflict (external_id) do nothing`,
      [
        randomUUID(),
        externalId,
        kind,
        JSON.stringify({ ...raw, _normalized: parsed, simulate: Boolean(opts?.simulate) })
      ]
    );

    const tenantId = await resolveWebhookTenant(context.db, raw, parsed);
    if (!tenantId) {
      return reply.code(422).send(envelope({ error: "Unable to resolve tenant for webhook payload" }, request.id));
    }

    try {
      await emitNormalizedWebhookEvent(context.db, tenantId, parsed, kind, novaDestination, externalId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to emit normalized webhook event";
      return reply.code(422).send(envelope({ error: message }, request.id));
    }

    return envelope(
      {
        accepted: true,
        normalized: kind,
        tenant_id: tenantId,
        phone: parsed.phone || undefined,
        agency_code: parsed.agencyCode,
        agency_tag: parsed.agencyTag,
        simulate: Boolean(opts?.simulate)
      },
      request.id
    );
  };

  app.post("/v1/liwa/webhooks", async (request, reply) => handleInboundWebhook(request, reply));
  app.post("/v1/liwa/webhooks/simulate", async (request, reply) =>
    handleInboundWebhook(request, reply, { simulate: true })
  );

  app.post("/v1/liwa/internal/events", async (request, reply) => {
    if (!context.db) return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));

    let parsed;
    try {
      parsed = novaIngressEventSchema.parse(request.body);
    } catch {
      return reply.code(400).send(envelope({ error: "Invalid event envelope" }, request.id));
    }
    if (parsed.event_type !== "wa.send.requested") {
      return reply.code(400).send(envelope({ error: "Unsupported event type" }, request.id));
    }

    const payload = waSendRequestedPayloadSchema.parse(parsed.payload);
    const correlationId = parsed.correlation_id ?? randomUUID();

    // Anti double-WA: already terminal for this message_id → no re-send / no redrive.
    const existing = await context.db.query<{ status: string; provider_ref: string | null }>(
      `select status, payload->>'provider_ref' as provider_ref
         from liwa.messages
        where tenant_id = $1 and message_id = $2
          and status in ('sent', 'accepted_pending', 'delivered')
        limit 1`,
      [parsed.tenant_id, payload.message_id]
    );
    if (existing.rowCount && existing.rows[0]) {
      return envelope(
        {
          status: existing.rows[0].status,
          message_id: payload.message_id,
          provider_ref: existing.rows[0].provider_ref ?? "",
          deduped: true
        },
        request.id
      );
    }

    let sendResult: { providerRef: string; status: "sent" | "accepted_pending" };
    try {
      sendResult = await dispatchOutboundMessage(dependencies.client, {
        contact_ref: payload.contact_ref,
        contact_id: payload.contact_id,
        mode: payload.mode,
        flow_id: payload.flow_id,
        text: payload.text,
        agency_tag: payload.agency_tag,
        product_flow: payload.product_flow
      });
    } catch (error) {
      if (error instanceof LiwaTextWindowError) {
        return reply
          .code(422)
          .send(envelope({ error: error.message, code: error.code, message_id: payload.message_id }, request.id));
      }
      throw error;
    }

    await context.db.transaction(async (tx) => {
      await upsertContactBinding(tx, {
        tenantId: parsed.tenant_id,
        contactRef: payload.contact_ref,
        contactId: payload.contact_id,
        agencyTag: payload.agency_tag
      });

      await tx.query(
        `insert into liwa.messages (
           tenant_id, message_id, contact_ref, direction, kind, status, flow_id, agency_tag, payload, correlation_id
         ) values ($1, $2, $3, 'outbound', $4, $5, $6, $7, $8::jsonb, $9)
         on conflict (tenant_id, message_id) do nothing`,
        [
          parsed.tenant_id,
          payload.message_id,
          payload.contact_ref,
          payload.mode,
          sendResult.status,
          payload.flow_id ?? null,
          payload.agency_tag ?? null,
          JSON.stringify({ text: payload.text, provider_ref: sendResult.providerRef, send_status: sendResult.status }),
          correlationId
        ]
      );
      await insertLiwaOutboxEvent(tx, {
        eventId: randomUUID(),
        eventType: "wa.message.sent",
        tenantId: parsed.tenant_id,
        correlationId,
        businessIdempotencyKey: `wa-sent:${payload.message_id}`,
        payload: waMessageSentPayloadSchema.parse({
          message_id: payload.message_id,
          contact_id: payload.contact_id,
          contact_ref: payload.contact_ref,
          provider_ref: sendResult.providerRef || `accepted_pending:${payload.message_id}`,
          mode: payload.mode
        }),
        destination: novaDestination
      });
    });

    return envelope(
      {
        status: sendResult.status,
        message_id: payload.message_id,
        provider_ref: sendResult.providerRef
      },
      request.id
    );
  });

  app.post("/v1/tenants/:tenantId/liwa/conversations/:id/reply", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const conversationId = readUuid(request.params, "id");
    if (!conversationId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));

    const parsed = replySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(envelope({ error: "text required" }, request.id));

    const messageId = randomUUID();
    let sent;
    try {
      sent = await dependencies.client.sendText(conversationId, parsed.data.text);
    } catch (error) {
      if (error instanceof LiwaTextWindowError) {
        return reply.code(422).send(envelope({ error: error.message, code: error.code }, request.id));
      }
      throw error;
    }

    await scope.db.query(
      `insert into liwa.messages (
         tenant_id, message_id, contact_ref, direction, kind, status, payload, correlation_id
       ) values ($1, $2, $3, 'outbound', 'text', $4, $5::jsonb, $6)`,
      [
        scope.tenantId,
        messageId,
        conversationId,
        sent.status,
        JSON.stringify({ text: parsed.data.text, provider_ref: sent.providerRef, send_status: sent.status }),
        randomUUID()
      ]
    );

    return envelope(
      {
        conversation_id: conversationId,
        message_id: messageId,
        provider_ref: sent.providerRef,
        status: sent.status
      },
      request.id
    );
  });
}

interface OutboundSendInput {
  contact_ref: string;
  contact_id?: string;
  mode: "flow" | "text";
  flow_id?: string;
  text?: string;
  agency_tag?: string;
}

interface OutboundSendInputExtended extends OutboundSendInput {
  first_name?: string;
  product_flow?: "renovacion" | "reactivacion";
}

async function dispatchOutboundMessage(
  client: LiwaClient,
  input: OutboundSendInputExtended
): Promise<{ providerRef: string; status: "sent" | "accepted_pending" }> {
  const { contactId } = await client.ensureContact(input.contact_ref, input.first_name);

  if (input.mode === "flow" && input.flow_id) {
    if (input.agency_tag) {
      await applyAgencyTag(client, contactId, input.agency_tag);
    }
    const vipTag =
      process.env.LIWA_VIP_TAG?.trim() ||
      (input.product_flow === "reactivacion" ? "REACTIVACION_VIP" : "RENOVACION_VIP");
    try {
      await applyAgencyTag(client, contactId, vipTag);
    } catch {
      // VIP tag may not exist yet; agency tag is enough for queue routing
    }
    return client.sendFlow(contactId, input.flow_id);
  }

  if (input.mode === "text" && input.text) {
    return client.sendText(contactId, input.text);
  }

  throw new Error("Invalid outbound message payload");
}

async function applyAgencyTag(client: LiwaClient, contactId: string, agencyTag: string): Promise<void> {
  const tagName = resolveAgencyTagName(agencyTag);
  const tagId = await client.ensureTag(tagName);
  await client.applyTag(contactId, tagId);
}

function resolveAgencyTagName(agencyTag: string): string {
  if (agencyTag.startsWith("AG_")) return agencyTag;
  const mapped = novaAgencyTagByCode[agencyTag as keyof typeof novaAgencyTagByCode];
  return mapped ?? `AG_${agencyTag.toUpperCase()}`;
}

async function upsertContactBinding(
  db: DatabaseExecutor,
  input: { tenantId: string; contactRef: string; contactId?: string; agencyTag?: string; phoneE164?: string }
): Promise<void> {
  await db.query(
    `insert into liwa.contact_bindings (tenant_id, contact_ref, contact_id, phone_e164, agency_tag, updated_at)
     values ($1, $2, $3, $4, $5, now())
     on conflict (tenant_id, contact_ref) do update
     set contact_id = coalesce(excluded.contact_id, liwa.contact_bindings.contact_id),
         phone_e164 = coalesce(excluded.phone_e164, liwa.contact_bindings.phone_e164),
         agency_tag = coalesce(excluded.agency_tag, liwa.contact_bindings.agency_tag),
         updated_at = now()`,
    [input.tenantId, input.contactRef, input.contactId ?? null, input.phoneE164 ?? null, input.agencyTag ?? null]
  );
}

async function resolveWebhookTenant(
  db: DatabaseClient,
  raw: Record<string, unknown>,
  parsed: NormalizedLiwaPayload
): Promise<string | null> {
  const userObj = raw.user && typeof raw.user === "object" ? (raw.user as Record<string, unknown>) : {};
  const accountId =
    raw.account_id ??
    raw.page_id ??
    raw.liwa_account_id ??
    userObj.account_id ??
    userObj.page_id ??
    process.env.LIWA_ACCOUNT_ID ??
    "1656233";
  if (accountId !== undefined && accountId !== null && String(accountId).trim() !== "") {
    const binding = await db.query<{ tenantId: string }>(
      `select tenant_id as "tenantId" from liwa.tenant_bindings where liwa_account_id = $1`,
      [String(accountId)]
    );
    if (binding.rowCount === 1) return binding.rows[0]!.tenantId;
  }

  if (parsed.tenantIdHint && tenantIdSchema.safeParse(parsed.tenantIdHint).success) {
    return parsed.tenantIdHint;
  }

  const defaultTenant = process.env.LIWA_WEBHOOK_DEFAULT_TENANT_ID?.trim();
  if (defaultTenant && tenantIdSchema.safeParse(defaultTenant).success) {
    return defaultTenant;
  }

  const phone = normalizePhoneE164(parsed.phone) ?? parsed.phone;
  const tenantIds = new Set<string>();

  if (parsed.contactId) {
    const byContact = await db.query<{ tenantId: string }>(
      `select distinct tenant_id as "tenantId" from liwa.contact_bindings where contact_ref = $1`,
      [parsed.contactId]
    );
    for (const row of byContact.rows) tenantIds.add(row.tenantId);
  }

  if (phone) {
    const byPhone = await db.query<{ tenantId: string }>(
      `select distinct tenant_id as "tenantId" from liwa.contact_bindings
        where phone_e164 = $1 or contact_ref = $1`,
      [phone]
    );
    for (const row of byPhone.rows) tenantIds.add(row.tenantId);
  }

  if (tenantIds.size === 1) return [...tenantIds][0]!;
  return null;
}

async function emitNormalizedWebhookEvent(
  db: DatabaseClient,
  tenantId: string,
  parsed: NormalizedLiwaPayload,
  kind: ReturnType<typeof mapEventKind>,
  novaDestination: string,
  externalId: string
): Promise<void> {
  const correlationId = randomUUID();
  const phone = normalizePhoneE164(parsed.phone) ?? parsed.phone;
  const contactRef = phone || parsed.contactId || "";
  const contactId = await resolveOrBindContact(db, tenantId, {
    phone,
    liwaContactId: parsed.contactId,
    agencyTag: parsed.agencyTag
  });

  if (kind === "document_received") {
    const documentId = randomUUID();
    await insertLiwaOutboxEvent(db, {
      eventId: randomUUID(),
      eventType: "document.received",
      tenantId,
      correlationId,
      businessIdempotencyKey: `liwa-doc:${externalId}`,
      payload: documentReceivedPayloadSchema.parse({
        document_id: documentId,
        contact_id: contactId,
        contact_ref: contactRef || undefined,
        storage_key: parsed.documentUrl ?? `pending/${documentId}`,
        content_type: "application/pdf",
        byte_size: 1
      }),
      destination: novaDestination
    });
    return;
  }

  if (kind === "prequal_completed") {
    await insertLiwaOutboxEvent(db, {
      eventId: randomUUID(),
      eventType: "wa.prequal.completed",
      tenantId,
      correlationId,
      businessIdempotencyKey: `prequal:${tenantId}:${contactRef || correlationId}`,
      payload: prequalCompletedPayloadSchema.parse({
        contact_id: contactId,
        contact_ref: contactRef || undefined,
        result: { name: parsed.name, fields: parsed.fields, ciudad: parsed.ciudad }
      }),
      destination: novaDestination
    });
    return;
  }

  if (kind === "handoff_requested") {
    if (!parsed.ciudad && !parsed.agencia && !parsed.agencyCode) {
      throw new Error("handoff webhook requires ciudad/agencia to resolve agency (no blind BAQ default)");
    }
    const handoffId = randomUUID();
    await insertLiwaOutboxEvent(db, {
      eventId: randomUUID(),
      eventType: "handoff.requested",
      tenantId,
      correlationId,
      businessIdempotencyKey: `handoff:${handoffId}`,
      payload: handoffRequestedPayloadSchema.parse({
        handoff_id: handoffId,
        contact_id: contactId,
        contact_ref: contactRef || undefined,
        agency_code: parsed.agencyCode ?? "BGA",
        agency_tag: parsed.agencyTag,
        reason: parsed.motivo
      }),
      destination: novaDestination
    });
    return;
  }

  if (kind === "csat") {
    const score = Math.min(5, Math.max(1, Number(parsed.score ?? 5)));
    await insertLiwaOutboxEvent(db, {
      eventId: randomUUID(),
      eventType: "csat.recorded",
      tenantId,
      correlationId,
      businessIdempotencyKey: `csat:${tenantId}:${contactRef || correlationId}`,
      payload: csatRecordedPayloadSchema.parse({
        contact_id: contactId,
        contact_ref: contactRef || undefined,
        score,
        note: parsed.motivo,
        channel: "whatsapp"
      }),
      destination: novaDestination
    });
    return;
  }

  if (kind === "opt_out") {
    await insertLiwaOutboxEvent(db, {
      eventId: randomUUID(),
      eventType: "contact.opt_out",
      tenantId,
      correlationId,
      businessIdempotencyKey: `opt-out:${tenantId}:${contactRef || correlationId}`,
      payload: optOutPayloadSchema.parse({
        contact_id: contactId,
        contact_ref: contactRef || undefined,
        reason: parsed.motivo
      }),
      destination: novaDestination
    });
    return;
  }

  if (kind === "tipificacion") {
    if (!parsed.tipificacion) throw new Error("tipificacion event requires tipificacion field");
    await insertLiwaOutboxEvent(db, {
      eventId: randomUUID(),
      eventType: "crm.tipificacion.recorded",
      tenantId,
      correlationId,
      businessIdempotencyKey: `tipif:${tenantId}:${contactRef || correlationId}:${parsed.tipificacion}`,
      payload: tipificacionRecordedPayloadSchema.parse({
        contact_id: contactId,
        contact_ref: contactRef || undefined,
        tipificacion: parsed.tipificacion,
        stage: typeof parsed.fields.to_column === "string" ? parsed.fields.to_column : undefined
      }),
      destination: novaDestination
    });
  }
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

async function resolveOrBindContact(
  db: DatabaseClient,
  tenantId: string,
  input: { phone?: string; liwaContactId?: string; agencyTag?: string }
): Promise<string | undefined> {
  const phone = input.phone ? (normalizePhoneE164(input.phone) ?? input.phone) : undefined;
  const refs = [phone, input.liwaContactId].filter(Boolean) as string[];

  for (const ref of refs) {
    const binding = await db.query<{ contactId: string | null }>(
      `select contact_id as "contactId"
         from liwa.contact_bindings
        where tenant_id = $1 and (contact_ref = $2 or phone_e164 = $2)
        limit 1`,
      [tenantId, ref]
    );
    if (binding.rows[0]?.contactId) return binding.rows[0].contactId;
  }

  // Persist phone binding so later events resolve; nova-core will upsert contact by phone.
  if (phone) {
    await upsertContactBinding(db, {
      tenantId,
      contactRef: phone,
      agencyTag: input.agencyTag,
      phoneE164: phone
    });
  }
  return undefined;
}

function readHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

export function createDefaultLiwaDependencies(env: NodeJS.ProcessEnv = process.env): LiwaRouteDependencies {
  return {
    client: createLiwaClient(env)
  };
}
