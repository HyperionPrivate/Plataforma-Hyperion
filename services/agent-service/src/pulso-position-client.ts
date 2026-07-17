import { createInternalAuthorizationHeaders } from "@hyperion/service-runtime";
import { z } from "zod";
import type { LegacyPulsoMessageEvent } from "./pulso-events.js";

const pulsoPositionEnvelopeSchema = z
  .object({
    data: z
      .object({
        tenantId: z.string().uuid(),
        eventId: z.string().uuid(),
        streamId: z.string().uuid(),
        streamSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        sourceStreamId: z.string().uuid(),
        sourceStreamSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
      })
      .strict(),
    meta: z.object({ requestId: z.string().optional(), generatedAt: z.string().datetime() })
  })
  .strict();

export interface PulsoEventPosition {
  readonly streamId: string;
  readonly streamSequence: number;
  readonly sourceStreamId: string;
  readonly sourceStreamSequence: number;
}

export type LegacyPulsoPositionResolver = (event: LegacyPulsoMessageEvent) => Promise<PulsoEventPosition>;

export function createLegacyPulsoPositionResolver(options: {
  readonly pulsoServiceUrl: string;
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}): LegacyPulsoPositionResolver {
  const pulsoServiceUrl = requireServiceUrl(options.pulsoServiceUrl);
  const credential = options.credential.trim();
  if (!credential) throw new Error("SOFIA_TO_PULSO_TOKEN is required for PULSO v1 compatibility");
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = requireTimeout(options.timeoutMs ?? 5_000);

  return async (event) => {
    const response = await request(
      `${pulsoServiceUrl}/internal/v1/tenants/${encodeURIComponent(event.tenantId)}/pulso-message/${encodeURIComponent(event.id)}/stream-position`,
      {
        method: "GET",
        headers: createInternalAuthorizationHeaders("agent-service", credential),
        signal: AbortSignal.timeout(timeoutMs)
      }
    );
    if (!response.ok) {
      throw new Error(`PULSO position lookup failed with status ${response.status}`);
    }
    const parsed = pulsoPositionEnvelopeSchema.parse(await response.json());
    if (
      parsed.data.tenantId !== event.tenantId ||
      parsed.data.eventId !== event.id ||
      parsed.data.streamId !== event.payload.conversationId ||
      parsed.data.sourceStreamId !== event.payload.threadBindingId
    ) {
      throw new Error("PULSO position lookup conflicts with the legacy event identity");
    }
    return {
      streamId: parsed.data.streamId,
      streamSequence: parsed.data.streamSequence,
      sourceStreamId: parsed.data.sourceStreamId,
      sourceStreamSequence: parsed.data.sourceStreamSequence
    };
  };
}

function requireServiceUrl(value: string): string {
  const normalized = value.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("PULSO_IRIS_SERVICE_URL must be a valid HTTP URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("PULSO_IRIS_SERVICE_URL must be a credential-free HTTP URL");
  }
  return normalized;
}

function requireTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > 30_000) {
    throw new Error("PULSO position lookup timeout must be between 100 and 30000 ms");
  }
  return value;
}
