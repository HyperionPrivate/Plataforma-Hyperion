import { envelope, tenantIdSchema } from "@hyperion/platform-contracts";
import type { DatabaseClient } from "@hyperion/database";
import {
  pulsoSofiaConversationContextRequestSchema,
  pulsoSofiaConversationContextResultSchema,
  pulsoSofiaInboundLookupRequestSchema,
  pulsoSofiaInboundLookupResultSchema
} from "@hyperion/pulso-contracts";
import { validateInternalAuthorization, type RouteRegistrar, type ServiceContext } from "@hyperion/service-runtime";
import { z } from "zod";

const CONFIRMATION_EXECUTION_LEASE_MS = 5 * 60 * 1_000;

const uuid = z.string().uuid();
const jsonObject = z.record(z.string(), z.unknown());
const emptyQuerySchema = z.object({}).strict();

const tenantConversationParams = z.object({
  tenantId: tenantIdSchema,
  conversationId: uuid
});

const persistOutboundSchema = z
  .object({
    conversationId: uuid,
    body: z.string().min(1).max(4096),
    externalMessageId: z.string().min(1).max(512),
    metadata: jsonObject.default({})
  })
  .strict();

const sofiaRuntimeSchema = z
  .object({
    sofiaStatus: z.string().min(1).max(64),
    primaryIntent: z.string().min(1).max(128).optional()
  })
  .strict();

const confirmableToolSchema = z.enum(["create_appointment_hold", "cancel_appointment", "reschedule_appointment"]);
const confirmationExecutionSchema = z
  .object({
    actionId: uuid,
    tool: confirmableToolSchema,
    arguments: jsonObject,
    confirmationMessageId: uuid,
    claimedAt: z.string().datetime()
  })
  .strict();

const claimPendingActionMutationSchema = z
  .object({
    op: z.literal("claim_pending_action"),
    pendingJobId: uuid,
    pendingTool: confirmableToolSchema,
    patientId: uuid,
    confirmationMessageId: uuid,
    confirmationBody: z.string().min(1).max(4096),
    execution: confirmationExecutionSchema
  })
  .strict();

const mutationSchema = z
  .discriminatedUnion("op", [
    claimPendingActionMutationSchema,
    z.object({
      op: z.literal("move_execution_to_grant"),
      executionActionId: z.string().min(1),
      confirmationMessageId: uuid,
      executionTool: z.string().min(1),
      grant: jsonObject
    }),
    z.object({
      op: z.literal("store_execution_receipt"),
      executionActionId: z.string().min(1),
      confirmationMessageId: uuid,
      executionTool: z.string().min(1),
      receipt: jsonObject
    }),
    z.object({
      op: z.literal("store_pending_receipt"),
      pendingJobId: uuid,
      pendingTool: z.string().min(1),
      currentMessageId: uuid,
      receipt: jsonObject
    }),
    z.object({
      op: z.literal("store_grant_receipt"),
      grantActionId: z.string().min(1),
      holdId: uuid,
      currentMessageId: uuid,
      confirmationMessageId: uuid.nullable().optional(),
      receipt: jsonObject
    }),
    z.object({ op: z.literal("save_conversation_state"), patch: jsonObject }),
    z.object({ op: z.literal("save_availability_state"), availabilityPatch: jsonObject, selection: jsonObject }),
    z.object({ op: z.literal("clear_last_availability") }),
    z.object({
      op: z.literal("stage_pending_action"),
      expectedPendingJobId: uuid.nullable(),
      expectedGrantActionId: z.string().nullable(),
      patch: jsonObject
    }),
    z.object({ op: z.literal("replace_pending_with_grant"), pendingJobId: uuid, patch: jsonObject }),
    z.object({ op: z.literal("clear_confirmed_grant"), actionId: z.string().min(1), holdId: uuid }),
    z.object({ op: z.literal("clear_confirmed_pending"), actionId: z.string().min(1) })
  ])
  .superRefine((mutation, context) => {
    if (mutation.op !== "claim_pending_action") return;
    if (mutation.execution.actionId !== mutation.pendingJobId) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["execution", "actionId"], message: "actionId mismatch" });
    }
    if (mutation.execution.tool !== mutation.pendingTool) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["execution", "tool"], message: "tool mismatch" });
    }
    if (mutation.execution.confirmationMessageId !== mutation.confirmationMessageId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["execution", "confirmationMessageId"],
        message: "confirmationMessageId mismatch"
      });
    }
  });

