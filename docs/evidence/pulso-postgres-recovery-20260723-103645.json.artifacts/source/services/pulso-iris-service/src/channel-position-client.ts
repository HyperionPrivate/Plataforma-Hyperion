import { createInternalAuthorizationHeaders } from "@hyperion/service-runtime";
import { z } from "zod";
import type { LegacyChannelInboundEvent } from "./channel-inbound-events.js";

const channelPositionEnvelopeSchema = z
  .object({
    data: z
      .object({
        tenantId: z.string().uuid(),
        eventId: z.string().uuid(),
        streamId: z.string().uuid(),
        streamSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
      })
      .strict(),
    meta: z.object({ requestId: z.string().optional(), generatedAt: z.string().datetime() })
  })
  .strict();

export interface ChannelEventPosition {
  readonly streamId: string;
  readonly streamSequence: number;
}

export type LegacyChannelPositionResolver = (event: LegacyChannelInboundEvent) => Promise<ChannelEventPosition>;

export function createLegacyChannelPositionResolver(options: {
  readonly channelServiceUrl: string;
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): LegacyChannelPositionResolver {
  const channelServiceUrl = requireServiceUrl(options.channelServiceUrl);
  const credential = options.credential.trim();
  if (!credential) throw new Error("PULSO_TO_CHANNEL_TOKEN is required for Channel v1 compatibility");
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = requireTimeout(options.timeoutMs ?? 5_000);

  return async (event) => {
    const response = await request(
      `${channelServiceUrl}/internal/v1/tenants/${encodeURIComponent(event.tenantId)}/channel-inbound/${encodeURIComponent(event.payload.inboundEventId)}/stream-position`,
      {
        method: "GET",
        headers: createInternalAuthorizationHeaders("pulso-iris-service", credential),
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    if (!response.ok) {
      throw new Error(`Channel position lookup failed with status ${response.status}`);
    }
    const parsed = channelPositionEnvelopeSchema.parse(await response.json());
    if (
      parsed.data.tenantId !== event.tenantId ||
      parsed.data.eventId !== event.payload.inboundEventId ||
      parsed.data.streamId !== event.payload.threadBindingId
    ) {
      throw new Error("Channel position lookup conflicts with the legacy event identity");
    }
    return {
      streamId: parsed.data.streamId,
      streamSequence: parsed.data.streamSequence
    };
  };
}

function requireServiceUrl(value: string): string {
  const normalized = value.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("WHATSAPP_CHANNEL_SERVICE_URL must be a valid HTTP URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("WHATSAPP_CHANNEL_SERVICE_URL must be a credential-free HTTP URL");
  }
  return normalized;
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new Error("Channel position lookup timeout must be between 100 and 30000 ms");
  }
  return value;
}
