import { createHash, timingSafeEqual } from "node:crypto";
import { envelope } from "@hyperion/contracts";
import type { DatabaseClient } from "@hyperion/database";
import { validateInternalAuthorization, type ServiceContext } from "@hyperion/service-runtime";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applyDeliveryUpdateResult, type DeliveryUpdate } from "./channel-delivery-routes.js";

export const CHANNEL_DELIVERY_EVENT_TYPE = "channel.delivery.updated.v1" as const;
export const CHANNEL_DELIVERY_EVENT_VERSION = 1 as const;

const uuid = z.string().uuid();
const datetime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const deliveryPayloadSchema = z
  .discriminatedUnion("outcome", [
    z
      .object({
        messageId: uuid,
        outcome: z.literal("sent"),
        provider: z.literal("whatsapp_web_test"),
        providerMessageId: z.string().min(1).max(512)
      })
      .strict(),
    z.object({ messageId: uuid, outcome: z.literal("failed") }).strict(),
    z
      .object({
        messageId: uuid,
        outcome: z.literal("uncertain"),
        provider: z.literal("whatsapp_web_test").optional(),
        providerMessageId: z.string().min(1).max(512).optional()
      })
      .strict(),
    z
      .object({
        messageId: uuid,
        outcome: z.literal("reconcile"),
        provider: z.literal("whatsapp_web_test"),
        providerMessageId: z.string().min(1).max(512),
        status: z.enum(["delivered", "read", "failed"]),
        occurredAt: datetime
      })
      .strict(),
    z.object({ messageId: uuid, outcome: z.literal("cancel_source") }).strict()
  ])
  .superRefine((payload, context) => {
    if (
      payload.outcome === "uncertain" &&
      (payload.provider === undefined) !== (payload.providerMessageId === undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider and providerMessageId must be supplied together"
      });
    }
  });

export const channelDeliveryEventSchema = z
  .object({
    id: uuid,
    type: z.literal(CHANNEL_DELIVERY_EVENT_TYPE),
    version: z.literal(CHANNEL_DELIVERY_EVENT_VERSION),
    occurredAt: datetime,
    tenantId: uuid,
    streamId: uuid,
    streamSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    payload: deliveryPayloadSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.streamId !== event.payload.messageId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["streamId"],
        message: "streamId must match payload.messageId"
      });
    }
  });

export type ChannelDeliveryEvent = z.infer<typeof channelDeliveryEventSchema>;

const resultSchema = z.object({ messageId: uuid, updated: z.boolean() }).strict();
type ChannelDeliveryResult = z.infer<typeof resultSchema>;

export type ChannelDeliveryProcessingResult =
  | { status: "accepted" | "replayed"; result: ChannelDeliveryResult }
  | { status: "gap"; eventId: string; streamId: string; expectedSequence: number; receivedSequence: number }
  | { status: "retryable"; eventId: string; reason: "target_not_found" }
  | { status: "conflict"; eventId: string };

interface InboxRow {
  payloadHash: string;
  result: unknown;
}

export function registerChannelDeliveryEventRoutes(
  app: FastifyInstance,
  context: ServiceContext,
  channelCredential: string | undefined
): void {
  app.post("/internal/v1/events/channel-delivery", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "whatsapp-channel-service": channelCredential
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const parsed = channelDeliveryEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        envelope(
          {
            error: "Invalid event envelope",
            issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
          },
          request.id
        )
      );
    }

    try {
      const outcome = await receiveChannelDeliveryEvent(context.db, parsed.data);
      if (outcome.status === "gap") {
        return reply.code(409).send(envelope({ error: "Event sequence gap", ...outcome }, request.id));
      }
      if (outcome.status === "retryable") {
        return reply.code(409).send(envelope({ error: "Event target is not available", ...outcome }, request.id));
      }
      if (outcome.status === "conflict") {
        return reply
          .code(409)
          .send(envelope({ error: "Event identity conflicts with persisted state", ...outcome }, request.id));
      }
      return envelope({ status: outcome.status, ...outcome.result }, request.id);
    } catch (error) {
      context.logger.error("failed to apply Channel delivery event", {
        requestId: request.id,
        eventId: parsed.data.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return reply.code(500).send(envelope({ error: "Failed to persist channel delivery event" }, request.id));
    }
  });
}

