import { envelope, tenantIdSchema } from "@hyperion/contracts";
import type { DatabaseExecutor } from "@hyperion/database";
import { validateInternalAuthorization, type RouteRegistrar, type ServiceContext } from "@hyperion/service-runtime";
import { z } from "zod";

const uuid = z.string().uuid();

const deliveryParams = z.object({
  tenantId: tenantIdSchema,
  messageId: uuid
});

const deliveryUpdateSchema = z
  .discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.literal("sent"),
        provider: z.literal("whatsapp_web_test"),
        providerMessageId: z.string().min(1).max(512)
      })
      .strict(),
    z
      .object({
        outcome: z.literal("failed")
      })
      .strict(),
    z
      .object({
        outcome: z.literal("uncertain"),
        provider: z.literal("whatsapp_web_test").optional(),
        providerMessageId: z.string().min(1).max(512).optional()
      })
      .strict(),
    z
      .object({
        outcome: z.literal("reconcile"),
        provider: z.literal("whatsapp_web_test"),
        providerMessageId: z.string().min(1).max(512),
        status: z.enum(["delivered", "read", "failed"]),
        occurredAt: z.string().datetime({ offset: true })
      })
      .strict(),
    z
      .object({
        outcome: z.literal("cancel_source")
      })
      .strict()
  ])
  .superRefine((update, context) => {
    if (
      update.outcome === "uncertain" &&
      (update.provider === undefined) !== (update.providerMessageId === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider and providerMessageId must be supplied together"
      });
    }
  });

const messageGuardSchema = z
  .object({
    conversationId: uuid,
    body: z.string().min(1).max(4096),
    expectedDeliveryStatus: z.literal("queued").default("queued")
  })
  .strict();

