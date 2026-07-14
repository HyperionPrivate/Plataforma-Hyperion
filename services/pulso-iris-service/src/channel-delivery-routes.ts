import { envelope, tenantIdSchema } from "@hyperion/contracts";
import type { DatabaseClient } from "@hyperion/database";
import { validateInternalAuthorization, type RouteRegistrar, type ServiceContext } from "@hyperion/service-runtime";
import { z } from "zod";

const uuid = z.string().uuid();

const deliveryParams = z.object({
  tenantId: tenantIdSchema,
  messageId: uuid
});

const deliveryUpdateSchema = z.discriminatedUnion("outcome", [
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
]);

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

type DeliveryUpdate = z.infer<typeof deliveryUpdateSchema>;

async function applyDeliveryUpdate(
  db: DatabaseClient,
  tenantId: string,
  messageId: string,
  update: DeliveryUpdate
): Promise<boolean> {
  switch (update.outcome) {
    case "sent": {
      const result = await db.query(
        `update pulso_iris.messages
            set provider = $3, provider_message_id = $4,
                delivery_status = case
                  when delivery_status in ('delivered', 'read') then delivery_status
                  else 'sent'
                end
          where tenant_id = $1 and id = $2`,
        [tenantId, messageId, update.provider, update.providerMessageId]
      );
      return (result.rowCount ?? 0) > 0;
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
      return (result.rowCount ?? 0) > 0;
    }
    case "uncertain": {
      const result = await db.query(
        `update pulso_iris.messages
         set delivery_status = case
               when delivery_status in ('delivered', 'read') then delivery_status
               else 'failed'
             end,
             metadata = coalesce(metadata, '{}'::jsonb)
               || '{"deliveryReconciliationRequired":true}'::jsonb
         where tenant_id = $1 and id = $2`,
        [tenantId, messageId]
      );
      return (result.rowCount ?? 0) > 0;
    }
    case "reconcile": {
      const result = await db.query(
        `update pulso_iris.messages
         set delivery_status = case
               when delivery_status = 'read' then 'read'
               when $3 = 'read' then 'read'
               when delivery_status = 'delivered' then 'delivered'
               when $3 = 'delivered' then 'delivered'
               when $3 = 'failed' then 'failed'
               else delivery_status
             end,
             delivered_at = case
               when $3 in ('delivered', 'read') and (delivered_at is null or $4::timestamptz < delivered_at) then $4::timestamptz
               else delivered_at
             end,
             metadata = coalesce(metadata, '{}'::jsonb) - 'deliveryReconciliationRequired'
         where tenant_id = $1 and id = $2`,
        [tenantId, messageId, update.status, update.occurredAt]
      );
      return (result.rowCount ?? 0) > 0;
    }
  }
}
