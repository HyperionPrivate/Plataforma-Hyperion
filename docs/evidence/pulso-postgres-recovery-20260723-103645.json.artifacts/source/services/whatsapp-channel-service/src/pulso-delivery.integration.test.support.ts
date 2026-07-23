import type { DatabaseClient } from "@hyperion/database";
import type { PulsoDeliveryClient } from "./pulso-delivery-client.js";

/**
 * Integration-only owner-state guard. Production Channel reads this precondition
 * through PULSO's authenticated HTTP edge. Delivery outcomes deliberately are
 * not projected here: repository tests must observe the durable Channel outbox
 * boundary before a separate PULSO consumer applies them.
 */
export function createDatabasePulsoDeliveryGuard(db: DatabaseClient): Pick<PulsoDeliveryClient, "guardQueuedMessage"> {
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
    }
  };
}