export async function receiveChannelDeliveryEvent(
  db: DatabaseClient,
  event: ChannelDeliveryEvent
): Promise<ChannelDeliveryProcessingResult> {
  const payloadHash = hashCanonicalJson(event);
  try {
    return await db.transaction(async (transaction) => {
      await transaction.query(
        `select pg_advisory_xact_lock(
           hashtextextended(concat_ws(chr(31), $1::text, 'channel_delivery', $2::text), 0)
         )`,
        [event.tenantId, event.streamId]
      );

      const inserted = await transaction.query<{ eventId: string }>(
        `insert into pulso_iris.inbox_events (
           event_id, tenant_id, source_service, event_type, event_version,
           payload_hash, occurred_at, stream_id, stream_sequence
         ) values (
           $1::uuid, $2::uuid, 'whatsapp-channel-service', $3, $4,
           $5, $6::timestamptz, $7::uuid, $8::bigint
         )
         on conflict (event_id) do nothing
         returning event_id as "eventId"`,
        [
          event.id,
          event.tenantId,
          event.type,
          event.version,
          payloadHash,
          event.occurredAt,
          event.streamId,
          event.streamSequence
        ]
      );

      if (!inserted.rows[0]) {
        const existing = await transaction.query<InboxRow>(
          `select payload_hash as "payloadHash", result
             from pulso_iris.inbox_events
            where event_id = $1::uuid
            for update`,
          [event.id]
        );
        const inbox = existing.rows[0];
        if (!inbox) throw new Error("Inbox event disappeared after a uniqueness conflict");
        if (!constantTimeHexEquals(inbox.payloadHash, payloadHash)) {
          return { status: "conflict", eventId: event.id };
        }
        return { status: "replayed", result: resultSchema.parse(inbox.result) };
      }

      const prior = await transaction.query<{ lastSequence: string | number }>(
        `select coalesce(max(stream_sequence), 0) as "lastSequence"
           from pulso_iris.inbox_events
          where tenant_id = $1::uuid
            and source_service = 'whatsapp-channel-service'
            and event_type = $2
            and stream_id = $3::uuid
            and event_id <> $4::uuid
            and processed_at is not null`,
        [event.tenantId, CHANNEL_DELIVERY_EVENT_TYPE, event.streamId, event.id]
      );
      const lastSequence = Number(prior.rows[0]?.lastSequence ?? 0);
      const expectedSequence = lastSequence + 1;
      if (event.streamSequence !== expectedSequence) {
        if (event.streamSequence > expectedSequence) {
          throw new ChannelDeliverySequenceGapError(expectedSequence, event.streamSequence);
        }
        throw new ChannelDeliverySequenceConflictError();
      }

      const { messageId, ...update } = event.payload;
      const application = await applyDeliveryUpdateResult(
        transaction,
        event.tenantId,
        messageId,
        update as DeliveryUpdate
      );
      if (application === "target_not_found") throw new ChannelDeliveryTargetNotFoundError();
      if (application === "identity_conflict") throw new ChannelDeliveryIdentityConflictError();

      const result: ChannelDeliveryResult = { messageId, updated: true };
      await transaction.query(
        `update pulso_iris.inbox_events
            set processed_at = now(), result = $3::jsonb
          where event_id = $1::uuid and tenant_id = $2::uuid`,
        [event.id, event.tenantId, JSON.stringify(result)]
      );
      return { status: "accepted", result };
    });
  } catch (error) {
    if (error instanceof ChannelDeliverySequenceGapError) {
      return {
        status: "gap",
        eventId: event.id,
        streamId: event.streamId,
        expectedSequence: error.expected,
        receivedSequence: error.received
      };
    }
    if (error instanceof ChannelDeliveryTargetNotFoundError) {
      return { status: "retryable", eventId: event.id, reason: "target_not_found" };
    }
    if (
      error instanceof ChannelDeliverySequenceConflictError ||
      error instanceof ChannelDeliveryIdentityConflictError ||
      isDeliverySequenceUniqueViolation(error)
    ) {
      return { status: "conflict", eventId: event.id };
    }
    throw error;
  }
}

class ChannelDeliverySequenceGapError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number
  ) {
    super("Channel delivery sequence gap");
  }
}

class ChannelDeliverySequenceConflictError extends Error {}

class ChannelDeliveryTargetNotFoundError extends Error {}

class ChannelDeliveryIdentityConflictError extends Error {}

function isDeliverySequenceUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === "uq_pulso_channel_delivery_inbox_stream_sequence";
}

function constantTimeHexEquals(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Channel delivery event must be JSON serializable");
}
