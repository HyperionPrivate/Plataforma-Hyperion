import { envelope, tenantIdSchema } from "@hyperion/platform-contracts";
import type { DatabaseClient } from "@hyperion/database";
import { validateInternalAuthorization, type RouteRegistrar, type ServiceContext } from "@hyperion/service-runtime";
import { z } from "zod";

const uuid = z.string().uuid();

const bindParams = z.object({
  tenantId: tenantIdSchema,
  threadBindingId: uuid
});

const bindBodySchema = z
  .object({
    patientId: uuid,
    conversationId: uuid,
    externalMessageId: z.string().min(1).max(512),
    messageId: uuid,
    provider: z.literal("whatsapp_web_test").default("whatsapp_web_test")
  })
  .strict();

const threadLookupParams = z.object({
  tenantId: tenantIdSchema,
  threadBindingId: uuid
});

export function registerThreadBindRoutes(
  app: Parameters<RouteRegistrar>[0],
  context: ServiceContext,
  pulsoCredential: string | undefined
): void {
  const authorize = (headers: Parameters<typeof validateInternalAuthorization>[0]) =>
    validateInternalAuthorization(headers, { "pulso-iris-service": pulsoCredential });

  app.get("/internal/v1/tenants/:tenantId/whatsapp/threads/:threadBindingId", async (request, reply) => {
    const authError = authorize(request.headers);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const params = threadLookupParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(envelope({ error: "Invalid thread lookup" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query<{
      id: string;
      patientId: string | null;
      conversationId: string | null;
      status: string;
    }>(
      `select id, patient_id as "patientId", conversation_id as "conversationId", status
         from channel_runtime.thread_bindings
        where tenant_id = $1 and id = $2`,
      [params.data.tenantId, params.data.threadBindingId]
    );
    const row = result.rows[0];
    if (!row) {
      return reply.code(404).send(envelope({ error: "thread_binding_not_found" }, request.id));
    }
    return envelope(row, request.id);
  });

  app.post("/internal/v1/tenants/:tenantId/whatsapp/threads/:threadBindingId/bind", async (request, reply) => {
    const authError = authorize(request.headers);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    const params = bindParams.safeParse(request.params);
    const body = bindBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send(envelope({ error: "Invalid thread bind request" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const bound = await bindThreadPatient(context.db, params.data.tenantId, params.data.threadBindingId, body.data);
    if (!bound) {
      return reply.code(404).send(envelope({ error: "thread_binding_not_found" }, request.id));
    }
    return envelope({ bound: true }, request.id);
  });
}

async function bindThreadPatient(
  db: DatabaseClient,
  tenantId: string,
  threadBindingId: string,
  input: z.infer<typeof bindBodySchema>
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const binding = await tx.query<{ id: string }>(
      `select id from channel_runtime.thread_bindings
       where tenant_id = $1 and id = $2 for update`,
      [tenantId, threadBindingId]
    );
    if (!binding.rows[0]) return false;

    await tx.query(
      `update channel_runtime.thread_bindings
       set patient_id = $3, conversation_id = $4, last_inbound_at = now(), updated_at = now()
       where tenant_id = $1 and id = $2`,
      [tenantId, threadBindingId, input.patientId, input.conversationId]
    );
    await tx.query(
      `update channel_runtime.inbound_events
       set thread_binding_id = $3, message_id = $4, updated_at = now()
       where tenant_id = $1 and external_message_id = $2 and provider = $5`,
      [tenantId, input.externalMessageId, threadBindingId, input.messageId, input.provider]
    );
    return true;
  });
}
