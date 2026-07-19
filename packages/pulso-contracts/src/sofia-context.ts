import { tenantIdSchema } from "@hyperion/platform-contracts";
import { z } from "zod";
import { pulsoIrisConversationStatusSchema } from "./domain.js";

const uuid = z.string().uuid();
const messageSenderSchema = z.enum(["sofia", "patient", "advisor", "system"]);
const messageBodySchema = z.string().min(1).max(4096);
const sofiaStateSchema = z.record(z.string(), z.unknown());

export const pulsoSofiaInboundLookupRequestSchema = z
  .object({
    conversationId: uuid,
    messageId: uuid,
    patientId: uuid
  })
  .strict();

const pulsoSofiaInboundMessageSchema = z
  .object({
    id: uuid,
    sender: z.literal("patient"),
    body: messageBodySchema
  })
  .strict();

export const pulsoSofiaInboundLookupResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }).strict(),
  z
    .object({
      found: z.literal(true),
      tenantId: tenantIdSchema,
      conversationId: uuid,
      patientId: uuid,
      conversationStatus: pulsoIrisConversationStatusSchema,
      message: pulsoSofiaInboundMessageSchema
    })
    .strict()
]);

export const pulsoSofiaConversationContextRequestSchema = z
  .object({
    conversationId: uuid,
    patientId: uuid
  })
  .strict();

const pulsoSofiaHistoryMessageSchema = z
  .object({
    sender: messageSenderSchema,
    body: messageBodySchema
  })
  .strict();

export const pulsoSofiaConversationContextResultSchema = z
  .object({
    tenantId: tenantIdSchema,
    conversationId: uuid,
    patientId: uuid,
    patientName: z.string().trim().min(1).max(300).nullable(),
    sofiaState: sofiaStateSchema,
    history: z.array(pulsoSofiaHistoryMessageSchema).max(12)
  })
  .strict();

export type PulsoSofiaInboundLookupRequest = z.infer<typeof pulsoSofiaInboundLookupRequestSchema>;
export type PulsoSofiaInboundLookupResult = z.infer<typeof pulsoSofiaInboundLookupResultSchema>;
export type PulsoSofiaConversationContextRequest = z.infer<typeof pulsoSofiaConversationContextRequestSchema>;
export type PulsoSofiaConversationContextResult = z.infer<typeof pulsoSofiaConversationContextResultSchema>;
