import { randomUUID, createHash } from "node:crypto";
import {
  envelope,
  novaCatalog,
  novaFlowIdSchema,
  novaIngressEventSchema,
  tenantIdSchema,
  contactImportedPayloadSchema,
  contactScoredPayloadSchema,
  contactEligibilityDecidedPayloadSchema,
  handoffRequestedPayloadSchema,
  leadQualifiedPayloadSchema,
  coreOutcomeRecordedPayloadSchema,
  voiceCallCompletedPayloadSchema,
  voiceCallDispatchedPayloadSchema,
  waMessageSentPayloadSchema,
  waMessageReceivedPayloadSchema,
  waSendRequestedPayloadSchema,
  documentReceivedPayloadSchema,
  documentValidatedPayloadSchema,
  prequalCompletedPayloadSchema,
  csatRecordedPayloadSchema,
  optOutPayloadSchema
} from "@hyperion/nova-contracts";
import { readServiceUrls } from "@hyperion/nova-config";
import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
import type { ServiceContext } from "@hyperion/nova-service-runtime";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { DEFAULT_COMPLIANCE, normalizeE164, scoreContact } from "./domain.js";
import { extractMultipartFile, isCsvFilename, parseContactsCsv, type ContactImportRow } from "./contact-import-file.js";
import { createCoreAdapter, type CoreAdapter } from "./core-adapter.js";
import {
  insertNovaAuditOutboxEvent,
  insertNovaOutboxEvent,
  listNovaOutboxDlq,
  redriveNovaOutboxDlq
} from "./outbox.js";
import { canTransitionCrm, inferIntentFromPayload, stageFromPostCallIntent, type CrmStage } from "./post-call.js";
import { resolveLiwaFlowId, resolveProductFlowForContact } from "./resolve-liwa-flow.js";
import { authorizeVoiceCall, evaluateVoiceEligibility } from "./voice-authorization.js";
import { dispatchCampaignBatch } from "./campaign-orchestrator.js";

const productLineSchema = novaFlowIdSchema;

const contactImportSchema = z.object({
  contacts: z
    .array(
      z.object({
        phone_e164: z.string().min(8).max(20),
        full_name: z.string().max(160).optional(),
        agency_code: z.string().min(2).max(40).optional(),
        segment: z.string().max(80).optional(),
        product_line: productLineSchema.optional()
      })
    )
    .min(1)
    .max(500)
});

function productLineFromSegment(raw?: string | null): string {
  const value = String(raw ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  const identifier = value.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return novaFlowIdSchema.safeParse(identifier).success ? identifier : "default";
}

const scoreSchema = z.object({
  segment: z.string().min(1).max(80).optional(),
  score: z.number().optional(),
  auto: z.boolean().optional()
});

const campaignCreateSchema = z.object({
  name: z.string().min(2).max(160),
  channel: z.enum(["voice", "whatsapp", "mixed"]),
  product_flow: novaFlowIdSchema
});

const enrollSchema = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(500)
});

const CRM_STAGES = [
  "pendiente",
  "contactado",
  "interesado",
  "documento",
  "transferido",
  "renovado",
  "no_interes",
  "new",
  "contacted",
  "prequalified",
  "handoff",
  "won",
  "lost"
] as const;

const TERMINAL_CRM_STAGES = new Set<string>(["renovado", "no_interes", "won", "lost"]);

const leadPatchSchema = z.object({
  stage: z.enum(CRM_STAGES).optional(),
  tipification: z.string().max(80).optional(),
  product_line: productLineSchema.optional()
});

const complianceSettingsSchema = z.object({
  window_start_hour: z.number().int().min(0).max(23),
  window_end_hour: z.number().int().min(1).max(24),
  time_zone: z.string().trim().min(1).max(80),
  allowed_weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  voice_enabled: z.boolean(),
  whatsapp_enabled: z.boolean(),
  max_attempts_per_day: z.number().int().min(1).max(20),
  max_attempts_per_contact: z.number().int().min(1).max(20),
  rolling_window_days: z.number().int().min(1).max(90),
  max_concurrent_calls: z.number().int().min(1).max(500),
  min_hours_between_attempts: z.number().int().min(0).max(720),
  respect_holidays: z.boolean(),
  meta_contactos_hoy: z.number().int().min(0).max(1_000_000).optional().default(0)
});

const manualVoiceCallSchema = z.object({
  campaign_id: z.string().uuid().optional(),
  product_flow: novaFlowIdSchema.optional()
});

const labLiwaEventSchema = z.object({
  event: z.enum([
    "document_received",
    "prequal_completed",
    "handoff_requested",
    "csat",
    "opt_out",
    "tipificacion",
    "message"
  ]),
  phone: z.string().min(8).max(20),
  ciudad: z.string().max(80).optional(),
  score: z.number().int().min(1).max(5).optional(),
  tipificacion: z.string().max(80).optional(),
  full_name: z.string().max(160).optional(),
  text: z.string().max(2000).optional()
});

const productFlowSchema = novaFlowIdSchema;

const agentConfigSchema = z.object({
  product_flow: productFlowSchema,
  elevenlabs_agent_id: z.string().min(1).max(120),
  elevenlabs_phone_number_id: z.string().min(1).max(120),
  liwa_flow_id: z.string().max(120).optional().nullable(),
  from_number_e164: z.string().max(20).optional().nullable(),
  lead_context_templates: z.record(z.string()).default({}),
  is_active: z.boolean().optional()
});

const reviewDecisionSchema = z.object({
  decision: z.enum(["approve", "skip"]),
  operator_id: z.string().uuid().optional(),
  flow_id: z.string().max(80).optional()
});

const claimSchema = z.object({
  operator_id: z.string().uuid().optional()
});

const replySchema = z.object({
  text: z.string().min(1).max(2000)
});

const outcomeSchema = z.object({
  contact_id: z.string().uuid(),
  kind: z.enum(["csat", "core_financial", "campaign"]),
  payload: z.record(z.unknown()).default({})
});

const bootstrapSchema = z.object({
  tenant_id: z.string().uuid(),
  display_name: z.string().min(1).max(160),
  agencies: z
    .array(
      z.object({
        code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/),
        name: z.string().min(2).max(120),
        city: z.string().min(2).max(120),
        advisor_group: z.string().min(1).max(80),
        routing_tag: z.string().min(1).max(80).optional()
      })
    )
    .max(500)
    .default([]),
  operator_grants: z
    .array(
      z.object({
        operator_id: z.string().uuid(),
        role: z.enum(["admin", "supervisor", "asesor"]),
        agency_codes: z
          .array(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,39}$/))
          .max(500)
          .default([]),
        is_active: z.boolean().default(true)
      })
    )
    .max(500)
    .default([])
});

export interface NovaRouteDependencies {
  coreAdapter: CoreAdapter;
}

