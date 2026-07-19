import {
  pulsoSofiaConversationContextRequestSchema,
  pulsoSofiaConversationContextResultSchema,
  pulsoSofiaInboundLookupRequestSchema,
  pulsoSofiaInboundLookupResultSchema,
  type PulsoSofiaConversationContextRequest,
  type PulsoSofiaConversationContextResult,
  type PulsoSofiaInboundLookupRequest,
  type PulsoSofiaInboundLookupResult
} from "@hyperion/pulso-contracts";
import { createInternalAuthorizationHeaders } from "@hyperion/service-runtime";
import { z } from "zod";

const envelopeMetaSchema = z
  .object({
    requestId: z.string().optional(),
    generatedAt: z.string().datetime()
  })
  .strict();

const responseEnvelope = <T extends z.ZodTypeAny>(data: T) =>
  z
    .object({
      data,
      meta: envelopeMetaSchema
    })
    .strict();

const inboundLookupEnvelopeSchema = responseEnvelope(pulsoSofiaInboundLookupResultSchema);
const conversationContextEnvelopeSchema = responseEnvelope(pulsoSofiaConversationContextResultSchema);

export interface PulsoSofiaContextClient {
  lookupInbound(tenantId: string, input: PulsoSofiaInboundLookupRequest): Promise<PulsoSofiaInboundLookupResult>;
  loadConversation(
    tenantId: string,
    input: PulsoSofiaConversationContextRequest
  ): Promise<PulsoSofiaConversationContextResult>;
}

export class PulsoSofiaContextDependencyError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "PulsoSofiaContextDependencyError";
    this.cause = cause;
  }
}

export function createPulsoSofiaContextClient(options: {
  pulsoIrisUrl: string;
  credential: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): PulsoSofiaContextClient {
  const pulsoIrisUrl = options.pulsoIrisUrl.trim().replace(/\/$/, "");
  const credential = options.credential.trim();
  if (!credential) throw new Error("SOFIA_TO_PULSO_TOKEN is required for PULSO context reads");
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const call = async (tenantId: string, path: string, body: unknown): Promise<unknown> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await request(
        `${pulsoIrisUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/pulso-iris/sofia/${path}`,
        {
          method: "POST",
          headers: {
            ...createInternalAuthorizationHeaders("agent-service", credential),
            "content-type": "application/json"
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
        }
      );
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : "";
      throw new PulsoSofiaContextDependencyError(
        `PULSO SOFIA context read could not reach its provider${detail}`,
        error
      );
    }
    if (!response.ok) {
      throw new PulsoSofiaContextDependencyError(`PULSO SOFIA context read failed with status ${response.status}`);
    }
    return response.json();
  };

  return {
    async lookupInbound(tenantId, input) {
      const requestBody = pulsoSofiaInboundLookupRequestSchema.parse(input);
      const parsed = inboundLookupEnvelopeSchema.parse(await call(tenantId, "inbound-message", requestBody));
      if (
        parsed.data.found &&
        (parsed.data.tenantId !== tenantId ||
          parsed.data.conversationId !== requestBody.conversationId ||
          parsed.data.patientId !== requestBody.patientId ||
          parsed.data.message.id !== requestBody.messageId)
      ) {
        throw new Error("PULSO inbound lookup returned conflicting identity");
      }
      return parsed.data;
    },

    async loadConversation(tenantId, input) {
      const requestBody = pulsoSofiaConversationContextRequestSchema.parse(input);
      const parsed = conversationContextEnvelopeSchema.parse(await call(tenantId, "conversation-context", requestBody));
      if (
        parsed.data.tenantId !== tenantId ||
        parsed.data.conversationId !== requestBody.conversationId ||
        parsed.data.patientId !== requestBody.patientId
      ) {
        throw new Error("PULSO conversation context returned conflicting identity");
      }
      return parsed.data;
    }
  };
}