export function registerSofiaOwnerRoutes(
  app: Parameters<RouteRegistrar>[0],
  context: ServiceContext,
  sofiaCredential: string | undefined
): void {
  const authorize = (headers: Parameters<typeof validateInternalAuthorization>[0]) =>
    validateInternalAuthorization(headers, { "agent-service": sofiaCredential });

  app.post("/internal/v1/tenants/:tenantId/pulso-iris/sofia/inbound-message", async (request, reply) => {
    const authError = authorize(request.headers);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const params = z.object({ tenantId: tenantIdSchema }).strict().safeParse(request.params);
    const query = emptyQuerySchema.safeParse(request.query);
    const body = pulsoSofiaInboundLookupRequestSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) {
      return reply.code(400).send(envelope({ error: "Invalid sofia inbound lookup request" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const found = await context.db.query<{
      id: string;
      sender: string;
      body: string;
      conversationStatus: string;
    }>(
      `select m.id, m.sender, m.body, c.status as "conversationStatus"
         from pulso_iris.messages m
         join pulso_iris.conversations c
           on c.tenant_id = m.tenant_id
          and c.id = m.conversation_id
        where m.tenant_id = $1
          and m.conversation_id = $2
          and m.id = $3
          and m.sender = 'patient'
          and c.patient_id = $4`,
      [params.data.tenantId, body.data.conversationId, body.data.messageId, body.data.patientId]
    );
    const row = found.rows[0];
    const result = pulsoSofiaInboundLookupResultSchema.parse(
      row
        ? {
            found: true,
            tenantId: params.data.tenantId,
            conversationId: body.data.conversationId,
            patientId: body.data.patientId,
            conversationStatus: row.conversationStatus,
            message: { id: row.id, sender: row.sender, body: row.body }
          }
        : { found: false }
    );
    return envelope(result, request.id);
  });

  app.post("/internal/v1/tenants/:tenantId/pulso-iris/sofia/conversation-context", async (request, reply) => {
    const authError = authorize(request.headers);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const params = z.object({ tenantId: tenantIdSchema }).strict().safeParse(request.params);
    const query = emptyQuerySchema.safeParse(request.query);
    const body = pulsoSofiaConversationContextRequestSchema.safeParse(request.body);
    if (!params.success || !query.success || !body.success) {
      return reply.code(400).send(envelope({ error: "Invalid sofia conversation context request" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const conversation = await context.db.query<{
      sofiaState: unknown;
      patientName: string | null;
      history: unknown;
    }>(
      `select coalesce(c.metadata->'sofiaState', '{}'::jsonb) as "sofiaState",
              p.full_name as "patientName",
              coalesce((
                select jsonb_agg(
                  jsonb_build_object('sender', recent.sender, 'body', recent.body)
                  order by recent.created_at, recent.id
                )
                  from (
                    select m.id, m.sender, m.body, m.created_at
                      from pulso_iris.messages m
                     where m.tenant_id = c.tenant_id
                       and m.conversation_id = c.id
                     order by m.created_at desc, m.id desc
                     limit 12
                  ) recent
              ), '[]'::jsonb) as history
         from pulso_iris.conversations c
         left join pulso_iris.administrative_patients p
           on p.tenant_id = c.tenant_id
          and p.id = c.patient_id
        where c.tenant_id = $1
          and c.id = $2
          and c.patient_id = $3`,
      [params.data.tenantId, body.data.conversationId, body.data.patientId]
    );
    if (!conversation.rows[0]) {
      return reply.code(404).send(envelope({ error: "SOFIA conversation context not found" }, request.id));
    }
    const result = pulsoSofiaConversationContextResultSchema.parse({
      tenantId: params.data.tenantId,
      conversationId: body.data.conversationId,
      patientId: body.data.patientId,
      patientName: conversation.rows[0].patientName,
      sofiaState: conversation.rows[0].sofiaState,
      history: conversation.rows[0].history
    });
    return envelope(result, request.id);
  });

  app.post("/internal/v1/tenants/:tenantId/pulso-iris/messages/sofia-outbound", async (request, reply) => {
    const authError = authorize(request.headers);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const params = z.object({ tenantId: tenantIdSchema }).safeParse(request.params);
    const body = persistOutboundSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(envelope({ error: "Invalid sofia outbound message request" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const inserted = await context.db.query<{ id: string; body: string }>(
      `insert into pulso_iris.messages
         (tenant_id, conversation_id, sender, body, provider, external_message_id, delivery_status, metadata)
       values ($1, $2, 'sofia', $3, 'whatsapp_web_test', $4, 'queued', $5::jsonb)
       on conflict (tenant_id, provider, external_message_id)
         where provider is not null and external_message_id is not null
       do update set body = pulso_iris.messages.body
       returning id, body`,
      [
        params.data.tenantId,
        body.data.conversationId,
        body.data.body,
        body.data.externalMessageId,
        JSON.stringify(body.data.metadata)
      ]
    );
    return envelope(inserted.rows[0]!, request.id);
  });

  app.patch(
    "/internal/v1/tenants/:tenantId/pulso-iris/conversations/:conversationId/sofia-runtime",
    async (request, reply) => {
      const authError = authorize(request.headers);
      if (authError) {
        return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
      }
      const params = tenantConversationParams.safeParse(request.params);
      const body = sofiaRuntimeSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(envelope({ error: "Invalid sofia runtime patch" }, request.id));
      }
      if (!context.db) {
        return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
      }

      await context.db.query(
        `update pulso_iris.conversations
         set metadata = metadata || jsonb_build_object('sofiaStatus', $3::text, 'lastSofiaActivityAt', now()),
             primary_intent = coalesce($4, primary_intent), updated_at = now()
         where tenant_id = $1 and id = $2`,
        [params.data.tenantId, params.data.conversationId, body.data.sofiaStatus, body.data.primaryIntent ?? null]
      );
      return envelope({ updated: true }, request.id);
    }
  );

  app.post(
    "/internal/v1/tenants/:tenantId/pulso-iris/conversations/:conversationId/sofia-state/load",
    async (request, reply) => {
      const authError = authorize(request.headers);
      if (authError) {
        return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
      }
      const params = tenantConversationParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send(envelope({ error: "Invalid sofia state load request" }, request.id));
      }
      if (!context.db) {
        return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
      }

      const state = await loadConfirmationState(context.db, params.data.tenantId, params.data.conversationId);
      return envelope(state, request.id);
    }
  );

  app.post(
    "/internal/v1/tenants/:tenantId/pulso-iris/conversations/:conversationId/sofia-state/mutate",
    async (request, reply) => {
      const authError = authorize(request.headers);
      if (authError) {
        return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
      }
      const params = tenantConversationParams.safeParse(request.params);
      const body = mutationSchema.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(envelope({ error: "Invalid sofia state mutation" }, request.id));
      }
      if (!context.db) {
        return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
      }

      const applied = await applySofiaStateMutationInternal(
        context.db,
        params.data.tenantId,
        params.data.conversationId,
        body.data
      );
      return envelope({ applied }, request.id);
    }
  );
}

type SofiaStateMutation = z.infer<typeof mutationSchema>;

export async function applySofiaStateMutation(
  db: DatabaseClient,
  tenantId: string,
  conversationId: string,
  mutation: SofiaStateMutation | Record<string, unknown>
): Promise<boolean> {
  const parsed = mutationSchema.safeParse(mutation);
  if (!parsed.success) return false;
  return applySofiaStateMutationInternal(db, tenantId, conversationId, parsed.data);
}

async function applySofiaStateMutationInternal(
  db: DatabaseClient,
  tenantId: string,
  conversationId: string,
  mutation: SofiaStateMutation
): Promise<boolean> {
  switch (mutation.op) {
    case "claim_pending_action": {
      const result = await db.query(
        `update pulso_iris.conversations c
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb) || jsonb_build_object(
             'pendingAction', null,
             'confirmationGrant', null,
             'confirmationExecution', $5::jsonb
           )
         ), updated_at = now()
         where c.tenant_id = $1 and c.id = $2
           and c.patient_id = $6
           and metadata #>> '{sofiaState,pendingAction,jobId}' = $3
           and metadata #>> '{sofiaState,pendingAction,tool}' = $4
           and coalesce(metadata #> '{sofiaState,confirmationExecution}', 'null'::jsonb) = 'null'::jsonb
           and coalesce(metadata #> '{sofiaState,confirmationGrant}', 'null'::jsonb) = 'null'::jsonb
           and exists (
             select 1
               from pulso_iris.messages m
              where m.tenant_id = c.tenant_id
                and m.conversation_id = c.id
                and m.id = $7
                and m.sender = 'patient'
                and m.body = $8
                and btrim(regexp_replace(
                      translate(lower(m.body), 'áéíóúüñ', 'aeiouun'),
                      '[^a-z0-9]+', ' ', 'g'
                    )) ~ '^(si )?confirmo( (agendar|reservar|cancelar|reagendar|la cita|el cambio))?$'
           )`,
        [
          tenantId,
          conversationId,
          mutation.pendingJobId,
          mutation.pendingTool,
          JSON.stringify(mutation.execution),
          mutation.patientId,
          mutation.confirmationMessageId,
          mutation.confirmationBody
        ]
      );
      return (result.rowCount ?? 0) > 0;
    }
    case "move_execution_to_grant": {
      const result = await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb) || jsonb_build_object(
             'pendingAction', null,
             'confirmationExecution', null,
             'confirmationGrant', $6::jsonb
           )
         ), updated_at = now()
         where tenant_id = $1 and id = $2
           and metadata #>> '{sofiaState,confirmationExecution,actionId}' = $3
           and metadata #>> '{sofiaState,confirmationExecution,confirmationMessageId}' = $4
           and metadata #>> '{sofiaState,confirmationExecution,tool}' = $5`,
        [
          tenantId,
          conversationId,
          mutation.executionActionId,
          mutation.confirmationMessageId,
          mutation.executionTool,
          JSON.stringify(mutation.grant)
        ]
      );
      return (result.rowCount ?? 0) > 0;
    }
    case "store_execution_receipt": {
      const result = await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'sofiaState',
           (coalesce(metadata->'sofiaState', '{}'::jsonb)
             - 'lastAvailability'
             - 'lastAvailabilityAt'
             - 'lastAvailabilitySchemaVersion'
             - 'lastAvailabilityJobId'
             - 'lastAvailabilityQuery')
             || jsonb_build_object(
                  'pendingAction', null,
                  'confirmationExecution', null,
                  'confirmationGrant', null,
                  'confirmationReceipts',
                    coalesce(metadata #> '{sofiaState,confirmationReceipts}', '{}'::jsonb)
                      || jsonb_build_object($4::text, $6::jsonb)
                )
         ), updated_at = now()
         where tenant_id = $1 and id = $2
           and metadata #>> '{sofiaState,confirmationExecution,actionId}' = $3
           and metadata #>> '{sofiaState,confirmationExecution,confirmationMessageId}' = $4
           and metadata #>> '{sofiaState,confirmationExecution,tool}' = $5`,
        [
          tenantId,
          conversationId,
          mutation.executionActionId,
          mutation.confirmationMessageId,
          mutation.executionTool,
          JSON.stringify(mutation.receipt)
        ]
      );
      return (result.rowCount ?? 0) > 0;
    }
    case "store_pending_receipt": {
      const result = await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'sofiaState',
           (coalesce(metadata->'sofiaState', '{}'::jsonb)
             - 'lastAvailability'
             - 'lastAvailabilityAt'
             - 'lastAvailabilitySchemaVersion'
             - 'lastAvailabilityJobId'
             - 'lastAvailabilityQuery')
             || jsonb_build_object(
                  'pendingAction', null,
                  'confirmationExecution', null,
                  'confirmationGrant', null,
                  'confirmationReceipts',
                    coalesce(metadata #> '{sofiaState,confirmationReceipts}', '{}'::jsonb)
                      || jsonb_build_object($4::text, $6::jsonb)
                )
         ), updated_at = now()
         where tenant_id = $1 and id = $2
           and metadata #>> '{sofiaState,pendingAction,jobId}' = $3
           and metadata #>> '{sofiaState,pendingAction,tool}' = $5`,
        [
          tenantId,
          conversationId,
          mutation.pendingJobId,
          mutation.currentMessageId,
          mutation.pendingTool,
          JSON.stringify(mutation.receipt)
        ]
      );
      return (result.rowCount ?? 0) > 0;
    }
    case "store_grant_receipt": {
      const result = await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'sofiaState',
           (coalesce(metadata->'sofiaState', '{}'::jsonb)
             - 'lastAvailability'
             - 'lastAvailabilityAt'
             - 'lastAvailabilitySchemaVersion'
             - 'lastAvailabilityJobId'
             - 'lastAvailabilityQuery')
             || jsonb_build_object(
                  'pendingAction', null,
                  'confirmationExecution', null,
                  'confirmationGrant', null,
                  'confirmationReceipts',
                    coalesce(metadata #> '{sofiaState,confirmationReceipts}', '{}'::jsonb)
                      || jsonb_build_object($4::text, $6::jsonb)
                )
         ), updated_at = now()
         where tenant_id = $1 and id = $2
           and coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                        metadata #>> '{sofiaState,confirmationGrant,jobId}') = $3
           and ($7::text is null
                or metadata #>> '{sofiaState,confirmationGrant,confirmationMessageId}' = $7)
           and metadata #>> '{sofiaState,confirmationGrant,holdId}' = $5`,
        [
          tenantId,
          conversationId,
          mutation.grantActionId,
          mutation.currentMessageId,
          mutation.holdId,
          JSON.stringify(mutation.receipt),
          mutation.confirmationMessageId ?? null
        ]
      );
      return (result.rowCount ?? 0) > 0;
    }
    case "save_conversation_state": {
      await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb) || $3::jsonb),
           updated_at = now()
         where tenant_id = $1 and id = $2`,
        [tenantId, conversationId, JSON.stringify(mutation.patch)]
      );
      return true;
    }
    case "save_availability_state": {
      await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb)
             || $3::jsonb
             || jsonb_build_object(
                  'agendaSelection',
                  coalesce(metadata #> '{sofiaState,agendaSelection}', '{}'::jsonb) || $4::jsonb
                )
         ), updated_at = now()
         where tenant_id = $1 and id = $2`,
        [tenantId, conversationId, JSON.stringify(mutation.availabilityPatch), JSON.stringify(mutation.selection)]
      );
      return true;
    }
    case "clear_last_availability": {
      await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb)
             - 'lastAvailability'
             - 'lastAvailabilityAt'
             - 'lastAvailabilitySchemaVersion'
             - 'lastAvailabilityJobId'
             - 'lastAvailabilityQuery'
         ), updated_at = now()
         where tenant_id = $1 and id = $2`,
        [tenantId, conversationId]
      );
      return true;
    }
    case "stage_pending_action": {
      const updated = await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb) || $5::jsonb),
           updated_at = now()
         where tenant_id = $1 and id = $2
           and coalesce(metadata #> '{sofiaState,confirmationExecution}', 'null'::jsonb) = 'null'::jsonb
           and (($3::text is null
                 and coalesce(metadata #> '{sofiaState,pendingAction}', 'null'::jsonb) = 'null'::jsonb)
                or metadata #>> '{sofiaState,pendingAction,jobId}' = $3)
           and (($4::text is null
                 and coalesce(metadata #> '{sofiaState,confirmationGrant}', 'null'::jsonb) = 'null'::jsonb)
                or coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                            metadata #>> '{sofiaState,confirmationGrant,jobId}') = $4)`,
        [
          tenantId,
          conversationId,
          mutation.expectedPendingJobId,
          mutation.expectedGrantActionId,
          JSON.stringify(mutation.patch)
        ]
      );
      return (updated.rowCount ?? 0) > 0;
    }
    case "replace_pending_with_grant": {
      await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb) || $4::jsonb),
           updated_at = now()
         where tenant_id = $1 and id = $2
           and metadata #>> '{sofiaState,pendingAction,jobId}' = $3`,
        [tenantId, conversationId, mutation.pendingJobId, JSON.stringify(mutation.patch)]
      );
      return true;
    }
    case "clear_confirmed_grant": {
      await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb)
             || jsonb_build_object('confirmationGrant', null, 'pendingAction', null)),
           updated_at = now()
         where tenant_id = $1 and id = $2
           and coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                        metadata #>> '{sofiaState,confirmationGrant,jobId}') = $3
           and metadata #>> '{sofiaState,confirmationGrant,holdId}' = $4`,
        [tenantId, conversationId, mutation.actionId, mutation.holdId]
      );
      return true;
    }
    case "clear_confirmed_pending": {
      await db.query(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
           coalesce(metadata->'sofiaState', '{}'::jsonb)
             || jsonb_build_object('pendingAction', null, 'confirmationGrant', null)),
           updated_at = now()
         where tenant_id = $1 and id = $2
           and metadata #>> '{sofiaState,pendingAction,jobId}' = $3`,
        [tenantId, conversationId, mutation.actionId]
      );
      return true;
    }
  }
}