export async function registerNovaRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  dependencies: NovaRouteDependencies = { coreAdapter: createCoreAdapter(process.env) }
): Promise<void> {
  const serviceUrls = readServiceUrls();

  if (!app.hasContentTypeParser("multipart/form-data")) {
    app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.get("/v1/nova/catalog", async (request) => envelope(novaCatalog, request.id));

  app.get("/v1/tenants/:tenantId/nova/catalog", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;
    return envelope(novaCatalog, request.id);
  });

  app.get("/v1/tenants/:tenantId/nova/dashboard", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const counts = await scope.db.query<{
      contacts: string;
      campaigns: string;
      leads: string;
      handoffs: string;
      conversations: string;
      meta_contactos_hoy: string | null;
    }>(
      `select
         (select count(*)::text from nova.contacts where tenant_id = $1) as contacts,
         (select count(*)::text from nova.campaigns where tenant_id = $1) as campaigns,
         (select count(*)::text from nova.leads where tenant_id = $1) as leads,
         (select count(*)::text from nova.handoffs where tenant_id = $1 and status = 'queued') as handoffs,
         (select count(*)::text from nova.conversations where tenant_id = $1 and status <> 'closed') as conversations,
         (select meta_contactos_hoy::text from nova.compliance_settings where tenant_id = $1) as meta_contactos_hoy`,
      [scope.tenantId]
    );

    const row = counts.rows[0]!;
    return envelope(
      {
        contacts: Number(row.contacts),
        campaigns: Number(row.campaigns),
        leads: Number(row.leads),
        handoffsQueued: Number(row.handoffs),
        openConversations: Number(row.conversations),
        meta_contactos_hoy: row.meta_contactos_hoy != null ? Number(row.meta_contactos_hoy) : 0
      },
      request.id
    );
  });

  app.get("/v1/tenants/:tenantId/nova/contacts", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const q = readQueryString(request.query, "q");
    const agencyCode = readQueryString(request.query, "agency_code");
    if (agencyCode && !operator.unrestricted && !operator.agencyCodes.includes(agencyCode)) {
      return reply.code(403).send(envelope({ error: "Agency is outside the operator grant" }, request.id));
    }
    const agencyCodes = agencyCode ? [agencyCode] : operator.agencyCodes;
    const unrestrictedAgencyRead = operator.unrestricted && !agencyCode;
    const segment = readQueryString(request.query, "segment");
    const limitRaw = Number(readQueryString(request.query, "limit") ?? 50);
    const offsetRaw = Number(readQueryString(request.query, "offset") ?? 0);
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.trunc(limitRaw))) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.trunc(offsetRaw)) : 0;

    const result = await scope.db.query(
      `select contact_id, phone_e164, full_name, agency_code, segment, score, eligibility, opted_out,
              propensity, urgency, wave, universidad, ciudad, created_at, updated_at
         from nova.contacts
        where tenant_id = $1
          and ($2::boolean or agency_code = any($3::text[]))
          and ($4::text is null or segment = $4)
          and (
            $5::text is null
            or phone_e164 ilike '%' || $5 || '%'
            or coalesce(full_name, '') ilike '%' || $5 || '%'
            or contact_id::text = $5
          )
        order by updated_at desc
        limit $6 offset $7`,
      [scope.tenantId, unrestrictedAgencyRead, agencyCodes, segment ?? null, q ?? null, limit, offset]
    );
    const count = await scope.db.query<{ total: string }>(
      `select count(*)::text as total from nova.contacts
        where tenant_id = $1
          and ($2::boolean or agency_code = any($3::text[]))
          and ($4::text is null or segment = $4)
          and (
            $5::text is null
            or phone_e164 ilike '%' || $5 || '%'
            or coalesce(full_name, '') ilike '%' || $5 || '%'
            or contact_id::text = $5
          )`,
      [scope.tenantId, unrestrictedAgencyRead, agencyCodes, segment ?? null, q ?? null]
    );

    return envelope(
      {
        items: result.rows,
        total: Number(count.rows[0]?.total ?? 0),
        limit,
        offset
      },
      request.id
    );
  });

  app.post("/v1/tenants/:tenantId/nova/contacts/import", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const parsed = contactImportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope({ error: "Invalid import payload", issues: parsed.error.issues }, request.id));
    }

    const imported: Array<{ contact_id: string; phone_e164: string; created: boolean }> = [];

    await scope.db.transaction(async (tx) => {
      for (const row of parsed.data.contacts) {
        const phone = normalizeE164(row.phone_e164);
        if (!phone) continue;

        const contactId = randomUUID();
        const correlationId = randomUUID();
        const existing = await tx.query<{ contactId: string }>(
          `select contact_id as "contactId"
           from nova.contacts
           where tenant_id = $1 and phone_e164 = $2`,
          [scope.tenantId, phone]
        );

        const resolvedId = existing.rows[0]?.contactId ?? contactId;
        const created = !existing.rows[0];

        await tx.query(
          `insert into nova.contacts (tenant_id, contact_id, phone_e164, full_name, agency_code, segment, updated_at)
           values ($1, $2, $3, $4, $5, $6, now())
           on conflict (tenant_id, phone_e164) do update
           set full_name = coalesce(excluded.full_name, nova.contacts.full_name),
               agency_code = coalesce(excluded.agency_code, nova.contacts.agency_code),
               segment = coalesce(excluded.segment, nova.contacts.segment),
               updated_at = now()`,
          [scope.tenantId, resolvedId, phone, row.full_name ?? null, row.agency_code ?? null, row.segment ?? null]
        );

        const productLine = row.product_line ?? productLineFromSegment(row.segment);
        const existingLead = await tx.query<{ leadId: string; stage: string }>(
          `select lead_id as "leadId", stage from nova.leads
            where tenant_id = $1 and contact_id = $2 and product_line = $3
            order by updated_at desc limit 1`,
          [scope.tenantId, resolvedId, productLine]
        );
        if (existingLead.rowCount === 0) {
          await tx.query(
            `insert into nova.leads (tenant_id, lead_id, contact_id, stage, product_line, agency_code)
             values ($1, $2, $3, 'pendiente', $4, $5)`,
            [scope.tenantId, randomUUID(), resolvedId, productLine, row.agency_code ?? null]
          );
        } else if (existingLead.rows[0]!.stage === "pendiente") {
          await tx.query(
            `update nova.leads
                set agency_code = coalesce($3, agency_code),
                    updated_at = now()
              where tenant_id = $1 and lead_id = $2`,
            [scope.tenantId, existingLead.rows[0]!.leadId, row.agency_code ?? null]
          );
        }

        const payload = contactImportedPayloadSchema.parse({
          contact_id: resolvedId,
          phone_e164: phone,
          agency_code: row.agency_code,
          full_name_masked: row.full_name ? maskName(row.full_name) : undefined
        });

        await insertNovaAuditOutboxEvent(tx, {
          eventId: randomUUID(),
          domainEventType: "contact.imported",
          entityType: "contact",
          entityId: resolvedId,
          tenantId: scope.tenantId,
          correlationId,
          businessIdempotencyKey: `contact-import:${scope.tenantId}:${phone}`,
          payload,
          destination: `${serviceUrls.audit.replace(/\/$/, "")}/internal/v1/events`
        });

        imported.push({ contact_id: resolvedId, phone_e164: phone, created });
      }
    });

    return reply.code(201).send(envelope({ imported }, request.id));
  });

  app.post("/v1/tenants/:tenantId/nova/contacts/import/file", { bodyLimit: 2_100_000 }, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const body = Buffer.isBuffer(request.body)
      ? request.body
      : typeof request.body === "string"
        ? Buffer.from(request.body)
        : null;
    if (!body) {
      return reply.code(400).send(envelope({ error: "multipart file required" }, request.id));
    }

    const extracted = extractMultipartFile(request.headers["content-type"], body);
    if ("error" in extracted) {
      return reply.code(400).send(envelope({ error: extracted.error }, request.id));
    }
    if (!isCsvFilename(extracted.filename)) {
      return reply
        .code(415)
        .send(envelope({ error: "csv_only", detail: "XLSX not supported; upload CSV" }, request.id));
    }

    const parsed = parseContactsCsv(extracted.content.toString("utf8"));
    if (parsed.rows.length === 0 && parsed.errors.length > 0 && parsed.errors[0]?.row === 0) {
      return reply.code(400).send(envelope({ imported: 0, errors: parsed.errors }, request.id));
    }

    const importedIds: string[] = [];
    const errors = [...parsed.errors];

    await scope.db.transaction(async (tx) => {
      for (const row of parsed.rows) {
        const contactId = await upsertImportedContact(tx, scope.tenantId, row, serviceUrls.audit);
        importedIds.push(contactId);
      }
    });

    return reply.code(201).send(
      envelope(
        {
          imported: importedIds.length,
          contact_ids: importedIds,
          errors
        },
        request.id
      )
    );
  });

  app.get("/v1/tenants/:tenantId/nova/compliance/settings", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const result = await scope.db.query<{
      window_start_hour: number;
      window_end_hour: number;
      time_zone: string;
      allowed_weekdays: number[];
      voice_enabled: boolean;
      whatsapp_enabled: boolean;
      max_attempts_per_day: number;
      max_attempts_per_contact: number;
      rolling_window_days: number;
      max_concurrent_calls: number;
      min_hours_between_attempts: number;
      respect_holidays: boolean;
      meta_contactos_hoy: number;
      policy_revision: string;
      updated_at: Date;
    }>(
      `select window_start_hour, window_end_hour, time_zone, allowed_weekdays,
              voice_enabled, whatsapp_enabled, max_attempts_per_day,
              max_attempts_per_contact, rolling_window_days, max_concurrent_calls,
              min_hours_between_attempts, respect_holidays,
              coalesce(meta_contactos_hoy, 0) as meta_contactos_hoy,
              policy_revision::text as policy_revision, updated_at
         from nova.compliance_settings where tenant_id = $1`,
      [scope.tenantId]
    );

    if (result.rowCount === 0) {
      return envelope(
        {
          window_start_hour: DEFAULT_COMPLIANCE.windowStartHour,
          window_end_hour: DEFAULT_COMPLIANCE.windowEndHour,
          time_zone: DEFAULT_COMPLIANCE.timeZone,
          allowed_weekdays: DEFAULT_COMPLIANCE.allowedWeekdays,
          voice_enabled: DEFAULT_COMPLIANCE.voiceEnabled,
          whatsapp_enabled: DEFAULT_COMPLIANCE.whatsappEnabled,
          max_attempts_per_day: DEFAULT_COMPLIANCE.maxAttemptsPerDay,
          max_attempts_per_contact: DEFAULT_COMPLIANCE.maxAttemptsPerContact,
          rolling_window_days: DEFAULT_COMPLIANCE.rollingWindowDays,
          max_concurrent_calls: DEFAULT_COMPLIANCE.maxConcurrentCalls,
          min_hours_between_attempts: DEFAULT_COMPLIANCE.minHoursBetweenAttempts,
          respect_holidays: DEFAULT_COMPLIANCE.respectHolidays,
          meta_contactos_hoy: 0,
          policy_revision: null,
          source: "defaults"
        },
        request.id
      );
    }

    return envelope({ ...result.rows[0]!, source: "stored" }, request.id);
  });

  app.put("/v1/tenants/:tenantId/nova/compliance/settings", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const parsed = complianceSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope({ error: "Invalid compliance settings", issues: parsed.error.issues }, request.id));
    }
    if (parsed.data.window_start_hour >= parsed.data.window_end_hour) {
      return reply.code(400).send(envelope({ error: "window_start_hour must be < window_end_hour" }, request.id));
    }
    if (new Set(parsed.data.allowed_weekdays).size !== parsed.data.allowed_weekdays.length) {
      return reply.code(400).send(envelope({ error: "allowed_weekdays must not contain duplicates" }, request.id));
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: parsed.data.time_zone }).format(new Date(0));
    } catch {
      return reply.code(400).send(envelope({ error: "time_zone must be an IANA timezone" }, request.id));
    }

    const saved = await scope.db.query<{ policyRevision: string }>(
      `insert into nova.compliance_settings (
         tenant_id, window_start_hour, window_end_hour, time_zone, allowed_weekdays,
         voice_enabled, whatsapp_enabled, max_attempts_per_day, max_attempts_per_contact,
         rolling_window_days, max_concurrent_calls, min_hours_between_attempts,
         respect_holidays, meta_contactos_hoy, updated_at
       ) values ($1, $2, $3, $4, $5::smallint[], $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
       on conflict (tenant_id) do update set
         window_start_hour = excluded.window_start_hour,
         window_end_hour = excluded.window_end_hour,
         time_zone = excluded.time_zone,
         allowed_weekdays = excluded.allowed_weekdays,
         voice_enabled = excluded.voice_enabled,
         whatsapp_enabled = excluded.whatsapp_enabled,
         max_attempts_per_day = excluded.max_attempts_per_day,
         max_attempts_per_contact = excluded.max_attempts_per_contact,
         rolling_window_days = excluded.rolling_window_days,
         max_concurrent_calls = excluded.max_concurrent_calls,
         min_hours_between_attempts = excluded.min_hours_between_attempts,
         respect_holidays = excluded.respect_holidays,
         meta_contactos_hoy = excluded.meta_contactos_hoy,
         updated_at = now()
       returning policy_revision::text as "policyRevision"`,
      [
        scope.tenantId,
        parsed.data.window_start_hour,
        parsed.data.window_end_hour,
        parsed.data.time_zone,
        parsed.data.allowed_weekdays,
        parsed.data.voice_enabled,
        parsed.data.whatsapp_enabled,
        parsed.data.max_attempts_per_day,
        parsed.data.max_attempts_per_contact,
        parsed.data.rolling_window_days,
        parsed.data.max_concurrent_calls,
        parsed.data.min_hours_between_attempts,
        parsed.data.respect_holidays,
        parsed.data.meta_contactos_hoy ?? 0
      ]
    );

    return envelope({ ...parsed.data, policy_revision: saved.rows[0]!.policyRevision }, request.id);
  });

  app.get("/v1/tenants/:tenantId/nova/agent-configs", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const result = await scope.db.query(
      `select product_flow, elevenlabs_agent_id, elevenlabs_phone_number_id, liwa_flow_id,
              from_number_e164, lead_context_templates, is_active, updated_at
         from nova.agent_configs where tenant_id = $1 order by product_flow`,
      [scope.tenantId]
    );
    return envelope(result.rows, request.id);
  });

  app.get("/v1/tenants/:tenantId/nova/agent-configs/:productFlow", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const productFlow = readProductFlow(request.params);
    if (!productFlow) {
      return reply.code(400).send(envelope({ error: "productFlow must be a configured flow identifier" }, request.id));
    }

    const result = await scope.db.query(
      `select product_flow, elevenlabs_agent_id, elevenlabs_phone_number_id, liwa_flow_id,
              from_number_e164, lead_context_templates, is_active, updated_at
         from nova.agent_configs where tenant_id = $1 and product_flow = $2`,
      [scope.tenantId, productFlow]
    );
    if (result.rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Agent config not found" }, request.id));
    }
    return envelope(result.rows[0], request.id);
  });

  app.put("/v1/tenants/:tenantId/nova/agent-configs", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const parsed = agentConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid agent config", issues: parsed.error.issues }, request.id));
    }

    await upsertAgentConfig(scope.db, scope.tenantId, parsed.data);
    return envelope(parsed.data, request.id);
  });

  app.put("/v1/tenants/:tenantId/nova/agent-configs/:productFlow", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const productFlow = readProductFlow(request.params);
    if (!productFlow) {
      return reply.code(400).send(envelope({ error: "productFlow must be a configured flow identifier" }, request.id));
    }

    const parsed = agentConfigSchema.safeParse({
      ...(typeof request.body === "object" && request.body ? request.body : {}),
      product_flow: productFlow
    });
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid agent config", issues: parsed.error.issues }, request.id));
    }

    await upsertAgentConfig(scope.db, scope.tenantId, parsed.data);
    return envelope(parsed.data, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/contacts/:contactId/score", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const contactId = readUuid(request.params, "contactId");
    if (!contactId) return reply.code(400).send(envelope({ error: "contactId must be a UUID" }, request.id));

    const parsed = scoreSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid score payload" }, request.id));
    }

    const features = await scope.db.query<{
      segment: string | null;
      cupo: boolean | null;
      mora: string | null;
      saldo: string | null;
      universidad: string | null;
    }>(
      `select segment, cupo_preaprobado as cupo, mora_actual::text as mora, saldo_total::text as saldo, universidad
         from nova.contacts where tenant_id = $1 and contact_id = $2`,
      [scope.tenantId, contactId]
    );
    if (features.rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Contact not found" }, request.id));
    }

    const computed = scoreContact({
      segment: parsed.data.segment ?? features.rows[0]!.segment,
      cupoPreaprobado: features.rows[0]!.cupo,
      moraActual: features.rows[0]!.mora ? Number(features.rows[0]!.mora) : null,
      saldoTotal: features.rows[0]!.saldo ? Number(features.rows[0]!.saldo) : null,
      universidad: features.rows[0]!.universidad
    });
    const segment = parsed.data.segment ?? computed.segment;
    const score = parsed.data.score ?? computed.score;

    const correlationId = randomUUID();
    try {
      await scope.db.transaction(async (tx) => {
        const updated = await tx.query(
          `update nova.contacts
           set segment = $3, score = $4, propensity = $5, urgency = $6, wave = $7, updated_at = now()
           where tenant_id = $1 and contact_id = $2`,
          [scope.tenantId, contactId, segment, score, computed.propensity, computed.urgency, computed.wave]
        );
        if (updated.rowCount === 0) throw new Error("contact_not_found");

        const payload = contactScoredPayloadSchema.parse({
          contact_id: contactId,
          segment,
          score,
          propensity: computed.propensity,
          urgency: computed.urgency,
          wave: computed.wave
        });
        await insertNovaAuditOutboxEvent(tx, {
          eventId: randomUUID(),
          domainEventType: "contact.scored",
          entityType: "contact",
          entityId: contactId,
          tenantId: scope.tenantId,
          correlationId,
          businessIdempotencyKey: `contact-scored:${scope.tenantId}:${contactId}:${segment}`,
          payload,
          destination: `${serviceUrls.audit.replace(/\/$/, "")}/internal/v1/events`
        });
      });
    } catch {
      return reply.code(404).send(envelope({ error: "Contact not found" }, request.id));
    }
    return envelope({ contact_id: contactId, ...parsed.data }, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/contacts/:contactId/eligibility", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const contactId = readUuid(request.params, "contactId");
    if (!contactId) return reply.code(400).send(envelope({ error: "contactId must be a UUID" }, request.id));

    const decision = await scope.db.transaction(async (tx) => {
      const snapshot = await evaluateVoiceEligibility(tx, scope.tenantId, contactId);
      if (!snapshot) return null;
      await tx.query(
        `update nova.contacts set eligibility = $3, updated_at = now() where tenant_id = $1 and contact_id = $2`,
        [scope.tenantId, contactId, snapshot.decision.eligibility]
      );
      const payload = contactEligibilityDecidedPayloadSchema.parse({
        contact_id: contactId,
        ...snapshot.decision
      });
      await insertNovaAuditOutboxEvent(tx, {
        eventId: randomUUID(),
        domainEventType: "contact.eligibility.decided",
        entityType: "contact",
        entityId: contactId,
        tenantId: scope.tenantId,
        correlationId: randomUUID(),
        businessIdempotencyKey: `eligibility:${scope.tenantId}:${contactId}:${randomUUID()}`,
        payload,
        destination: `${serviceUrls.audit.replace(/\/$/, "")}/internal/v1/events`
      });
      return snapshot.decision;
    });

    if (!decision) return reply.code(404).send(envelope({ error: "Contact not found" }, request.id));

    return envelope({ contact_id: contactId, ...decision }, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/contacts/:contactId/calls", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const contactId = readUuid(request.params, "contactId");
    if (!contactId) return reply.code(400).send(envelope({ error: "contactId must be a UUID" }, request.id));
    const parsed = manualVoiceCallSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid call authorization payload" }, request.id));
    }

    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;
    const visibleContact = await scope.db.query(
      `select 1 from nova.contacts
        where tenant_id = $1 and contact_id = $2
          and ($3::boolean or agency_code = any($4::text[]))`,
      [scope.tenantId, contactId, operator.unrestricted, operator.agencyCodes]
    );
    if (visibleContact.rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Contact not found" }, request.id));
    }

    const result = await scope.db.transaction((tx) =>
      authorizeVoiceCall(tx, {
        tenantId: scope.tenantId,
        contactId,
        campaignId: parsed.data.campaign_id,
        productFlow: parsed.data.product_flow,
        voiceDestination: `${serviceUrls.voiceChannel.replace(/\/$/, "")}/v1/voice/internal/events`,
        auditDestination: `${serviceUrls.audit.replace(/\/$/, "")}/internal/v1/events`
      })
    );
    if (result.status === "contact_not_found") {
      return reply.code(404).send(envelope({ error: "Contact not found" }, request.id));
    }
    if (result.status === "blocked") {
      return reply.code(409).send(envelope({ contact_id: contactId, ...result.snapshot.decision }, request.id));
    }
    return reply
      .code(201)
      .send(envelope({ contact_id: contactId, call_id: result.callId, status: "queued" }, request.id));
  });

  app.post("/v1/tenants/:tenantId/nova/campaigns", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const parsed = campaignCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid campaign payload" }, request.id));
    }
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const campaignId = randomUUID();
    await scope.db.query(
      `insert into nova.campaigns (tenant_id, campaign_id, name, channel, product_flow, status)
       values ($1, $2, $3, $4, $5, 'draft')`,
      [scope.tenantId, campaignId, parsed.data.name, parsed.data.channel, parsed.data.product_flow]
    );

    return reply.code(201).send(envelope({ campaign_id: campaignId, status: "draft", ...parsed.data }, request.id));
  });

  app.get("/v1/tenants/:tenantId/nova/campaigns", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const result = await scope.db.query(
      `select c.campaign_id, c.name, c.channel, c.product_flow, c.status, c.created_at, c.updated_at,
              coalesce(e.total, 0)::int as total,
              coalesce(e.reached, 0)::int as reached,
              coalesce(e.converted, 0)::int as converted,
              coalesce(e.in_flight, 0)::int as in_flight,
              coalesce(e.failed, 0)::int as failed,
              coalesce(e.deferred, 0)::int as deferred
         from nova.campaigns c
         left join lateral (
           select count(*)::int as total,
                  count(*) filter (where status in ('reached', 'converted'))::int as reached,
                  count(*) filter (where status = 'converted')::int as converted,
                  count(*) filter (where status = 'attempted')::int as in_flight,
                  count(*) filter (where status = 'failed')::int as failed,
                  count(*) filter (
                    where status in ('enrolled', 'failed') and next_attempt_at > now()
                  )::int as deferred
             from nova.campaign_enrollments
            where tenant_id = c.tenant_id and campaign_id = c.campaign_id
         ) e on true
        where c.tenant_id = $1
        order by c.created_at desc`,
      [scope.tenantId]
    );
    return envelope(result.rows, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/campaigns/:id/enroll", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const campaignId = readUuid(request.params, "id");
    if (!campaignId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));

    const parsed = enrollSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid enroll payload" }, request.id));
    }
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const enrolled = await scope.db
      .transaction(async (tx) => {
        const campaign = await tx.query(
          `select 1 from nova.campaigns
          where tenant_id = $1 and campaign_id = $2 and status in ('draft', 'ready', 'paused')
          for update`,
          [scope.tenantId, campaignId]
        );
        if (campaign.rowCount === 0) throw new Error("campaign_not_enrollable");

        const visible = await tx.query<{ count: string }>(
          `select count(distinct c.contact_id)::text as count
           from nova.contacts c
          where c.tenant_id = $1 and c.contact_id = any($2::uuid[])
            and ($3::boolean or c.agency_code = any($4::text[]))`,
          [scope.tenantId, parsed.data.contact_ids, operator.unrestricted, operator.agencyCodes]
        );
        if (Number(visible.rows[0]?.count ?? 0) !== new Set(parsed.data.contact_ids).size) {
          throw new Error("contact_outside_operator_grant");
        }

        const result = await tx.query(
          `insert into nova.campaign_enrollments (tenant_id, campaign_id, contact_id, status)
         select $1, $2, contact_id, 'enrolled'
           from unnest($3::uuid[]) as input(contact_id)
         on conflict (tenant_id, campaign_id, contact_id) do nothing`,
          [scope.tenantId, campaignId, parsed.data.contact_ids]
        );
        return result.rowCount ?? 0;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "campaign_not_enrollable" || message === "contact_outside_operator_grant") return message;
        throw error;
      });
    if (enrolled === "campaign_not_enrollable") {
      return reply.code(409).send(envelope({ error: "Campaign not found or not enrollable" }, request.id));
    }
    if (enrolled === "contact_outside_operator_grant") {
      return reply
        .code(403)
        .send(envelope({ error: "One or more contacts are outside the operator grant" }, request.id));
    }

    return envelope({ campaign_id: campaignId, enrolled }, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/campaigns/:id/start", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const campaignId = readUuid(request.params, "id");
    if (!campaignId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const outsideGrant = await campaignHasContactsOutsideGrant(scope.db, scope.tenantId, campaignId, operator);
    if (outsideGrant) {
      return reply
        .code(403)
        .send(envelope({ error: "Campaign contains contacts outside the operator grant" }, request.id));
    }

    const started = await scope.db.query(
      `update nova.campaigns set status = 'running', updated_at = now()
        where tenant_id = $1 and campaign_id = $2
          and channel in ('voice', 'mixed')
          and status in ('draft', 'ready', 'paused', 'running')
        returning campaign_id`,
      [scope.tenantId, campaignId]
    );
    if ((started.rowCount ?? 0) === 0) {
      return reply.code(409).send(envelope({ error: "Campaign not found or not startable" }, request.id));
    }

    const batch = await dispatchCampaignBatch(
      scope.db,
      scope.tenantId,
      campaignId,
      {
        voice: `${serviceUrls.voiceChannel.replace(/\/$/, "")}/v1/voice/internal/events`,
        audit: `${serviceUrls.audit.replace(/\/$/, "")}/internal/v1/events`
      },
      100
    );
    return envelope(
      {
        campaign_id: campaignId,
        status: "running",
        voice_calls_queued: batch.queued,
        voice_calls_blocked: batch.blocked
      },
      request.id
    );
  });

  for (const action of ["pause", "cancel"] as const) {
    app.post(`/v1/tenants/:tenantId/nova/campaigns/:id/${action}`, async (request, reply) => {
      const scope = requireTenantDb(context, request, reply);
      if (!scope) return;
      if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

      const campaignId = readUuid(request.params, "id");
      if (!campaignId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));
      const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
      if (!operator) return;
      if (await campaignHasContactsOutsideGrant(scope.db, scope.tenantId, campaignId, operator)) {
        return reply
          .code(403)
          .send(envelope({ error: "Campaign contains contacts outside the operator grant" }, request.id));
      }

      const status = action === "pause" ? "paused" : "cancelled";
      const result = await scope.db.query(
        `update nova.campaigns set status = $3, updated_at = now()
         where tenant_id = $1 and campaign_id = $2
           and ($3 = 'paused' and status = 'running'
                or $3 = 'cancelled' and status not in ('completed', 'cancelled'))
         returning campaign_id`,
        [scope.tenantId, campaignId, status]
      );
      if (result.rowCount === 0) {
        return reply.code(404).send(envelope({ error: "Campaign not found" }, request.id));
      }
      return envelope({ campaign_id: campaignId, status }, request.id);
    });
  }

  app.get("/v1/tenants/:tenantId/nova/leads", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;
    const productLine = readQueryString(request.query, "product_line");
    const result = await scope.db.query(
      `select lead_id, contact_id, stage, tipification, agency_code, product_line, owner_operator_id, created_at, updated_at
         from nova.leads
        where tenant_id = $1
          and ($2::boolean or agency_code = any($3::text[]))
          and ($4::text is null or product_line = $4)
        order by updated_at desc`,
      [scope.tenantId, operator.unrestricted, operator.agencyCodes, productLine ?? null]
    );
    return envelope(result.rows, request.id);
  });

  app.patch("/v1/tenants/:tenantId/nova/leads/:id", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const leadId = readUuid(request.params, "id");
    if (!leadId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));

    const parsed = leadPatchSchema.safeParse(request.body);
    if (
      !parsed.success ||
      (!parsed.data.stage && parsed.data.tipification === undefined && parsed.data.product_line === undefined)
    ) {
      return reply.code(400).send(envelope({ error: "stage, tipification or product_line required" }, request.id));
    }

    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const existing = await scope.db.query<{
      stage: string;
      tipification: string | null;
      product_line: string | null;
    }>(
      `select stage, tipification, product_line from nova.leads
        where tenant_id = $1 and lead_id = $2
          and ($3::boolean or agency_code = any($4::text[]))`,
      [scope.tenantId, leadId, operator.unrestricted, operator.agencyCodes]
    );
    if (existing.rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Lead not found" }, request.id));
    }

    const nextStage = parsed.data.stage ?? existing.rows[0]!.stage;
    const nextTipification = parsed.data.tipification ?? existing.rows[0]!.tipification ?? undefined;
    if (TERMINAL_CRM_STAGES.has(nextStage) && !nextTipification?.trim()) {
      return reply.code(400).send(
        envelope(
          {
            error: "tipification_required",
            detail: "Terminal stages (renovado, no_interes, won, lost) require tipification"
          },
          request.id
        )
      );
    }

    const correlationId = randomUUID();
    try {
      await scope.db.transaction(async (tx) => {
        const result = await tx.query<{ contactId: string; stage: string; tipification: string | null }>(
          `update nova.leads
           set stage = coalesce($3, stage),
               tipification = coalesce($4, tipification),
               product_line = coalesce($5, product_line),
               updated_at = now()
           where tenant_id = $1 and lead_id = $2
             and ($6::boolean or agency_code = any($7::text[]))
           returning contact_id as "contactId", stage, tipification`,
          [
            scope.tenantId,
            leadId,
            parsed.data.stage ?? null,
            parsed.data.tipification ?? null,
            parsed.data.product_line ?? null,
            operator.unrestricted,
            operator.agencyCodes
          ]
        );
        if (result.rowCount === 0) throw new Error("lead_not_found");

        const row = result.rows[0]!;
        const payload = leadQualifiedPayloadSchema.parse({
          lead_id: leadId,
          contact_id: row.contactId,
          stage: row.stage,
          tipification: row.tipification ?? undefined
        });
        await insertNovaAuditOutboxEvent(tx, {
          eventId: randomUUID(),
          domainEventType: "lead.qualified",
          entityType: "lead",
          entityId: leadId,
          tenantId: scope.tenantId,
          correlationId,
          businessIdempotencyKey: `lead:${scope.tenantId}:${leadId}:${row.stage}`,
          payload,
          destination: `${serviceUrls.audit.replace(/\/$/, "")}/internal/v1/events`
        });
      });
    } catch {
      return reply.code(404).send(envelope({ error: "Lead not found" }, request.id));
    }
    return envelope({ lead_id: leadId, ...parsed.data }, request.id);
  });

  app.get("/v1/tenants/:tenantId/nova/handoffs", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;
    const requestedAgency = readQueryString(request.query, "agency_code");
    if (requestedAgency && !operator.unrestricted && !operator.agencyCodes.includes(requestedAgency)) {
      return reply.code(403).send(envelope({ error: "Agency is outside the operator grant" }, request.id));
    }
    const agencyCodes = requestedAgency ? [requestedAgency] : operator.agencyCodes;
    const result =
      operator.unrestricted && !requestedAgency
        ? await scope.db.query(
            `select handoff_id, contact_id, agency_code, status, claimed_by, reason, created_at
             from nova.handoffs where tenant_id = $1 order by created_at desc`,
            [scope.tenantId]
          )
        : await scope.db.query(
            `select handoff_id, contact_id, agency_code, status, claimed_by, reason, created_at
             from nova.handoffs
            where tenant_id = $1 and agency_code = any($2::text[])
            order by created_at desc`,
            [scope.tenantId, agencyCodes]
          );

    return envelope(result.rows, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/handoffs/:id/claim", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const handoffId = readUuid(request.params, "id");
    if (!handoffId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));

    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid claim payload" }, request.id));
    }
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;
    if (!bodyOperatorMatches(parsed.data.operator_id, operator)) {
      return reply.code(403).send(envelope({ error: "operator_id does not match the verified identity" }, request.id));
    }

    const result = await scope.db.query(
      `update nova.handoffs
       set status = 'claimed', claimed_by = $3, claimed_at = now(), updated_at = now()
       where tenant_id = $1 and handoff_id = $2 and status = 'queued'
         and ($4::boolean or agency_code = any($5::text[]))
       returning handoff_id`,
      [scope.tenantId, handoffId, operator.operatorId, operator.unrestricted, operator.agencyCodes]
    );
    if (result.rowCount === 0) {
      return reply.code(409).send(envelope({ error: "Handoff unavailable" }, request.id));
    }
    return envelope({ handoff_id: handoffId, status: "claimed", operator_id: operator.operatorId }, request.id);
  });

  app.get("/v1/tenants/:tenantId/nova/conversations", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;
    const requestedCodes = readAgencyCodesQuery(request.query);
    if (requestedCodes.some((code) => !operator.unrestricted && !operator.agencyCodes.includes(code))) {
      return reply.code(403).send(envelope({ error: "Agency is outside the operator grant" }, request.id));
    }
    const agencyCodes = requestedCodes.length > 0 ? requestedCodes : operator.agencyCodes;
    const result =
      !operator.unrestricted || agencyCodes.length > 0
        ? await scope.db.query(
            `select conversation_id, contact_id, channel, agency_code, status, claimed_by, last_message_at
             from nova.conversations
             where tenant_id = $1 and agency_code = any($2::text[])
             order by coalesce(last_message_at, created_at) desc`,
            [scope.tenantId, agencyCodes]
          )
        : await scope.db.query(
            `select conversation_id, contact_id, channel, agency_code, status, claimed_by, last_message_at
             from nova.conversations where tenant_id = $1 order by coalesce(last_message_at, created_at) desc`,
            [scope.tenantId]
          );

    return envelope(result.rows, request.id);
  });

  app.get("/v1/tenants/:tenantId/nova/conversations/:id/messages", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const conversationId = readUuid(request.params, "id");
    if (!conversationId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const exists = await scope.db.query(
      `select 1 from nova.conversations
        where tenant_id = $1 and conversation_id = $2
          and ($3::boolean or agency_code = any($4::text[]))`,
      [scope.tenantId, conversationId, operator.unrestricted, operator.agencyCodes]
    );
    if (exists.rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Conversation not found" }, request.id));
    }

    const result = await scope.db.query(
      `select message_id, direction, body, kind, external_id, created_at
         from nova.conversation_messages
        where tenant_id = $1 and conversation_id = $2
        order by created_at asc
        limit 500`,
      [scope.tenantId, conversationId]
    );
    return envelope(result.rows, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/conversations/:id/claim", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const conversationId = readUuid(request.params, "id");
    if (!conversationId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));

    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid claim payload" }, request.id));
    }
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;
    if (!bodyOperatorMatches(parsed.data.operator_id, operator)) {
      return reply.code(403).send(envelope({ error: "operator_id does not match the verified identity" }, request.id));
    }

    const result = await scope.db.query(
      `update nova.conversations
       set status = 'claimed', claimed_by = $3, updated_at = now()
       where tenant_id = $1 and conversation_id = $2 and status = 'open'
         and ($4::boolean or agency_code = any($5::text[]))
       returning conversation_id`,
      [scope.tenantId, conversationId, operator.operatorId, operator.unrestricted, operator.agencyCodes]
    );
    if (result.rowCount === 0) {
      return reply.code(409).send(envelope({ error: "Conversation unavailable" }, request.id));
    }
    return envelope(
      { conversation_id: conversationId, status: "claimed", operator_id: operator.operatorId },
      request.id
    );
  });

  app.post("/v1/tenants/:tenantId/nova/conversations/:id/release", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const conversationId = readUuid(request.params, "id");
    if (!conversationId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const result = await scope.db.query(
      `update nova.conversations
          set status = 'open', claimed_by = null, updated_at = now()
        where tenant_id = $1 and conversation_id = $2 and status = 'claimed'
          and ($4::boolean or claimed_by = $3)
          and ($4::boolean or agency_code = any($5::text[]))
        returning conversation_id`,
      [scope.tenantId, conversationId, operator.operatorId, operator.unrestricted, operator.agencyCodes]
    );
    if (result.rowCount === 0) {
      return reply.code(409).send(envelope({ error: "Conversation not claimed or not found" }, request.id));
    }
    return envelope({ conversation_id: conversationId, status: "open", released: true }, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/conversations/:id/reply", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const conversationId = readUuid(request.params, "id");
    if (!conversationId) return reply.code(400).send(envelope({ error: "id must be a UUID" }, request.id));

    const parsed = replySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "text required" }, request.id));
    }
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const messageId = randomUUID();
    const correlationId = randomUUID();

    try {
      await scope.db.transaction(async (tx) => {
        const convo = await tx.query<{ contactId: string; phone: string }>(
          `update nova.conversations c
              set last_message_at = now(), updated_at = now()
             from nova.contacts ct
            where c.tenant_id = $1 and c.conversation_id = $2
              and ct.tenant_id = c.tenant_id and ct.contact_id = c.contact_id
              and ($3::boolean or c.agency_code = any($4::text[]))
              and ($3::boolean or c.claimed_by = $5)
            returning c.contact_id as "contactId", ct.phone_e164 as phone`,
          [scope.tenantId, conversationId, operator.unrestricted, operator.agencyCodes, operator.operatorId]
        );
        if (convo.rowCount === 0) throw new Error("conversation_not_found");

        const row = convo.rows[0]!;
        await tx.query(
          `insert into nova.conversation_messages
             (tenant_id, conversation_id, message_id, direction, body, kind, external_id)
           values ($1, $2, $3, 'outbound', $4, 'text', $5)
           on conflict (tenant_id, message_id) do nothing`,
          [scope.tenantId, conversationId, messageId, parsed.data.text, `reply:${messageId}`]
        );
        await insertNovaOutboxEvent(tx, {
          eventId: randomUUID(),
          eventType: "wa.send.requested",
          tenantId: scope.tenantId,
          correlationId,
          businessIdempotencyKey: `wa-reply:${scope.tenantId}:${conversationId}:${messageId}`,
          payload: waSendRequestedPayloadSchema.parse({
            message_id: messageId,
            contact_id: row.contactId,
            contact_ref: row.phone,
            mode: "text",
            text: parsed.data.text
          }),
          destination: `${serviceUrls.liwaChannel.replace(/\/$/, "")}/v1/liwa/internal/events`
        });
      });
    } catch {
      return reply.code(404).send(envelope({ error: "Conversation not found" }, request.id));
    }
    return envelope({ conversation_id: conversationId, message_id: messageId, queued: true }, request.id);
  });

  app.get("/v1/tenants/:tenantId/nova/core/associates/:documentId", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const documentId = readUuid(request.params, "documentId");
    if (!documentId) return reply.code(400).send(envelope({ error: "documentId must be a UUID" }, request.id));

    const associate = await dependencies.coreAdapter.lookupAssociate(documentId);
    if (!associate) {
      return reply.code(404).send(envelope({ error: "Associate not found for document" }, request.id));
    }

    return envelope(associate, request.id);
  });

  app.post("/v1/tenants/:tenantId/nova/outcomes", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const parsed = outcomeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid outcome payload" }, request.id));
    }

    const outcomeId = randomUUID();
    const correlationId = randomUUID();

    await scope.db.transaction(async (tx) => {
      await tx.query(
        `insert into nova.outcomes (tenant_id, outcome_id, contact_id, kind, payload)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [scope.tenantId, outcomeId, parsed.data.contact_id, parsed.data.kind, JSON.stringify(parsed.data.payload)]
      );

      const payload = coreOutcomeRecordedPayloadSchema.parse({
        outcome_id: outcomeId,
        contact_id: parsed.data.contact_id,
        kind: parsed.data.kind,
        score: typeof parsed.data.payload.score === "number" ? parsed.data.payload.score : undefined
      });
      await insertNovaAuditOutboxEvent(tx, {
        eventId: randomUUID(),
        domainEventType: "core.outcome.recorded",
        entityType: "outcome",
        entityId: outcomeId,
        tenantId: scope.tenantId,
        correlationId,
        businessIdempotencyKey: `outcome:${scope.tenantId}:${outcomeId}`,
        payload,
        destination: `${serviceUrls.audit.replace(/\/$/, "")}/internal/v1/events`
      });
    });

    return reply.code(201).send(envelope({ outcome_id: outcomeId }, request.id));
  });

  /** Ops Lab: simula webhook LIWA vía canal (secret server-side; no exponer en el browser). */
  app.post("/v1/tenants/:tenantId/nova/lab/liwa-event", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const parsed = labLiwaEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope({ error: "Invalid lab LIWA event", issues: parsed.error.issues }, request.id));
    }

    const phone = parsed.data.phone.trim().startsWith("+")
      ? parsed.data.phone.trim()
      : `+${parsed.data.phone.trim().replace(/\D/g, "")}`;
    const payload: Record<string, unknown> = {
      event: parsed.data.event,
      tenant_id: scope.tenantId,
      phone,
      phone_e164: phone,
      ciudad: parsed.data.ciudad,
      score: parsed.data.score,
      tipificacion: parsed.data.tipificacion,
      full_name: parsed.data.full_name ?? "Lab Demo",
      text: parsed.data.text ?? (parsed.data.event === "message" ? "Hola desde Lab" : undefined),
      external_id: `lab-${randomUUID()}`
    };

    const secret = process.env.LIWA_WEBHOOK_SECRET?.trim() ?? "";
    const allowInsecure =
      process.env.LIWA_WEBHOOK_ALLOW_INSECURE?.trim() === "1" &&
      (process.env.HYPERION_ENVIRONMENT?.trim() === "local" ||
        process.env.HYPERION_DEPLOYMENT_ENVIRONMENT?.trim() === "development");
    if (!secret && !allowInsecure) {
      return reply.code(503).send(
        envelope(
          {
            error: "LIWA_WEBHOOK_SECRET required for lab simulate (or LIWA_WEBHOOK_ALLOW_INSECURE=1 in local/dev)"
          },
          request.id
        )
      );
    }

    const url = `${serviceUrls.liwaChannel.replace(/\/$/, "")}/v1/liwa/webhooks/simulate`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-request-id": request.id
    };
    if (secret) headers["x-liwa-webhook-secret"] = secret;

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(8_000)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "LIWA simulate upstream unreachable";
      return reply.code(502).send(envelope({ error: message }, request.id));
    }

    const body = (await upstream.json().catch(() => undefined)) as
      { data?: Record<string, unknown>; error?: string } | undefined;
    if (!upstream.ok) {
      return reply
        .code(upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
        .send(
          envelope(
            { error: body?.data?.error ?? body?.error ?? `LIWA simulate failed (${upstream.status})` },
            request.id
          )
        );
    }

    return envelope(
      {
        ok: true,
        forwarded: true,
        ...(body?.data ?? body ?? {})
      },
      request.id
    );
  });

  /**
   * Estado de canal por conversación (webhook-first).
   * No hace poll a LIWA API; refleja handoff/CRM ya persistido en NOVA + link inbox.
   */
  app.get("/v1/tenants/:tenantId/nova/conversations/:conversationId/channel-status", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;

    const conversationId = readUuid(request.params, "conversationId");
    if (!conversationId) {
      return reply.code(400).send(envelope({ error: "conversationId must be a UUID" }, request.id));
    }

    const conv = await scope.db.query<{
      conversation_id: string;
      contact_id: string | null;
      agency_code: string | null;
      status: string;
      channel: string;
      claimed_by: string | null;
    }>(
      `select conversation_id, contact_id, agency_code, status, channel, claimed_by
         from nova.conversations
        where tenant_id = $1 and conversation_id = $2
          and ($3::boolean or agency_code = any($4::text[]))`,
      [scope.tenantId, conversationId, operator.unrestricted, operator.agencyCodes]
    );
    if (conv.rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Conversation not found" }, request.id));
    }
    const row = conv.rows[0]!;

    let phone: string | null = null;
    let handoffTag: string | null = null;
    if (row.contact_id) {
      const contact = await scope.db.query<{ phone_e164: string; agency_code: string | null }>(
        `select phone_e164, agency_code from nova.contacts where tenant_id = $1 and contact_id = $2`,
        [scope.tenantId, row.contact_id]
      );
      phone = contact.rows[0]?.phone_e164 ?? null;
      const agency = row.agency_code ?? contact.rows[0]?.agency_code ?? null;
      if (agency) {
        handoffTag = (await findAgencyRoutingTag(scope.db, scope.tenantId, agency)) ?? null;
      }
    }

    const handoff = row.contact_id
      ? await scope.db.query<{ handoff_id: string; status: string; agency_code: string }>(
          `select handoff_id, status, agency_code from nova.handoffs
            where tenant_id = $1 and contact_id = $2
            order by created_at desc nulls last limit 1`,
          [scope.tenantId, row.contact_id]
        )
      : { rows: [] as Array<{ handoff_id: string; status: string; agency_code: string }>, rowCount: 0 };

    const handoffRow = handoff.rows[0];
    const handoffDetected = Boolean(handoffRow && ["queued", "claimed"].includes(handoffRow.status));
    const accountId = process.env.LIWA_ACCOUNT_ID?.trim();

    return envelope(
      {
        ok: true,
        conversation_id: row.conversation_id,
        contact_id: row.contact_id,
        phone,
        status: row.status,
        channel: row.channel,
        claimed_by: row.claimed_by,
        handoff_detected: handoffDetected,
        handoff_id: handoffRow?.handoff_id,
        agency_code: handoffRow?.agency_code ?? row.agency_code,
        agency_hint: handoffTag,
        handoff_tags: handoffTag ? [handoffTag] : [],
        live_chat: handoffDetected,
        mode: "nova_db",
        poll_liwa: false,
        inbox_url: accountId ? `https://chat.liwa.co/?acc=${encodeURIComponent(accountId)}` : undefined,
        note: "Webhook-first: estado desde NOVA (no poll LIWA). Configure POST /v1/liwa/webhooks para sync en vivo."
      },
      request.id
    );
  });

  app.post("/v1/tenants/:tenantId/nova/bootstrap", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const parsed = bootstrapSchema.safeParse({
      ...(typeof request.body === "object" && request.body ? request.body : {}),
      tenant_id: scope.tenantId
    });
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid bootstrap payload" }, request.id));
    }

    const now = new Date();
    const payloadHash = createHash("sha256")
      .update(JSON.stringify({ tenant_id: parsed.data.tenant_id, display_name: parsed.data.display_name }))
      .digest("hex");

    await scope.db.transaction(async (tx) => {
      await tx.query(
        `insert into nova.tenant_snapshots (
           tenant_id, status, display_name, source_version, source_updated_at, payload_hash
         ) values ($1, 'active', $2, 1, $3, $4)
         on conflict (tenant_id) do update
         set display_name = excluded.display_name, updated_at = now()`,
        [parsed.data.tenant_id, parsed.data.display_name, now, payloadHash]
      );

      for (const agency of parsed.data.agencies) {
        await tx.query(
          `insert into nova.agencies (tenant_id, code, name, city, advisor_group, routing_tag)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (tenant_id, code) do update
           set name = excluded.name, city = excluded.city,
               advisor_group = excluded.advisor_group, routing_tag = excluded.routing_tag`,
          [
            parsed.data.tenant_id,
            agency.code,
            agency.name,
            agency.city,
            agency.advisor_group,
            agency.routing_tag ?? null
          ]
        );
      }

      for (const grant of parsed.data.operator_grants) {
        const grantHash = createHash("sha256").update(JSON.stringify(grant)).digest("hex");
        await tx.query(
          `insert into nova.operator_grants (
             operator_id, tenant_id, role, is_active, agency_codes,
             source_event_id, source_version, source_updated_at, payload_hash
           ) values ($1, $2, $3, $4, $5::text[], $6, 1, $7, $8)
           on conflict (operator_id, tenant_id) do update set
             role = excluded.role,
             is_active = excluded.is_active,
             agency_codes = excluded.agency_codes,
             source_event_id = excluded.source_event_id,
             source_version = nova.operator_grants.source_version + 1,
             source_updated_at = excluded.source_updated_at,
             payload_hash = excluded.payload_hash,
             updated_at = now()`,
          [
            grant.operator_id,
            parsed.data.tenant_id,
            grant.role,
            grant.is_active,
            grant.agency_codes,
            randomUUID(),
            now,
            grantHash
          ]
        );
      }
    });

    return reply.code(201).send(
      envelope(
        {
          tenant_id: parsed.data.tenant_id,
          display_name: parsed.data.display_name,
          agencies: parsed.data.agencies.length,
          operator_grants: parsed.data.operator_grants.length
        },
        request.id
      )
    );
  });

  app.get("/v1/tenants/:tenantId/nova/reviews", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const result = await scope.db.query(
      `select review_id, contact_id, call_id, status, intent, flow_id, created_at, updated_at
         from nova.whatsapp_reviews
        where tenant_id = $1
        order by created_at desc
        limit 200`,
      [scope.tenantId]
    );
    return envelope(result.rows, request.id);
  });

  /** Create a pending WhatsApp review (Lab / revisión post-llamada demo). */
  app.post("/v1/tenants/:tenantId/nova/reviews", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const parsed = z
      .object({
        phone_e164: z.string().min(8).max(20).optional(),
        contact_id: z.string().uuid().optional(),
        full_name: z.string().max(160).optional(),
        intent: z.string().max(80).optional(),
        flow_id: z.string().max(80).optional()
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "phone_e164 or contact_id required" }, request.id));
    }

    let contactId = parsed.data.contact_id;
    if (!contactId) {
      const phone = normalizeE164(parsed.data.phone_e164 ?? "");
      if (!phone) {
        return reply.code(400).send(envelope({ error: "phone_e164 or contact_id required" }, request.id));
      }
      contactId = await ensureContactFromRef(scope.db, scope.tenantId, undefined, phone, undefined);
      if (!contactId) {
        return reply.code(400).send(envelope({ error: "Unable to resolve contact" }, request.id));
      }
      if (parsed.data.full_name) {
        await scope.db.query(
          `update nova.contacts set full_name = coalesce($3, full_name), updated_at = now()
            where tenant_id = $1 and contact_id = $2`,
          [scope.tenantId, contactId, parsed.data.full_name]
        );
      }
    }

    const reviewId = randomUUID();
    const productFlow = await resolveProductFlowForContact(scope.db, scope.tenantId, contactId);
    const flowId = parsed.data.flow_id ?? (await resolveLiwaFlowId(scope.db, scope.tenantId, productFlow));
    await scope.db.query(
      `insert into nova.whatsapp_reviews (tenant_id, review_id, contact_id, status, intent, flow_id)
       values ($1, $2, $3, 'pending_review', $4, $5)`,
      [scope.tenantId, reviewId, contactId, parsed.data.intent ?? "interesado", flowId]
    );
    return reply.code(201).send(
      envelope(
        {
          review_id: reviewId,
          contact_id: contactId,
          status: "pending_review",
          intent: parsed.data.intent ?? "interesado",
          flow_id: flowId
        },
        request.id
      )
    );
  });

  app.post("/v1/tenants/:tenantId/nova/reviews/:reviewId/decide", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const reviewId = readUuid(request.params, "reviewId");
    if (!reviewId) return reply.code(400).send(envelope({ error: "reviewId must be a UUID" }, request.id));
    const parsed = reviewDecisionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send(envelope({ error: "Invalid review decision" }, request.id));
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;
    if (!bodyOperatorMatches(parsed.data.operator_id, operator)) {
      return reply.code(403).send(envelope({ error: "operator_id does not match the verified identity" }, request.id));
    }

    const liwaDestination = `${serviceUrls.liwaChannel.replace(/\/$/, "")}/v1/liwa/internal/events`;

    try {
      await scope.db.transaction(async (tx) => {
        const row = await tx.query<{
          contactId: string;
          phone: string;
          agencyCode: string | null;
          status: string;
        }>(
          `select r.contact_id as "contactId", c.phone_e164 as phone, c.agency_code as "agencyCode", r.status
             from nova.whatsapp_reviews r
             join nova.contacts c on c.tenant_id = r.tenant_id and c.contact_id = r.contact_id
            where r.tenant_id = $1 and r.review_id = $2
            for update of r`,
          [scope.tenantId, reviewId]
        );
        if (row.rowCount === 0) throw new Error("not_found");
        const review = row.rows[0]!;
        if (review.status !== "pending_review") throw new Error("not_pending");

        if (parsed.data.decision === "skip") {
          await tx.query(
            `update nova.whatsapp_reviews
                set status = 'skipped', decided_by = $3, decided_at = now(), updated_at = now()
              where tenant_id = $1 and review_id = $2`,
            [scope.tenantId, reviewId, operator.operatorId]
          );
          return;
        }

        const productFlow = await resolveProductFlowForContact(tx, scope.tenantId, review.contactId);
        const autoFlow = await resolveLiwaFlowId(tx, scope.tenantId, productFlow, {
          explicitFlowId: parsed.data.flow_id
        });
        const messageId = randomUUID();
        const agencyTag = await findAgencyRoutingTag(tx, scope.tenantId, review.agencyCode);
        await insertNovaOutboxEvent(tx, {
          eventId: randomUUID(),
          eventType: "wa.send.requested",
          tenantId: scope.tenantId,
          correlationId: randomUUID(),
          businessIdempotencyKey: `wa-send:${reviewId}`,
          payload: waSendRequestedPayloadSchema.parse({
            message_id: messageId,
            contact_id: review.contactId,
            contact_ref: review.phone,
            mode: "flow",
            flow_id: autoFlow,
            agency_tag: agencyTag,
            review_id: reviewId,
            product_flow: productFlow
          }),
          destination: liwaDestination
        });
        await tx.query(
          `update nova.whatsapp_reviews
              set status = 'approved', flow_id = $3, decided_by = $4, decided_at = now(), updated_at = now()
            where tenant_id = $1 and review_id = $2`,
          [scope.tenantId, reviewId, autoFlow, operator.operatorId]
        );
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "not_found") return reply.code(404).send(envelope({ error: "Review not found" }, request.id));
      if (message === "not_pending")
        return reply.code(409).send(envelope({ error: "Review is not pending" }, request.id));
      throw error;
    }

    return envelope({ review_id: reviewId, decision: parsed.data.decision }, request.id);
  });

  app.get("/v1/tenants/:tenantId/nova/analytics/daily", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    const result = await scope.db.query(
      `select day, channel, contacts_imported, calls_requested, calls_completed, calls_failed,
              wa_sent, leads_contacted, leads_interested, leads_won, leads_lost, handoffs_queued,
              csat_sum, csat_count
         from nova.analytics_daily
        where tenant_id = $1
        order by day desc
        limit 90`,
      [scope.tenantId]
    );
    return envelope(result.rows, request.id);
  });

  app.post("/internal/events", async (request, reply) => {
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const parsed = novaIngressEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope({ error: "Invalid event envelope", issues: parsed.error.issues }, request.id));
    }

    const event = parsed.data;
    try {
      const status = await acceptNovaInboxEvent(context.db, event, serviceUrls);
      return envelope({ status, event_id: event.event_id }, request.id);
    } catch (error) {
      if (error instanceof Error && error.message === "nova_inbox_event_conflict") {
        return reply.code(409).send(envelope({ error: "Event idempotency identity conflict" }, request.id));
      }
      throw error;
    }
  });

  app.get("/v1/tenants/:tenantId/nova/outbox/dlq", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const pendingOnly = readQueryString(request.query, "pending") === "true";
    const limitRaw = readQueryString(request.query, "limit");
    const limit = limitRaw ? Number(limitRaw) : 50;
    const rows = await listNovaOutboxDlq(scope.db, scope.tenantId, {
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

  app.get("/v1/tenants/:tenantId/nova/operations/readiness", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;
    const operator = await requireOperatorScope(scope.db, scope.tenantId, request, reply);
    if (!operator) return;
    if (operator.role !== "admin") {
      return reply.code(403).send(envelope({ error: "NOVA admin grant required" }, request.id));
    }

    const result = await scope.db.query<{
      pendingAged: string;
      failed: string;
      unresolvedDlq: string;
      runningCampaigns: string;
      eligibleEnrollments: string;
      currentPolicyApproval: boolean;
      currentExclusionRegistry: boolean;
      cutoverReceiptCount: string;
    }>(
      `select
         (select count(*)::text from nova.outbox_events
           where tenant_id = $1 and status = 'pending' and available_at < now() - interval '5 minutes') as "pendingAged",
         (select count(*)::text from nova.outbox_events
           where tenant_id = $1 and status = 'failed') as failed,
         (select count(*)::text from nova.outbox_dlq
           where tenant_id = $1 and redriven_at is null) as "unresolvedDlq",
         (select count(*)::text from nova.campaigns
           where tenant_id = $1 and status = 'running') as "runningCampaigns",
         (select count(*)::text from nova.campaign_enrollments e
           join nova.campaigns c on c.tenant_id = e.tenant_id and c.campaign_id = e.campaign_id
          where e.tenant_id = $1 and c.status = 'running'
            and e.status in ('enrolled', 'failed')
            and (e.next_attempt_at is null or e.next_attempt_at <= now())) as "eligibleEnrollments",
         exists (
           select 1 from nova.compliance_settings settings
           join nova.voice_policy_approvals approval
             on approval.tenant_id = settings.tenant_id
            and approval.policy_revision = settings.policy_revision
            and approval.status = 'approved'
            and (approval.expires_at is null or approval.expires_at > now())
          where settings.tenant_id = $1
         ) as "currentPolicyApproval",
         exists (
           select 1 from nova.exclusion_registry_runs
            where tenant_id = $1 and status = 'ready' and valid_until > now()
         ) as "currentExclusionRegistry",
         coalesce((select max(receipt_count)::text
           from (
             select count(distinct gate_name) as receipt_count
               from nova.voice_cutover_receipts
              where tenant_id = $1 and status = 'current' and expires_at > now()
              group by scope_sha256
           ) scoped_receipts), '0') as "cutoverReceiptCount"`,
      [scope.tenantId]
    );
    const row = result.rows[0]!;
    const metrics = {
      outbox_pending_aged: Number(row.pendingAged),
      outbox_failed: Number(row.failed),
      outbox_dlq_unresolved: Number(row.unresolvedDlq),
      campaigns_running: Number(row.runningCampaigns),
      enrollments_eligible: Number(row.eligibleEnrollments),
      voice_policy_approved: row.currentPolicyApproval ? 1 : 0,
      exclusion_registry_current: row.currentExclusionRegistry ? 1 : 0,
      cutover_receipts_current: Number(row.cutoverReceiptCount)
    };
    const blockers = [
      ...(metrics.voice_policy_approved === 0 ? ["voice_policy_unapproved"] : []),
      ...(metrics.exclusion_registry_current === 0 ? ["exclusion_registry_not_current"] : []),
      ...(metrics.cutover_receipts_current < 6 ? ["cutover_receipts_incomplete"] : [])
    ];
    const degraded =
      metrics.outbox_pending_aged > 0 ||
      metrics.outbox_failed > 0 ||
      metrics.outbox_dlq_unresolved > 0 ||
      blockers.length > 0;
    return envelope(
      {
        status: degraded ? "degraded" : "ok",
        measured_at: new Date().toISOString(),
        thresholds: { outbox_pending_age_seconds: 300, failed_or_dlq: 0 },
        metrics,
        blockers
      },
      request.id
    );
  });

  app.post("/v1/tenants/:tenantId/nova/outbox/dlq/:eventId/redrive", async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;
    if (!(await ensureTenantSnapshot(scope.db, scope.tenantId, request, reply))) return;

    const eventId = readUuid(request.params, "eventId");
    if (!eventId) return reply.code(400).send(envelope({ error: "eventId must be a UUID" }, request.id));

    const redriven = await redriveNovaOutboxDlq(scope.db, scope.tenantId, eventId);
    if (!redriven) {
      return reply.code(404).send(envelope({ error: "DLQ event not found for tenant" }, request.id));
    }

    return envelope({ event_id: eventId, status: "pending", redriven: true }, request.id);
  });
}