export function registerChannelDeliveryRoutes(
  app: Parameters<RouteRegistrar>[0],
  context: ServiceContext,
  channelCredential: string | undefined
): void {
  const authorize = (headers: Parameters<typeof validateInternalAuthorization>[0]) =>
    validateInternalAuthorization(headers, { "whatsapp-channel-service": channelCredential });

  app.get("/internal/v1/tenants/:tenantId/pulso-iris/messages/:messageId/delivery-guard", async (request, reply) => {
    const authError = authorize(request.headers);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const params = deliveryParams.safeParse(request.params);
    const query = messageGuardSchema.safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send(envelope({ error: "Invalid delivery guard request" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query<{
      id: string;
      conversationId: string;
      sender: string;
      body: string;
      provider: string | null;
      deliveryStatus: string | null;
    }>(
      `select id, conversation_id as "conversationId", sender, body, provider,
              delivery_status as "deliveryStatus"
         from pulso_iris.messages
        where tenant_id = $1 and id = $2`,
      [params.data.tenantId, params.data.messageId]
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send(envelope({ error: "Message not found" }, request.id));
    }
    const matches =
      row.conversationId === query.data.conversationId &&
      row.sender === "sofia" &&
      row.provider === "whatsapp_web_test" &&
      row.deliveryStatus === query.data.expectedDeliveryStatus &&
      row.body === query.data.body;
    return envelope(
      {
        messageId: row.id,
        conversationId: row.conversationId,
        sender: row.sender,
        body: row.body,
        provider: row.provider,
        deliveryStatus: row.deliveryStatus,
        matches
      },
      request.id
    );
  });

  app.post("/internal/v1/tenants/:tenantId/pulso-iris/messages/:messageId/delivery", async (request, reply) => {
    const authError = authorize(request.headers);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const params = deliveryParams.safeParse(request.params);
    const body = deliveryUpdateSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(envelope({ error: "Invalid delivery update" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const updated = await applyDeliveryUpdate(context.db, params.data.tenantId, params.data.messageId, body.data);
    return envelope({ updated }, request.id);
  });
}

export type DeliveryUpdate = z.infer<typeof deliveryUpdateSchema>;

export type DeliveryUpdateApplicationResult = "updated" | "target_not_found" | "identity_conflict";

export async function applyDeliveryUpdate(
  db: DatabaseExecutor,
  tenantId: string,
  messageId: string,
  update: DeliveryUpdate
): Promise<boolean> {
  return (await applyDeliveryUpdateResult(db, tenantId, messageId, update)) === "updated";
}

export async function applyDeliveryUpdateResult(
  db: DatabaseExecutor,
  tenantId: string,
  messageId: string,
  update: DeliveryUpdate
): Promise<DeliveryUpdateApplicationResult> {
  try {
    return await applyDeliveryUpdateResultUnchecked(db, tenantId, messageId, update);
  } catch (error) {
    if (isProviderIdentityUniqueViolation(error)) return "identity_conflict";
    throw error;
  }
}

async function applyDeliveryUpdateResultUnchecked(
  db: DatabaseExecutor,
  tenantId: string,
  messageId: string,
  update: DeliveryUpdate
): Promise<DeliveryUpdateApplicationResult> {
  switch (update.outcome) {
    case "sent": {
      const result = await db.query(
        `update pulso_iris.messages
            set provider = coalesce(provider, $3),
                provider_message_id = coalesce(provider_message_id, $4),
                delivery_status = case
                  when delivery_status in ('failed', 'delivered', 'read') then delivery_status
                  when delivery_status = 'queued' then 'sent'
                  else delivery_status
                end
          where tenant_id = $1 and id = $2
            and (provider is null or provider = $3)
            and (provider_message_id is null or provider_message_id = $4)`,
        [tenantId, messageId, update.provider, update.providerMessageId]
      );
      return (result.rowCount ?? 0) > 0 ? "updated" : classifyIdentityMiss(db, tenantId, messageId);
    }
    case "failed":
    case "cancel_source": {
      const result = await db.query(
        `update pulso_iris.messages
            set delivery_status = case
              when delivery_status in ('delivered', 'read') then delivery_status
              else 'failed'
            end
          where tenant_id = $1 and id = $2`,
        [tenantId, messageId]
      );
      return (result.rowCount ?? 0) > 0 ? "updated" : "target_not_found";
    }
    case "uncertain": {
      const result = await db.query(
        `update pulso_iris.messages
         set provider = coalesce(provider, $3::text),
             provider_message_id = coalesce(provider_message_id, $4::text),
             delivery_status = case
               when delivery_status in ('delivered', 'read') then delivery_status
               else 'failed'
             end,
             metadata = case
               when delivery_status in ('delivered', 'read')
                 then coalesce(metadata, '{}'::jsonb) - 'deliveryReconciliationRequired'
               else coalesce(metadata, '{}'::jsonb)
                 || '{"deliveryReconciliationRequired":true}'::jsonb
             end
         where tenant_id = $1 and id = $2
           and ($3::text is null or provider is null or provider = $3::text)
           and ($4::text is null or provider_message_id is null or provider_message_id = $4::text)`,
        [tenantId, messageId, update.provider ?? null, update.providerMessageId ?? null]
      );
      return (result.rowCount ?? 0) > 0 ? "updated" : classifyIdentityMiss(db, tenantId, messageId);
    }
    case "reconcile": {
      const result = await db.query(
        `update pulso_iris.messages
         set provider = coalesce(provider, $3),
             provider_message_id = coalesce(provider_message_id, $4),
             delivery_status = case
               when delivery_status = 'read' then 'read'
               when $5 = 'read' then 'read'
               when delivery_status = 'delivered' then 'delivered'
               when $5 = 'delivered' then 'delivered'
               when $5 = 'failed' then 'failed'
               else delivery_status
             end,
             delivered_at = case
               when $5 in ('delivered', 'read') and (delivered_at is null or $6::timestamptz < delivered_at)
                 then $6::timestamptz
               else delivered_at
             end,
             metadata = coalesce(metadata, '{}'::jsonb) - 'deliveryReconciliationRequired'
         where tenant_id = $1 and id = $2
           and (provider is null or provider = $3)
           and (provider_message_id is null or provider_message_id = $4)`,
        [tenantId, messageId, update.provider, update.providerMessageId, update.status, update.occurredAt]
      );
      return (result.rowCount ?? 0) > 0 ? "updated" : classifyIdentityMiss(db, tenantId, messageId);
    }
  }
}

async function classifyIdentityMiss(
  db: DatabaseExecutor,
  tenantId: string,
  messageId: string
): Promise<"target_not_found" | "identity_conflict"> {
  const existing = await db.query<{ exists: boolean }>(
    `select exists(
       select 1 from pulso_iris.messages where tenant_id = $1 and id = $2
     ) as exists`,
    [tenantId, messageId]
  );
  return existing.rows[0]?.exists ? "identity_conflict" : "target_not_found";
}

function isProviderIdentityUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === "uq_pulso_iris_messages_outbound_provider";
}
