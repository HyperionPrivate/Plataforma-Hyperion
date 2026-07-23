import { pulsoDeliveryGuardRequestSchema, pulsoDeliveryGuardResultSchema } from "@hyperion/pulso-contracts";
import { createInternalAuthorizationHeaders } from "@hyperion/service-runtime";
import { z } from "zod";

const deliveryResponseSchema = z
  .object({
    data: z.object({ updated: z.boolean() }).strict(),
    meta: z.object({ requestId: z.string().optional(), generatedAt: z.string().datetime() }).partial().passthrough()
  })
  .passthrough();

const guardResponseSchema = z
  .object({
    data: pulsoDeliveryGuardResultSchema,
    meta: z.object({ requestId: z.string().optional(), generatedAt: z.string().datetime() }).partial().passthrough()
  })
  .passthrough();

export type PulsoDeliveryOutcome =
  | { outcome: "sent"; provider: "whatsapp_web_test"; providerMessageId: string }
  | { outcome: "failed" }
  | { outcome: "uncertain"; provider?: "whatsapp_web_test"; providerMessageId?: string }
  | {
      outcome: "reconcile";
      provider: "whatsapp_web_test";
      providerMessageId: string;
      status: "delivered" | "read" | "failed";
      occurredAt: string;
    }
  | { outcome: "cancel_source" };

export interface PulsoDeliveryClient {
  updateDelivery(tenantId: string, messageId: string, update: PulsoDeliveryOutcome): Promise<boolean>;
  guardQueuedMessage(
    tenantId: string,
    messageId: string,
    input: { conversationId: string; body: string }
  ): Promise<boolean>;
}

export function createPulsoDeliveryClient(options: {
  readonly pulsoIrisUrl: string;
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): PulsoDeliveryClient {
  const pulsoIrisUrl = options.pulsoIrisUrl.trim().replace(/\/$/, "");
  const credential = options.credential.trim();
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    async updateDelivery(tenantId, messageId, update) {
      if (!credential) throw new Error("CHANNEL_TO_PULSO_TOKEN is required for delivery updates");
      const response = await request(
        `${pulsoIrisUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/messages/${encodeURIComponent(messageId)}/delivery`,
        {
          method: "POST",
          headers: {
            ...createInternalAuthorizationHeaders("whatsapp-channel-service", credential),
            "content-type": "application/json"
          },
          body: JSON.stringify(update),
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      if (!response.ok) {
        throw new Error(`PULSO delivery update failed with status ${response.status}`);
      }
      return deliveryResponseSchema.parse(await response.json()).data.updated;
    },

    async guardQueuedMessage(tenantId, messageId, input) {
      if (!credential) throw new Error("CHANNEL_TO_PULSO_TOKEN is required for delivery guards");
      const body = pulsoDeliveryGuardRequestSchema.parse({
        conversationId: input.conversationId,
        body: input.body,
        expectedDeliveryStatus: "queued"
      });
      const response = await request(
        `${pulsoIrisUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/messages/${encodeURIComponent(messageId)}/delivery-guard`,
        {
          method: "POST",
          headers: {
            ...createInternalAuthorizationHeaders("whatsapp-channel-service", credential),
            "content-type": "application/json"
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      if (response.status === 404) return false;
      if (!response.ok) {
        throw new Error(`PULSO delivery guard failed with status ${response.status}`);
      }
      return guardResponseSchema.parse(await response.json()).data.matches;
    }
  };
}