type NovaIngressEvent = z.infer<typeof novaIngressEventSchema>;

/**
 * Atomically claims, applies and marks a provider event. A crash rolls back
 * both the inbox receipt and every domain effect, so a retry can safely resume.
 */
export async function acceptNovaInboxEvent(
  db: DatabaseClient,
  event: NovaIngressEvent,
  serviceUrls: ReturnType<typeof readServiceUrls>
): Promise<"accepted" | "duplicate"> {
  const correlationId = event.correlation_id ?? randomUUID();
  const payload = JSON.stringify(event.payload);

  return db.transaction(async (tx) => {
    const inserted = await tx.query<{ eventId: string }>(
      `insert into nova.inbox_events (
         event_id, event_type, tenant_id, correlation_id, business_idempotency_key, payload
       ) values ($1, $2, $3, $4, $5, $6::jsonb)
       on conflict do nothing
       returning event_id as "eventId"`,
      [
        event.event_id,
        event.event_type,
        event.tenant_id,
        correlationId,
        event.business_idempotency_key ?? null,
        payload
      ]
    );

    let inboxEventId = inserted.rows[0]?.eventId;
    if (!inboxEventId) {
      const existing = await tx.query<{
        eventId: string;
        identityMatches: boolean;
        processedAt: Date | null;
      }>(
        `select event_id as "eventId",
                processed_at as "processedAt",
                (event_type = $2
                  and tenant_id is not distinct from $3::uuid
                  and business_idempotency_key is not distinct from $5::text
                  and payload = $6::jsonb) as "identityMatches"
           from nova.inbox_events
          where event_id = $1
             or ($5::text is not null and business_idempotency_key = $5::text)
          order by (event_id = $1) desc
          limit 1
          for update`,
        [
          event.event_id,
          event.event_type,
          event.tenant_id,
          correlationId,
          event.business_idempotency_key ?? null,
          payload
        ]
      );
      const row = existing.rows[0];
      if (!row?.identityMatches) throw new Error("nova_inbox_event_conflict");
      if (row.processedAt) return "duplicate";
      inboxEventId = row.eventId;
    }

    await processInboundEvent(tx, event.tenant_id, event.event_type, event.payload, serviceUrls);
    await tx.query(
      `update nova.inbox_events
          set processed_at = now()
        where event_id = $1 and processed_at is null`,
      [inboxEventId]
    );
    return "accepted";
  });
}