export async function loadConfirmationState(db: DatabaseClient, tenantId: string, conversationId: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await db.query<{
      state: unknown;
      pendingExpired: boolean;
      grantExpired: boolean;
      executionExpired: boolean;
    }>(
      `select coalesce(metadata->'sofiaState', '{}'::jsonb) as state,
              coalesce((metadata #>> '{sofiaState,pendingAction,stagedAt}')::timestamptz
                + interval '15 minutes' <= now(), false) as "pendingExpired",
              coalesce((metadata #>> '{sofiaState,confirmationGrant,expiresAt}')::timestamptz
                <= now(), false) as "grantExpired",
              coalesce((metadata #>> '{sofiaState,confirmationExecution,claimedAt}')::timestamptz
                + ($3::int * interval '1 millisecond') <= now(), false) as "executionExpired"
       from pulso_iris.conversations
       where tenant_id = $1 and id = $2`,
      [tenantId, conversationId, CONFIRMATION_EXECUTION_LEASE_MS]
    );
    const row = result.rows[0];
    const state = asRecord(row?.state);
    const confirmationExecution = asRecord(state.confirmationExecution);
    const pendingAction = asRecord(state.pendingAction);
    const confirmationGrant = asRecord(state.confirmationGrant);

    if (row?.executionExpired && confirmationExecution) {
      const tool = String(confirmationExecution.tool ?? "");
      const action =
        tool === "cancel_appointment" ? "cancel" : tool === "reschedule_appointment" ? "reschedule" : "book";
      const receipt = {
        schemaVersion: 1,
        confirmationMessageId: String(confirmationExecution.confirmationMessageId ?? ""),
        actionId: String(confirmationExecution.actionId ?? ""),
        action,
        outcome: "terminal_failure",
        completedAt: new Date().toISOString(),
        code: "confirmation_execution_expired",
        message:
          "La operación quedó sin evidencia concluyente. Consulta el estado actual antes de intentar otra acción."
      };
      const clearedExecution = await db.query<{ state: unknown }>(
        `update pulso_iris.conversations
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
           'sofiaState',
           (coalesce(metadata->'sofiaState', '{}'::jsonb)
             - 'lastAvailability'
             - 'lastAvailabilityAt'
             - 'lastAvailabilitySchemaVersion'
             - 'lastAvailabilityJobId'
             - 'lastAvailabilityQuery')
             || jsonb_build_object(
                  'confirmationExecution', null,
                  'confirmationGrant', null,
                  'confirmationReceipts',
                    coalesce(metadata #> '{sofiaState,confirmationReceipts}', '{}'::jsonb)
                      || jsonb_build_object($4::text, $8::jsonb)
                )
         ), updated_at = now()
         where tenant_id = $1 and id = $2
           and metadata #>> '{sofiaState,confirmationExecution,actionId}' = $3
           and metadata #>> '{sofiaState,confirmationExecution,confirmationMessageId}' = $4
           and metadata #>> '{sofiaState,confirmationExecution,tool}' = $5
           and metadata #>> '{sofiaState,confirmationExecution,claimedAt}' = $6
           and (metadata #>> '{sofiaState,confirmationExecution,claimedAt}')::timestamptz
             + ($7::int * interval '1 millisecond') <= now()
         returning coalesce(metadata->'sofiaState', '{}'::jsonb) as state`,
        [
          tenantId,
          conversationId,
          String(confirmationExecution.actionId ?? ""),
          String(confirmationExecution.confirmationMessageId ?? ""),
          String(confirmationExecution.tool ?? ""),
          String(confirmationExecution.claimedAt ?? ""),
          CONFIRMATION_EXECUTION_LEASE_MS,
          JSON.stringify(receipt)
        ]
      );
      if (clearedExecution.rows[0]) return { state: clearedExecution.rows[0].state };
      continue;
    }

    const expiredPending = row?.pendingExpired ? pendingAction : undefined;
    const expiredGrant = row?.grantExpired ? confirmationGrant : undefined;
    if (!expiredPending && !expiredGrant) {
      return { state: row?.state ?? {} };
    }

    const patch = {
      ...(expiredPending ? { pendingAction: null } : {}),
      ...(expiredGrant ? { confirmationGrant: null } : {})
    };
    const cleared = await db.query<{ state: unknown }>(
      `update pulso_iris.conversations
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaState',
         coalesce(metadata->'sofiaState', '{}'::jsonb) || $8::jsonb),
         updated_at = now()
       where tenant_id = $1 and id = $2
         and ($3::text is null or (
           metadata #>> '{sofiaState,pendingAction,jobId}' = $3
           and metadata #>> '{sofiaState,pendingAction,stagedAt}' = $4
           and (metadata #>> '{sofiaState,pendingAction,stagedAt}')::timestamptz
             + interval '15 minutes' <= now()
         ))
         and ($5::text is null or (
           coalesce(metadata #>> '{sofiaState,confirmationGrant,actionId}',
                    metadata #>> '{sofiaState,confirmationGrant,jobId}') = $5
           and metadata #>> '{sofiaState,confirmationGrant,holdId}' = $6
           and metadata #>> '{sofiaState,confirmationGrant,expiresAt}' = $7
           and (metadata #>> '{sofiaState,confirmationGrant,expiresAt}')::timestamptz <= now()
         ))
       returning coalesce(metadata->'sofiaState', '{}'::jsonb) as state`,
      [
        tenantId,
        conversationId,
        expiredPending ? String(expiredPending.jobId ?? "") : null,
        expiredPending ? String(expiredPending.stagedAt ?? "") : null,
        expiredGrant ? String(expiredGrant.actionId ?? expiredGrant.jobId ?? "") : null,
        expiredGrant ? String(expiredGrant.holdId ?? "") : null,
        expiredGrant ? String(expiredGrant.expiresAt ?? "") : null,
        JSON.stringify(patch)
      ]
    );
    if (cleared.rows[0]) {
      return {
        state: cleared.rows[0].state,
        expiredAction: expiredPending
          ? { actionId: String(expiredPending.jobId ?? ""), tool: String(expiredPending.tool ?? "") }
          : expiredGrant
            ? {
                actionId: String(expiredGrant.actionId ?? expiredGrant.jobId ?? ""),
                tool: "create_appointment_hold"
              }
            : undefined
      };
    }
  }
  return { state: {} };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
