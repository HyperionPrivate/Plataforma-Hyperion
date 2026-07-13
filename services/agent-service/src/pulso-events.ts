import { createHash, timingSafeEqual } from "node:crypto";
import { envelope } from "@hyperion/contracts";
import type { DatabaseClient } from "@hyperion/database";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { z } from "zod";

const pulsoMessagePayloadSchema = z
  .object({
    inboundEventId: z.string().uuid(),
    threadBindingId: z.string().uuid(),
    patientId: z.string().uuid(),
    conversationId: z.string().uuid(),
    messageId: z.string().uuid(),
    occurredAt: z.string().datetime()
  })
  .strict();

export const pulsoMessageEventSchema = z
  .object({
    id: z.string().uuid(),
    type: z.literal("pulso.message.received.v1"),
    version: z.literal(1),
    occurredAt: z.string().datetime(),
    tenantId: z.string().uuid(),
    payload: pulsoMessagePayloadSchema
  })
  .strict();

export type PulsoMessageEvent = z.infer<typeof pulsoMessageEventSchema>;

export type PulsoMessageConsumption = { status: "accepted" | "duplicate"; jobId: string } | { status: "conflict" };

export const registerPulsoEventRoutes: RouteRegistrar = (app, context) => {
  app.post("/internal/v1/events/pulso-message-received", async (request, reply) => {
    const authError = validateInternalToken(context.config.internalServiceToken, request.headers.authorization);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }
    const parsed = pulsoMessageEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid durable event" }, request.id));
    }

    const result = await consumePulsoMessageEvent(context.db, parsed.data);
    if (result.status === "conflict") {
      return reply
        .code(409)
        .send(envelope({ error: "Event identifier conflicts with an existing payload" }, request.id));
    }
    return reply
      .code(result.status === "accepted" ? 202 : 200)
      .send(envelope({ accepted: true, duplicate: result.status === "duplicate", jobId: result.jobId }, request.id));
  });
};

export async function consumePulsoMessageEvent(
  db: DatabaseClient,
  event: PulsoMessageEvent
): Promise<PulsoMessageConsumption> {
  const payloadHash = createHash("sha256").update(canonicalJson(event)).digest("hex");
  return db.transaction(async (tx) => {
    const claimed = await tx.query<{ eventId: string }>(
      `insert into agent_runtime.inbox_events (
         event_id, tenant_id, source_service, event_type, event_version, payload_hash, occurred_at
       ) values ($1, $2, 'pulso-core', $3, $4, $5, $6)
       on conflict (event_id) do nothing
       returning event_id as "eventId"`,
      [event.id, event.tenantId, event.type, event.version, payloadHash, event.occurredAt]
    );

    if (!claimed.rows[0]) {
      const existing = await tx.query<{ payloadHash: string; result: { jobId?: unknown } }>(
        `select payload_hash as "payloadHash", result
         from agent_runtime.inbox_events where event_id = $1`,
        [event.id]
      );
      const row = existing.rows[0];
      if (!row || !constantTimeHexEquals(row.payloadHash, payloadHash)) return { status: "conflict" };
      const jobId = typeof row.result?.jobId === "string" ? row.result.jobId : undefined;
      if (!jobId) throw new Error("Durable inbox replay is missing its result");
      return { status: "duplicate", jobId };
    }

    const insertedJob = await tx.query<{ id: string }>(
      `insert into agent_runtime.jobs (
         tenant_id, conversation_id, inbound_event_id, idempotency_key, status, input
       ) values ($1, $2, $3, $4, 'queued', $5::jsonb)
       on conflict (tenant_id, inbound_event_id) do nothing
       returning id`,
      [
        event.tenantId,
        event.payload.conversationId,
        event.payload.inboundEventId,
        `sofia-inbound:${event.payload.inboundEventId}`,
        JSON.stringify({
          patientId: event.payload.patientId,
          messageId: event.payload.messageId,
          threadBindingId: event.payload.threadBindingId,
          occurredAt: event.payload.occurredAt
        })
      ]
    );
    const existingJob = insertedJob.rows[0]
      ? undefined
      : (
          await tx.query<{ id: string }>(
            `select id from agent_runtime.jobs where tenant_id = $1 and inbound_event_id = $2`,
            [event.tenantId, event.payload.inboundEventId]
          )
        ).rows[0];
    const jobId = insertedJob.rows[0]?.id ?? existingJob?.id;
    if (!jobId) throw new Error("Unable to create or recover SOFIA job");

    await tx.query(
      `insert into agent_runtime.outbox_events (
         tenant_id, event_type, event_version, aggregate_type, aggregate_id, payload, occurred_at
       ) values ($1, 'sofia.audit.event.record.v1', 1, 'agent_job', $2, $3::jsonb, $4)
       on conflict (tenant_id, event_type, aggregate_id) do nothing`,
      [
        event.tenantId,
        jobId,
        JSON.stringify({
          tenantId: event.tenantId,
          actorId: "agent:SOFIA",
          eventType: "agent.job.queued",
          entityType: "agent_job",
          entityId: jobId,
          metadata: { sourceEventType: event.type }
        }),
        event.occurredAt
      ]
    );
    await tx.query(
      `update agent_runtime.inbox_events
       set processed_at = now(), result = jsonb_build_object('jobId', $2::text)
       where event_id = $1`,
      [event.id, jobId]
    );
    return { status: "accepted", jobId };
  });
}

function validateInternalToken(
  token: string | undefined,
  authorization: string | undefined
): { statusCode: number; message: string } | undefined {
  if (!token) return { statusCode: 503, message: "INTERNAL_SERVICE_TOKEN is required" };
  const expected = `Bearer ${token}`;
  if (!authorization || !constantTimeEquals(authorization, expected)) {
    return { statusCode: 401, message: "Unauthorized" };
  }
  return undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function constantTimeHexEquals(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Durable event contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Durable event contains a non-JSON value");
}