async function processInboundEvent(
  db: DatabaseExecutor,
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
  serviceUrls: ReturnType<typeof readServiceUrls>
): Promise<void> {
  if (eventType === "voice.call.dispatched") {
    const parsed = voiceCallDispatchedPayloadSchema.parse(payload);
    await db.query(
      `update nova.contact_attempts
          set status = 'dispatched'
        where tenant_id = $1 and call_id = $2 and status = 'queued'`,
      [tenantId, parsed.call_id]
    );
    await bumpAnalytics(db, tenantId, { calls_requested: 1 });
    return;
  }

  if (eventType === "voice.call.completed") {
    const parsed = voiceCallCompletedPayloadSchema.parse(payload);
    await db.query(
      `update nova.contact_attempts
          set status = $3
        where tenant_id = $1 and call_id = $2 and status in ('queued', 'dispatched')`,
      [tenantId, parsed.call_id, parsed.status === "failed" ? "failed" : "completed"]
    );
    if (parsed.status === "failed") {
      await bumpAnalytics(db, tenantId, { calls_failed: 1 });
      if (parsed.campaign_id) {
        await db.query(
          `update nova.campaign_enrollments
              set status = 'failed', next_attempt_at = null, updated_at = now()
            where tenant_id = $1 and campaign_id = $2 and contact_id = $3
              and status in ('enrolled', 'attempted', 'failed')`,
          [tenantId, parsed.campaign_id, parsed.contact_id]
        );
      }
      return;
    }
    const intent = inferIntentFromPayload({
      intent: parsed.intent,
      disposition: parsed.disposition,
      result_code: parsed.result_code,
      amd_label: parsed.amd_label,
      transcript_excerpt: parsed.transcript_excerpt
    });
    const stageInfo = stageFromPostCallIntent(intent);

    await db.query(
      `insert into nova.leads (tenant_id, lead_id, contact_id, stage, tipification, agency_code)
       select $1, $2, $3, $4, $5, c.agency_code
         from nova.contacts c
        where c.tenant_id = $1 and c.contact_id = $3
       on conflict do nothing`,
      [tenantId, randomUUID(), parsed.contact_id, stageInfo.stage, stageInfo.tipification ?? null]
    );

    await db.query(
      `update nova.leads
          set stage = $3, tipification = coalesce($4, tipification), updated_at = now()
        where tenant_id = $1 and contact_id = $2
          and stage not in ('renovado', 'no_interes', 'won', 'lost')`,
      [tenantId, parsed.contact_id, stageInfo.stage, stageInfo.tipification ?? null]
    );

    await bumpAnalytics(db, tenantId, {
      calls_completed: 1,
      calls_failed: 0,
      leads_contacted: 1,
      leads_interested: stageInfo.stage === "interesado" ? 1 : 0,
      leads_lost: stageInfo.stage === "no_interes" ? 1 : 0
    });

    if (parsed.campaign_id) {
      const enrollmentStatus = stageInfo.stage === "renovado" ? "converted" : "reached";
      await db.query(
        `update nova.campaign_enrollments
            set status = $4, updated_at = now()
          where tenant_id = $1 and campaign_id = $2 and contact_id = $3
            and status in ('enrolled', 'attempted', 'reached')`,
        [tenantId, parsed.campaign_id, parsed.contact_id, enrollmentStatus]
      );
    }

    if (stageInfo.wantsWhatsapp) {
      // Default ON: a positive classification may dispatch the tenant-configured LIWA flow.
      // Ops puede forzar revisión con POST_CALL_WHATSAPP_AUTO_SEND=false.
      const autoSend = (process.env.POST_CALL_WHATSAPP_AUTO_SEND ?? "true").toLowerCase() !== "false";

      // Anti-duplicado: tipificación manual o completed re-emitido no debe reenviar WA.
      const existingReview = await db.query(
        `select 1 from nova.whatsapp_reviews
          where tenant_id = $1 and call_id = $2
          limit 1`,
        [tenantId, parsed.call_id]
      );
      if ((existingReview.rowCount ?? 0) > 0) {
        return;
      }

      const reviewId = randomUUID();
      const productFlow = await resolveProductFlowForContact(db, tenantId, parsed.contact_id);
      const flowId = await resolveLiwaFlowId(db, tenantId, productFlow);

      await db.query(
        `insert into nova.whatsapp_reviews (tenant_id, review_id, contact_id, call_id, status, intent, flow_id)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          reviewId,
          parsed.contact_id,
          parsed.call_id,
          autoSend ? "approved" : "pending_review",
          intent,
          flowId
        ]
      );

      if (autoSend) {
        const contact = await db.query<{ phone: string; agencyCode: string | null }>(
          `select phone_e164 as phone, agency_code as "agencyCode"
             from nova.contacts where tenant_id = $1 and contact_id = $2`,
          [tenantId, parsed.contact_id]
        );
        const row = contact.rows[0];
        if (row) {
          await insertNovaOutboxEvent(db, {
            eventId: randomUUID(),
            eventType: "wa.send.requested",
            tenantId,
            correlationId: randomUUID(),
            businessIdempotencyKey: `wa-send-auto:${parsed.call_id}`,
            payload: waSendRequestedPayloadSchema.parse({
              message_id: randomUUID(),
              contact_id: parsed.contact_id,
              contact_ref: row.phone,
              mode: "flow",
              flow_id: flowId,
              agency_tag: await findAgencyRoutingTag(db, tenantId, row.agencyCode),
              review_id: reviewId,
              product_flow: productFlow
            }),
            destination: `${serviceUrls.liwaChannel.replace(/\/$/, "")}/v1/liwa/internal/events`
          });
        }
      }
    }
    return;
  }

  if (eventType === "wa.message.sent") {
    const parsed = waMessageSentPayloadSchema.parse(payload);
    await bumpAnalytics(db, tenantId, { wa_sent: 1 });
    if (parsed.contact_id) {
      await db.query(
        `update nova.whatsapp_reviews set status = 'sent', updated_at = now()
          where tenant_id = $1 and contact_id = $2 and status = 'approved'`,
        [tenantId, parsed.contact_id]
      );
      const conversationId = await upsertWhatsappConversation(db, tenantId, parsed.contact_id);
      if (parsed.text?.trim() && conversationId) {
        await insertConversationMessage(db, {
          tenantId,
          conversationId,
          messageId: parsed.message_id,
          direction: "outbound",
          body: parsed.text.trim(),
          kind: "text",
          externalId: parsed.provider_ref ? `liwa-out:${parsed.provider_ref}` : `wa-sent:${parsed.message_id}`
        });
      }
    }
    return;
  }

  if (eventType === "wa.message.received") {
    const parsed = waMessageReceivedPayloadSchema.parse(payload);
    const contactId = await ensureContactFromRef(
      db,
      tenantId,
      parsed.contact_id,
      parsed.contact_ref,
      parsed.agency_code
    );
    if (!contactId) {
      throw new Error("wa.message.received requires resolvable contact_id or contact_ref phone");
    }
    const conversationId = await upsertWhatsappConversation(db, tenantId, contactId, parsed.agency_code);
    if (!conversationId) return;
    await insertConversationMessage(db, {
      tenantId,
      conversationId,
      messageId: parsed.message_id,
      direction: "inbound",
      body: parsed.text,
      kind: parsed.kind ?? "text",
      externalId: parsed.external_id
    });
    await db.query(
      `update nova.contacts
          set voice_suppressed_at = coalesce(voice_suppressed_at, now()),
              voice_suppression_reason = 'whatsapp_engaged',
              eligibility = 'blocked_policy',
              updated_at = now()
        where tenant_id = $1 and contact_id = $2`,
      [tenantId, contactId]
    );
    await db.query(
      `update nova.campaign_enrollments
          set status = 'reached', last_block_reason = 'whatsapp_engaged', updated_at = now()
        where tenant_id = $1 and contact_id = $2 and status in ('enrolled', 'failed')`,
      [tenantId, contactId]
    );
    return;
  }

  if (eventType === "document.received" || eventType === "document.validated") {
    const parsed =
      eventType === "document.received"
        ? documentReceivedPayloadSchema.parse(payload)
        : documentValidatedPayloadSchema.parse(payload);
    const contactId = parsed.contact_id;
    if (contactId) {
      await upsertLeadStage(db, tenantId, contactId, "documento", "doc_recibido");
    }
    return;
  }

  if (eventType === "wa.prequal.completed") {
    const parsed = prequalCompletedPayloadSchema.parse(payload);
    const contactId = await resolveContactId(db, tenantId, parsed.contact_id, parsed.contact_ref);
    if (contactId) await upsertLeadStage(db, tenantId, contactId, "interesado", "prequal_liwa");
    return;
  }

  if (eventType === "csat.recorded") {
    const parsed = csatRecordedPayloadSchema.parse(payload);
    const contactId = await resolveContactId(db, tenantId, parsed.contact_id, parsed.contact_ref);
    await db.query(
      `insert into nova.csat_scores (tenant_id, csat_id, contact_id, score, channel, note)
       values ($1, $2, $3, $4, $5, $6)`,
      [tenantId, randomUUID(), contactId ?? null, parsed.score, parsed.channel ?? "whatsapp", parsed.note ?? null]
    );
    await bumpAnalytics(db, tenantId, { csat_sum: parsed.score, csat_count: 1 });
    return;
  }

  if (eventType === "contact.opt_out") {
    const parsed = optOutPayloadSchema.parse(payload);
    const contactId = await resolveContactId(db, tenantId, parsed.contact_id, parsed.contact_ref);
    if (contactId) {
      const phone = await db.query<{ phone: string }>(
        `select phone_e164 as phone from nova.contacts where tenant_id = $1 and contact_id = $2`,
        [tenantId, contactId]
      );
      if (phone.rows[0]) {
        await db.query(
          `insert into nova.opt_outs (tenant_id, phone_e164, contact_id, reason, source)
           values ($1, $2, $3, $4, 'liwa')
           on conflict (tenant_id, phone_e164) do nothing`,
          [tenantId, phone.rows[0].phone, contactId, parsed.reason ?? "opt_out"]
        );
      }
      await db.query(
        `update nova.contacts set opted_out = true, eligibility = 'blocked_opt_out', updated_at = now()
          where tenant_id = $1 and contact_id = $2`,
        [tenantId, contactId]
      );
      await upsertLeadStage(db, tenantId, contactId, "no_interes", "opt_out");
      await db.query(
        `update nova.campaign_enrollments
            set status = 'opted_out', updated_at = now()
          where tenant_id = $1 and contact_id = $2 and status not in ('converted', 'opted_out')`,
        [tenantId, contactId]
      );
    }
    return;
  }

  if (eventType === "handoff.requested") {
    const parsed = handoffRequestedPayloadSchema.parse(payload);
    const agencyCode = parsed.agency_code;
    const contactId = await ensureContactFromRef(db, tenantId, parsed.contact_id, parsed.contact_ref, agencyCode);
    if (!contactId) {
      throw new Error("handoff.requested requires resolvable contact_id or contact_ref phone");
    }
    await db.query(
      `insert into nova.handoffs (tenant_id, handoff_id, contact_id, agency_code, status, reason)
       values ($1, $2, $3, $4, 'queued', $5)
       on conflict (tenant_id, handoff_id) do nothing`,
      [tenantId, parsed.handoff_id, contactId, agencyCode, parsed.reason ?? null]
    );
    await upsertLeadStage(db, tenantId, contactId, "transferido", "handoff_liwa");
    await bumpAnalytics(db, tenantId, { handoffs_queued: 1 });
    return;
  }

  if (eventType === "crm.tipificacion.recorded") {
    const tipificacion = String(payload.tipificacion ?? "").trim();
    if (!tipificacion) return;
    const contactId = await ensureContactFromRef(
      db,
      tenantId,
      typeof payload.contact_id === "string" ? payload.contact_id : undefined,
      typeof payload.contact_ref === "string" ? payload.contact_ref : undefined
    );
    if (!contactId) return;
    const stageRaw = typeof payload.stage === "string" ? payload.stage : undefined;
    const stage = (stageRaw as CrmStage | undefined) ?? "contactado";
    await upsertLeadStage(db, tenantId, contactId, stage, tipificacion);
  }
}

async function upsertWhatsappConversation(
  db: DatabaseExecutor,
  tenantId: string,
  contactId: string,
  agencyCodeHint?: string
): Promise<string | undefined> {
  const existing = await db.query<{ conversation_id: string }>(
    `select conversation_id from nova.conversations
      where tenant_id = $1 and contact_id = $2 and channel = 'whatsapp'
        and status in ('open', 'claimed')
      order by coalesce(last_message_at, created_at) desc
      limit 1`,
    [tenantId, contactId]
  );
  if (existing.rowCount && existing.rows[0]) {
    await db.query(
      `update nova.conversations
          set last_message_at = now(), updated_at = now(),
              agency_code = coalesce(agency_code, $3)
        where tenant_id = $1 and conversation_id = $2`,
      [tenantId, existing.rows[0].conversation_id, agencyCodeHint ?? null]
    );
    return existing.rows[0].conversation_id;
  }

  const agency = await db.query<{ agency_code: string | null }>(
    `select agency_code from nova.contacts where tenant_id = $1 and contact_id = $2`,
    [tenantId, contactId]
  );
  const conversationId = randomUUID();
  await db.query(
    `insert into nova.conversations (tenant_id, conversation_id, contact_id, channel, agency_code, status, last_message_at)
     values ($1, $2, $3, 'whatsapp', $4, 'open', now())`,
    [tenantId, conversationId, contactId, agencyCodeHint ?? agency.rows[0]?.agency_code ?? null]
  );
  return conversationId;
}

async function insertConversationMessage(
  db: DatabaseExecutor,
  input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    direction: "inbound" | "outbound";
    body: string;
    kind: "text" | "document" | "system";
    externalId?: string;
  }
): Promise<void> {
  if (input.externalId) {
    const dup = await db.query(
      `select 1 from nova.conversation_messages
        where tenant_id = $1 and external_id = $2`,
      [input.tenantId, input.externalId]
    );
    if (dup.rowCount && dup.rowCount > 0) return;
  }

  await db.query(
    `insert into nova.conversation_messages
       (tenant_id, conversation_id, message_id, direction, body, kind, external_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, message_id) do nothing`,
    [
      input.tenantId,
      input.conversationId,
      input.messageId,
      input.direction,
      input.body,
      input.kind,
      input.externalId ?? null
    ]
  );
  await db.query(
    `update nova.conversations
        set last_message_at = now(), updated_at = now()
      where tenant_id = $1 and conversation_id = $2`,
    [input.tenantId, input.conversationId]
  );
}

async function resolveContactId(
  db: DatabaseExecutor,
  tenantId: string,
  contactId?: string,
  contactRef?: string
): Promise<string | undefined> {
  if (contactId) return contactId;
  if (!contactRef) return undefined;
  const byPhone = await db.query<{ contactId: string }>(
    `select contact_id as "contactId" from nova.contacts
      where tenant_id = $1 and (phone_e164 = $2 or contact_id::text = $2)
      limit 1`,
    [tenantId, contactRef]
  );
  return byPhone.rows[0]?.contactId;
}

async function ensureContactFromRef(
  db: DatabaseExecutor,
  tenantId: string,
  contactId?: string,
  contactRef?: string,
  agencyCode?: string
): Promise<string | undefined> {
  const existing = await resolveContactId(db, tenantId, contactId, contactRef);
  if (existing) return existing;
  const phone = contactRef ? normalizeE164(contactRef) : null;
  if (!phone) return undefined;
  const id = randomUUID();
  await db.query(
    `insert into nova.contacts (tenant_id, contact_id, phone_e164, agency_code, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (tenant_id, phone_e164) do update
     set agency_code = coalesce(excluded.agency_code, nova.contacts.agency_code),
         updated_at = now()`,
    [tenantId, id, phone, agencyCode ?? null]
  );
  const resolved = await resolveContactId(db, tenantId, undefined, phone);
  return resolved ?? id;
}

async function upsertLeadStage(
  db: DatabaseExecutor,
  tenantId: string,
  contactId: string,
  stage: CrmStage,
  tipification?: string
): Promise<void> {
  const existing = await db.query<{ leadId: string; stage: string }>(
    `select lead_id as "leadId", stage from nova.leads
      where tenant_id = $1 and contact_id = $2
      order by updated_at desc limit 1`,
    [tenantId, contactId]
  );
  if (existing.rowCount === 0) {
    await db.query(
      `insert into nova.leads (tenant_id, lead_id, contact_id, stage, tipification)
       values ($1, $2, $3, $4, $5)`,
      [tenantId, randomUUID(), contactId, stage, tipification ?? null]
    );
    return;
  }
  const current = existing.rows[0]!;
  const from = (current.stage as CrmStage) || "pendiente";
  if (!canTransitionCrm(from, stage) && from !== stage) return;
  await db.query(
    `update nova.leads set stage = $3, tipification = coalesce($4, tipification), updated_at = now()
      where tenant_id = $1 and lead_id = $2`,
    [tenantId, current.leadId, stage, tipification ?? null]
  );
}

async function bumpAnalytics(
  db: DatabaseExecutor,
  tenantId: string,
  deltas: Partial<Record<string, number>>
): Promise<void> {
  const localDay = await db.query<{ day: string }>(
    `select timezone(
              coalesce((select time_zone from nova.compliance_settings where tenant_id = $1), 'America/Bogota'),
              now()
            )::date::text as day`,
    [tenantId]
  );
  const day = localDay.rows[0]?.day ?? new Date().toISOString().slice(0, 10);
  await db.query(
    `insert into nova.analytics_daily (
       tenant_id, day, channel, contacts_imported, calls_requested, calls_completed, calls_failed,
       wa_sent, leads_contacted, leads_interested, leads_won, leads_lost, handoffs_queued, csat_sum, csat_count
     ) values ($1, $2::date, 'all', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (tenant_id, day, channel) do update set
       contacts_imported = nova.analytics_daily.contacts_imported + excluded.contacts_imported,
       calls_requested = nova.analytics_daily.calls_requested + excluded.calls_requested,
       calls_completed = nova.analytics_daily.calls_completed + excluded.calls_completed,
       calls_failed = nova.analytics_daily.calls_failed + excluded.calls_failed,
       wa_sent = nova.analytics_daily.wa_sent + excluded.wa_sent,
       leads_contacted = nova.analytics_daily.leads_contacted + excluded.leads_contacted,
       leads_interested = nova.analytics_daily.leads_interested + excluded.leads_interested,
       leads_won = nova.analytics_daily.leads_won + excluded.leads_won,
       leads_lost = nova.analytics_daily.leads_lost + excluded.leads_lost,
       handoffs_queued = nova.analytics_daily.handoffs_queued + excluded.handoffs_queued,
       csat_sum = nova.analytics_daily.csat_sum + excluded.csat_sum,
       csat_count = nova.analytics_daily.csat_count + excluded.csat_count`,
    [
      tenantId,
      day,
      deltas.contacts_imported ?? 0,
      deltas.calls_requested ?? 0,
      deltas.calls_completed ?? 0,
      deltas.calls_failed ?? 0,
      deltas.wa_sent ?? 0,
      deltas.leads_contacted ?? 0,
      deltas.leads_interested ?? 0,
      deltas.leads_won ?? 0,
      deltas.leads_lost ?? 0,
      deltas.handoffs_queued ?? 0,
      deltas.csat_sum ?? 0,
      deltas.csat_count ?? 0
    ]
  );
}

async function upsertImportedContact(
  tx: DatabaseExecutor,
  tenantId: string,
  row: ContactImportRow,
  auditBaseUrl: string
): Promise<string> {
  const contactId = randomUUID();
  const existing = await tx.query<{ contactId: string }>(
    `select contact_id as "contactId"
       from nova.contacts
      where tenant_id = $1 and phone_e164 = $2`,
    [tenantId, row.phone_e164]
  );
  const resolvedId = existing.rows[0]?.contactId ?? contactId;

  await tx.query(
    `insert into nova.contacts (
       tenant_id, contact_id, phone_e164, full_name, agency_code, segment,
       cupo_preaprobado, mora_actual, saldo_total, universidad, documento, email, ciudad, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     on conflict (tenant_id, phone_e164) do update set
       full_name = coalesce(excluded.full_name, nova.contacts.full_name),
       agency_code = coalesce(excluded.agency_code, nova.contacts.agency_code),
       segment = coalesce(excluded.segment, nova.contacts.segment),
       cupo_preaprobado = coalesce(excluded.cupo_preaprobado, nova.contacts.cupo_preaprobado),
       mora_actual = coalesce(excluded.mora_actual, nova.contacts.mora_actual),
       saldo_total = coalesce(excluded.saldo_total, nova.contacts.saldo_total),
       universidad = coalesce(excluded.universidad, nova.contacts.universidad),
       documento = coalesce(excluded.documento, nova.contacts.documento),
       email = coalesce(excluded.email, nova.contacts.email),
       ciudad = coalesce(excluded.ciudad, nova.contacts.ciudad),
       updated_at = now()`,
    [
      tenantId,
      resolvedId,
      row.phone_e164,
      row.full_name ?? null,
      row.agency_code ?? null,
      row.segment ?? null,
      row.cupo_preaprobado ?? null,
      row.mora_actual ?? null,
      row.saldo_total ?? null,
      row.universidad ?? null,
      row.documento ?? null,
      row.email ?? null,
      row.ciudad ?? null
    ]
  );

  const payload = contactImportedPayloadSchema.parse({
    contact_id: resolvedId,
    phone_e164: row.phone_e164,
    agency_code: row.agency_code,
    full_name_masked: row.full_name ? maskName(row.full_name) : undefined
  });
  await insertNovaAuditOutboxEvent(tx, {
    eventId: randomUUID(),
    domainEventType: "contact.imported",
    entityType: "contact",
    entityId: resolvedId,
    tenantId,
    correlationId: randomUUID(),
    businessIdempotencyKey: `contact-import:${tenantId}:${row.phone_e164}`,
    payload,
    destination: `${auditBaseUrl.replace(/\/$/, "")}/internal/v1/events`
  });

  return resolvedId;
}

async function upsertAgentConfig(
  db: DatabaseClient,
  tenantId: string,
  config: z.infer<typeof agentConfigSchema>
): Promise<void> {
  await db.query(
    `insert into nova.agent_configs (
       tenant_id, product_flow, elevenlabs_agent_id, elevenlabs_phone_number_id,
       liwa_flow_id, from_number_e164, lead_context_templates, is_active, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, coalesce($8, true), now())
     on conflict (tenant_id, product_flow) do update set
       elevenlabs_agent_id = excluded.elevenlabs_agent_id,
       elevenlabs_phone_number_id = excluded.elevenlabs_phone_number_id,
       liwa_flow_id = excluded.liwa_flow_id,
       from_number_e164 = excluded.from_number_e164,
       lead_context_templates = excluded.lead_context_templates,
       is_active = coalesce(excluded.is_active, nova.agent_configs.is_active),
       updated_at = now()`,
    [
      tenantId,
      config.product_flow,
      config.elevenlabs_agent_id,
      config.elevenlabs_phone_number_id,
      config.liwa_flow_id ?? null,
      config.from_number_e164 ?? null,
      JSON.stringify(config.lead_context_templates),
      config.is_active ?? null
    ]
  );
}

function readProductFlow(params: unknown): string | undefined {
  const value =
    typeof params === "object" && params && "productFlow" in params
      ? (params as { productFlow?: unknown }).productFlow
      : undefined;
  const parsed = productFlowSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function findAgencyRoutingTag(
  db: DatabaseExecutor,
  tenantId: string,
  agencyCode?: string | null
): Promise<string | undefined> {
  if (!agencyCode) return undefined;
  const result = await db.query<{ routing_tag: string | null }>(
    `select routing_tag from nova.agencies where tenant_id = $1 and code = $2`,
    [tenantId, agencyCode]
  );
  return result.rows[0]?.routing_tag ?? undefined;
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

async function ensureTenantSnapshot(
  db: DatabaseClient,
  tenantId: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const result = await db.query<{ status: string }>(`select status from nova.tenant_snapshots where tenant_id = $1`, [
    tenantId
  ]);
  if (result.rowCount === 0) {
    void reply.code(404).send(envelope({ error: "Tenant snapshot not found; bootstrap required" }, request.id));
    return false;
  }
  if (result.rows[0]?.status !== "active") {
    void reply.code(409).send(envelope({ error: "Tenant is not active" }, request.id));
    return false;
  }
  return true;
}

function readUuid(params: unknown, key: string): string | undefined {
  const value =
    typeof params === "object" && params && key in params ? (params as Record<string, unknown>)[key] : undefined;
  const parsed = tenantIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function readQueryString(query: unknown, key: string): string | undefined {
  if (typeof query !== "object" || !query || !(key in query)) return undefined;
  const value = (query as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAgencyCodesQuery(query: unknown): string[] {
  const raw = readQueryString(query, "agency_codes");
  if (!raw) return [];
  return raw
    .split(",")
    .map((code) => code.trim())
    .filter(Boolean);
}

interface OperatorScope {
  operatorId: string;
  role: "admin" | "supervisor" | "asesor";
  agencyCodes: string[];
  unrestricted: boolean;
}

async function requireOperatorScope(
  db: DatabaseExecutor,
  tenantId: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<OperatorScope | undefined> {
  const operatorId = readHeaderString(request.headers["x-operator-id"]);
  const parsedId = tenantIdSchema.safeParse(operatorId);
  if (!parsedId.success) {
    void reply.code(403).send(envelope({ error: "Verified operator identity required" }, request.id));
    return undefined;
  }
  const grant = await db.query<{ role: OperatorScope["role"]; agencyCodes: string[] }>(
    `select role, agency_codes as "agencyCodes"
       from nova.operator_grants
      where tenant_id = $1 and operator_id = $2 and is_active = true`,
    [tenantId, parsedId.data]
  );
  const row = grant.rows[0];
  if (!row) {
    void reply.code(403).send(envelope({ error: "Active NOVA operator grant required" }, request.id));
    return undefined;
  }
  return {
    operatorId: parsedId.data,
    role: row.role,
    agencyCodes: row.agencyCodes,
    unrestricted: row.role === "admin"
  };
}

async function campaignHasContactsOutsideGrant(
  db: DatabaseExecutor,
  tenantId: string,
  campaignId: string,
  operator: OperatorScope
): Promise<boolean> {
  if (operator.unrestricted) return false;
  const result = await db.query(
    `select 1
       from nova.campaign_enrollments e
       join nova.contacts c
         on c.tenant_id = e.tenant_id and c.contact_id = e.contact_id
      where e.tenant_id = $1 and e.campaign_id = $2
        and not (c.agency_code = any($3::text[]))
      limit 1`,
    [tenantId, campaignId, operator.agencyCodes]
  );
  return (result.rowCount ?? 0) > 0;
}

function readHeaderString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length === 1 && value[0]?.trim()) return value[0].trim();
  return undefined;
}

function bodyOperatorMatches(bodyOperatorId: string | undefined, scope: OperatorScope): boolean {
  return bodyOperatorId === undefined || bodyOperatorId === scope.operatorId;
}

function maskName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "***";
  return `${parts[0]!.slice(0, 1)}***`;
}
