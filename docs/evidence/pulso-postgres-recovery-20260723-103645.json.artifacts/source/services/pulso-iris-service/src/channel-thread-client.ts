import { createInternalAuthorizationHeaders } from "@hyperion/service-runtime";
import { z } from "zod";

const bindResponseSchema = z
  .object({
    data: z.object({ bound: z.literal(true) }).strict(),
    meta: z.object({ requestId: z.string().optional(), generatedAt: z.string().datetime() }).partial().passthrough()
  })
  .passthrough();

const threadResponseSchema = z
  .object({
    data: z
      .object({
        id: z.string().uuid(),
        patientId: z.string().uuid().nullable(),
        conversationId: z.string().uuid().nullable(),
        status: z.string()
      })
      .strict(),
    meta: z.object({ requestId: z.string().optional(), generatedAt: z.string().datetime() }).partial().passthrough()
  })
  .passthrough();

export interface ChannelThreadClient {
  getThread(
    tenantId: string,
    threadBindingId: string
  ): Promise<{ id: string; patientId: string | null; conversationId: string | null; status: string }>;
  bindThread(
    tenantId: string,
    threadBindingId: string,
    input: {
      patientId: string;
      conversationId: string;
      externalMessageId: string;
      messageId: string;
    }
  ): Promise<void>;
}

export function createChannelThreadClient(options: {
  readonly channelServiceUrl: string;
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): ChannelThreadClient {
  const channelServiceUrl = options.channelServiceUrl.trim().replace(/\/$/, "");
  const credential = options.credential.trim();
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return {
    async getThread(tenantId, threadBindingId) {
      if (!credential) throw new Error("PULSO_TO_CHANNEL_TOKEN is required for thread lookups");
      const response = await request(
        `${channelServiceUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/whatsapp/threads/${encodeURIComponent(threadBindingId)}`,
        {
          method: "GET",
          headers: createInternalAuthorizationHeaders("pulso-iris-service", credential),
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      if (response.status === 404) {
        throw Object.assign(new Error("thread_binding_not_found"), { statusCode: 404 });
      }
      if (!response.ok) {
        throw new Error(`Channel thread lookup failed with status ${response.status}`);
      }
      return threadResponseSchema.parse(await response.json()).data;
    },

    async bindThread(tenantId, threadBindingId, input) {
      if (!credential) throw new Error("PULSO_TO_CHANNEL_TOKEN is required for thread binds");
      const response = await request(
        `${channelServiceUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/whatsapp/threads/${encodeURIComponent(threadBindingId)}/bind`,
        {
          method: "POST",
          headers: {
            ...createInternalAuthorizationHeaders("pulso-iris-service", credential),
            "content-type": "application/json"
          },
          body: JSON.stringify({ ...input, provider: "whatsapp_web_test" }),
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      if (response.status === 404) {
        throw Object.assign(new Error("thread_binding_not_found"), { statusCode: 404 });
      }
      if (!response.ok) {
        throw new Error(`Channel thread bind failed with status ${response.status}`);
      }
      bindResponseSchema.parse(await response.json());
    }
  };
}
