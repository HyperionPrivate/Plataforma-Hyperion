import type { DatabaseClient } from "@hyperion/database";
import type { PulsoDeliveryClient, PulsoDeliveryOutcome } from "./pulso-delivery-client.js";

/**
 * Integration-only owner-state double. Production Channel talks to PULSO over
 * HTTP; these repository tests share one Postgres and need the same guard and
 * delivery semantics without standing up the PULSO HTTP edge.
 */
export function createDatabasePulsoDeliveryClient(db: DatabaseClient): PulsoDeliveryClient {
  return {
    async guardQueuedMessage(tenantId, messageId, input) {
      const result = await db.query<{
        conversationId: string;
        sender: string;
        body: string;
        provider: string | null;
        deliveryStatus: string | null;
      }>(
        `select conversation_id as "conversationId", sender, body, provider,
                delivery_status as "deliveryStatus"
           from pulso_iris.messages
          where tenant_id = $1 and id = $2`,
        [tenantId, messageId]
      );
      const row = result.rows[0];
      if (!row) return false;
      return (
        row.conversationId === input.conversationId &&
        row.sender === "sofia" &&
        row.provider === "whatsapp_web_test" &&
        row.deliveryStatus === "queued" &&
        row.body === input.body
      );
    },

    async updateDelivery(tenantId, messageId, update) {
      return applyDeliveryUpdate(db, tenantId, messageId, update);
    }
  };
}

async function applyDeliveryUpdate(
  db: DatabaseClient,
  tenantId: string,
  messageId: string,
  update: PulsoDeliveryOutcome
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
               when $3 in ('delivered', 'read') and (delivered_at is null or $4::timestamptz < delivered_at)
                 then $4::timestamptz
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
