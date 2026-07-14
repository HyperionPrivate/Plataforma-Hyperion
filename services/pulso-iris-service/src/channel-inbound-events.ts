import { createHash, timingSafeEqual } from "node:crypto";
import { envelope } from "@hyperion/contracts";
import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
import { readInternalCredential, validateInternalAuthorization, type RouteRegistrar } from "@hyperion/service-runtime";
import { z } from "zod";
import {
  createLegacyChannelPositionResolver,
  type ChannelEventPosition,
  type LegacyChannelPositionResolver
} from "./channel-position-client.js";
import { PULSO_MESSAGE_EVENT_V1_TYPE, PULSO_MESSAGE_EVENT_V2_TYPE } from "./pulso-outbox.js";

export const CHANNEL_INBOUND_EVENT_V1_TYPE = "channel.inbound.received.v1" as const;
export const CHANNEL_INBOUND_EVENT_V2_TYPE = "channel.inbound.received.v2" as const;
const PULSO_MESSAGE_EVENT_TYPE = PULSO_MESSAGE_EVENT_V2_TYPE;
const PULSO_MESSAGE_EVENT_VERSION = 2 as const;
const LEGACY_EVENT_VERSION = 1 as const;
const ORDERED_EVENT_VERSION = 2 as const;

const uuid = z.string().uuid();
const datetime = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const channelInboundPayloadSchema = z
  .object({
    inboundEventId: uuid,
    threadBindingId: uuid,
    provider: z.literal("whatsapp_web_test"),
    externalThreadId: z.string().min(1).max(512),
    externalMessageId: z.string().min(1).max(512),
    phoneHash: z.string().regex(/^[a-f0-9]{64}$/),
    phoneMasked: z.string().min(3).max(32),
    body: z.string().min(1).max(4096),
    receivedAt: datetime
  })
  .strict();

export const channelInboundEventV1Schema = z
  .object({
    id: uuid,
    type: z.literal(CHANNEL_INBOUND_EVENT_V1_TYPE),
    version: z.literal(LEGACY_EVENT_VERSION),
    occurredAt: datetime,
    tenantId: uuid,
    payload: channelInboundPayloadSchema
  })
  .strict();

export const channelInboundEventSchema = z
  .object({
    id: uuid,
    type: z.literal(CHANNEL_INBOUND_EVENT_V2_TYPE),
    version: z.literal(ORDERED_EVENT_VERSION),
    occurredAt: datetime,
    tenantId: uuid,
    streamId: uuid,
    streamSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    payload: channelInboundPayloadSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.streamId !== event.payload.threadBindingId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["streamId"],
        message: "streamId must match payload.threadBindingId"
      });
    }
  });

export const compatibleChannelInboundEventSchema = z.union([channelInboundEventSchema, channelInboundEventV1Schema]);

const channelInboundResultSchema = z
  .object({
    eventId: uuid,
    patientId: uuid,
    conversationId: uuid,
    messageId: uuid,
    outboxEventType: z.union([z.literal(PULSO_MESSAGE_EVENT_V1_TYPE), z.literal(PULSO_MESSAGE_EVENT_TYPE)])
  })
  .strict();

export type OrderedChannelInboundEvent = z.infer<typeof channelInboundEventSchema>;
export type LegacyChannelInboundEvent = z.infer<typeof channelInboundEventV1Schema>;
export type ChannelInboundEvent = OrderedChannelInboundEvent | LegacyChannelInboundEvent;
export type ChannelInboundResult = z.infer<typeof channelInboundResultSchema>;

type ChannelInboundProcessingResult =
  | { status: "accepted"; result: ChannelInboundResult }
  | { status: "replayed"; result: ChannelInboundResult }
  | { status: "conflict"; eventId: string }
  | { status: "gap"; eventId: string; streamId: string; expectedSequence: number; receivedSequence: number };

interface InboxRow {
  payloadHash: string;
  result: unknown;
}

interface ChannelThreadRow {
  id: string;
  patientId: string | null;
  conversationId: string | null;
  lastInboundSequence: string | number;
}

export interface ChannelStreamPosition {
  streamId: string;
  streamSequence: number;
}

interface PatientRow {
  id: string;
}

interface ConversationRow {
  id: string;
}

interface MessageRow {
  id: string;
  conversationId: string;
}

export interface ChannelInboundCompatibilityOptions {
  readonly allowLegacyV1?: boolean;
  readonly channelCredential?: string;
  readonly resolveLegacyPosition?: LegacyChannelPositionResolver;
}

export const registerChannelInboundEventRoutes: RouteRegistrar = async (app, context) => {
  const allowLegacyV1 = readChannelInboundV1Compatibility(process.env);
  const pulsoToChannelToken = readInternalCredential(process.env, "PULSO_TO_CHANNEL_TOKEN");
  return registerChannelInboundEventRoutesWithCompatibility(app, context, {
    allowLegacyV1,
    channelCredential: readInternalCredential(process.env, "CHANNEL_TO_PULSO_TOKEN"),
    resolveLegacyPosition: allowLegacyV1
      ? createLegacyChannelPositionResolver({
          channelServiceUrl: process.env.WHATSAPP_CHANNEL_SERVICE_URL ?? "http://localhost:8089",
          credential: pulsoToChannelToken ?? ""
        })
      : undefined
  });
};

export async function registerChannelInboundEventRoutesWithCompatibility(
  app: Parameters<RouteRegistrar>[0],
  context: Parameters<RouteRegistrar>[1],
  options: ChannelInboundCompatibilityOptions
): Promise<void> {
  const allowLegacyV1 = options.allowLegacyV1 === true;
  const channelCredential = options.channelCredential ?? readInternalCredential(process.env, "CHANNEL_TO_PULSO_TOKEN");
  app.post("/internal/v1/events/channel-inbound", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "whatsapp-channel-service": channelCredential
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const parsed = (allowLegacyV1 ? compatibleChannelInboundEventSchema : channelInboundEventSchema).safeParse(
      request.body
    );
    if (!parsed.success) {
      return reply.code(400).send(
        envelope(
          {
            error: "Invalid event envelope",
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message
            }))
          },
          request.id
        )
      );
    }

    try {
      if (isLegacyChannelInboundEvent(parsed.data)) {
        context.logger.warn("legacy Channel event accepted during the v2 rollout window", {
          requestId: request.id,
          eventId: parsed.data.id,
          tenantId: parsed.data.tenantId,
          eventType: parsed.data.type,
          compatibilityMode: "channel_inbound_v1"
        });
      }
      const legacyPosition = isLegacyChannelInboundEvent(parsed.data)
        ? await requireLegacyPositionResolver(options.resolveLegacyPosition)(parsed.data)
        : undefined;
      const outcome = await receiveChannelInboundEvent(context.db, parsed.data, legacyPosition);

      if (outcome.status === "gap") {
        return reply.code(409).send(
          envelope(
            {
              error: "Event sequence gap",
              eventId: outcome.eventId,
              streamId: outcome.streamId,
              expectedSequence: outcome.expectedSequence,
              receivedSequence: outcome.receivedSequence
            },
            request.id
          )
        );
      }

      if (outcome.status === "conflict") {
        return reply.code(409).send(
          envelope(
            {
              error: "Event identity or stream position conflicts with persisted state",
              eventId: outcome.eventId
            },
            request.id
          )
        );
      }

      return reply.code(outcome.status === "accepted" ? 202 : 200).send(envelope(outcome.result, request.id));
    } catch (error) {
      context.logger.error("channel inbound event persistence failed", {
        requestId: request.id,
        eventId: parsed.data.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return reply.code(500).send(envelope({ error: "Failed to persist channel event" }, request.id));
    }
  });
}

export async function receiveChannelInboundEvent(
  db: DatabaseClient,
  event: ChannelInboundEvent,
  legacyPosition?: ChannelEventPosition
): Promise<ChannelInboundProcessingResult> {
  const payloadHash = hashCanonicalJson(event);
  const ordered = isOrderedChannelInboundEvent(event);
  const streamId = ordered ? event.streamId : event.payload.threadBindingId;
  const streamPosition = resolveChannelStreamPosition(event, legacyPosition);

  try {
    return await db.transaction(async (transaction) => {
      const insertedInbox = await transaction.query<{ eventId: string }>(
        `insert into pulso_iris.inbox_events
           (event_id, tenant_id, source_service, event_type, event_version, payload_hash, occurred_at,
            stream_id, stream_sequence)
         values ($1::uuid, $2::uuid, 'whatsapp-channel-service', $3, $4, $5, $6::timestamptz,
                 $7::uuid, $8::bigint)
         on conflict (event_id) do nothing
         returning event_id as "eventId"`,
        [
          event.id,
          event.tenantId,
          event.type,
          event.version,
          payloadHash,
          event.occurredAt,
          streamPosition.streamId,
          streamPosition.streamSequence
        ]
      );

      if (!insertedInbox.rows[0]) {
        const existing = await transaction.query<InboxRow>(
          `select payload_hash as "payloadHash", result
           from pulso_iris.inbox_events
           where event_id = $1::uuid
           for update`,
          [event.id]
        );
        const inbox = existing.rows[0];
        if (!inbox) {
          throw new Error("Inbox event disappeared after a uniqueness conflict");
        }
        if (!constantTimeHexEquals(inbox.payloadHash, payloadHash)) {
          return { status: "conflict", eventId: event.id };
        }

        return { status: "replayed", result: channelInboundResultSchema.parse(inbox.result) };
      }

      const projection = await projectInboundEvent(transaction, event, streamPosition);

      await transaction.query(
        `update pulso_iris.inbox_events
         set processed_at = now(), result = $3::jsonb,
             stream_id = $4::uuid, stream_sequence = $5::bigint
         where event_id = $1::uuid and tenant_id = $2::uuid`,
        [event.id, event.tenantId, JSON.stringify(projection.result), projection.streamId, projection.streamSequence]
      );

      return { status: "accepted", result: projection.result };
    });
  } catch (error) {
    if (error instanceof ChannelSequenceGapError) {
      return {
        status: "gap",
        eventId: event.id,
        streamId,
        expectedSequence: error.expected,
        receivedSequence: error.received
      };
    }
    if (error instanceof ChannelSequenceConflictError || isStreamSequenceUniqueViolation(error)) {
      return { status: "conflict", eventId: event.id };
    }
    throw error;
  }
}

async function projectInboundEvent(
  transaction: DatabaseExecutor,
  event: ChannelInboundEvent,
  streamPosition: ChannelStreamPosition
): Promise<{ result: ChannelInboundResult; streamId: string; streamSequence: number }> {
  const payload = event.payload;
  const threadResult = await transaction.query<ChannelThreadRow>(
    `insert into pulso_iris.channel_threads
       (id, tenant_id, provider, external_thread_id, phone_e164_hash, phone_masked, last_inbound_at)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz)
     on conflict (tenant_id, provider, external_thread_id)
     do update set phone_e164_hash = excluded.phone_e164_hash,
                   phone_masked = excluded.phone_masked,
                   last_inbound_at = greatest(pulso_iris.channel_threads.last_inbound_at, excluded.last_inbound_at),
                   updated_at = now()
     where pulso_iris.channel_threads.id = excluded.id
       and pulso_iris.channel_threads.phone_e164_hash = excluded.phone_e164_hash
     returning id, patient_id as "patientId", conversation_id as "conversationId",
               last_inbound_sequence as "lastInboundSequence"`,
    [
      payload.threadBindingId,
      event.tenantId,
      payload.provider,
      payload.externalThreadId,
      payload.phoneHash,
      payload.phoneMasked,
      payload.receivedAt
    ]
  );
  const thread = threadResult.rows[0];
  if (!thread || thread.id !== payload.threadBindingId) {
    throw new ChannelSequenceConflictError();
  }
  const lastInboundSequence = requireNonNegativeSequence(thread.lastInboundSequence);
  const expectedSequence = lastInboundSequence + 1;
  const streamSequence = streamPosition.streamSequence;
  if (streamSequence > expectedSequence) {
    throw new ChannelSequenceGapError(expectedSequence, streamSequence);
  }
  if (streamSequence < expectedSequence) {
    throw new ChannelSequenceConflictError();
  }

  const patientResult = await transaction.query<PatientRow>(
    `insert into pulso_iris.administrative_patients
       (tenant_id, status, preferred_channel, phone_e164_hash, phone_masked, metadata)
     values ($1::uuid, 'active', 'whatsapp', $2, $3, '{"source":"channel_inbound"}'::jsonb)
     on conflict (tenant_id, phone_e164_hash) where phone_e164_hash is not null
     do update set phone_masked = excluded.phone_masked, updated_at = now()
     returning id`,
    [event.tenantId, payload.phoneHash, payload.phoneMasked]
  );
  const patient = requireRow(patientResult.rows[0], "Patient upsert returned no row");

  const conversationId = await findOrCreateActiveConversation(
    transaction,
    event.tenantId,
    patient.id,
    thread.conversationId,
    payload.provider
  );

  const insertedMessage = await transaction.query<MessageRow>(
    `insert into pulso_iris.messages
       (tenant_id, conversation_id, sender, body, provider, external_message_id, delivery_status, metadata,
        created_at)
     values ($1::uuid, $2::uuid, 'patient', $3, $4, $5, 'received', $6::jsonb, $7::timestamptz)
     on conflict (tenant_id, provider, external_message_id)
       where provider is not null and external_message_id is not null
     do nothing
     returning id, conversation_id as "conversationId"`,
    [
      event.tenantId,
      conversationId,
      payload.body,
      payload.provider,
      payload.externalMessageId,
      JSON.stringify({ inboundEventId: payload.inboundEventId, threadBindingId: payload.threadBindingId }),
      payload.receivedAt
    ]
  );

  const message = insertedMessage.rows[0]
    ? insertedMessage.rows[0]
    : requireRow(
        (
          await transaction.query<MessageRow>(
            `select id, conversation_id as "conversationId"
             from pulso_iris.messages
             where tenant_id = $1::uuid and provider = $2 and external_message_id = $3`,
            [event.tenantId, payload.provider, payload.externalMessageId]
          )
        ).rows[0],
        "Idempotent message lookup returned no row"
      );

  const advancedThread = await transaction.query<{ id: string }>(
    `update pulso_iris.channel_threads
     set phone_e164_hash = $4,
         phone_masked = $5,
         patient_id = $6::uuid,
         conversation_id = $7::uuid,
         last_inbound_at = greatest(last_inbound_at, $8::timestamptz),
         last_inbound_sequence = $9::bigint,
         updated_at = now()
     where tenant_id = $1::uuid and provider = $2 and external_thread_id = $3
       and last_inbound_sequence = $10::bigint
     returning id`,
    [
      event.tenantId,
      payload.provider,
      payload.externalThreadId,
      payload.phoneHash,
      payload.phoneMasked,
      patient.id,
      message.conversationId,
      payload.receivedAt,
      streamSequence,
      lastInboundSequence
    ]
  );
  if (!advancedThread.rows[0]) {
    throw new Error("Channel stream position changed while projecting an inbound event");
  }

  await transaction.query(
    `update pulso_iris.conversations
     set patient_id = $3::uuid,
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('sofiaStatus', 'queued'),
         updated_at = now()
     where tenant_id = $1::uuid and id = $2::uuid`,
    [event.tenantId, message.conversationId, patient.id]
  );

  await transaction.query(
    `insert into pulso_iris.outbox_events
       (tenant_id, event_type, event_version, aggregate_type, aggregate_id, payload, status, occurred_at)
     values ($1::uuid, $2, $3, 'message', $4::uuid, $5::jsonb, 'queued', $6::timestamptz)
     on conflict (tenant_id, event_type, aggregate_id) do nothing`,
    [
      event.tenantId,
      PULSO_MESSAGE_EVENT_TYPE,
      PULSO_MESSAGE_EVENT_VERSION,
      message.id,
      JSON.stringify({
        inboundEventId: payload.inboundEventId,
        threadBindingId: payload.threadBindingId,
        patientId: patient.id,
        conversationId: message.conversationId,
        messageId: message.id,
        occurredAt: event.occurredAt,
        sourceStreamId: payload.threadBindingId,
        sourceStreamSequence: streamSequence
      }),
      event.occurredAt
    ]
  );

  return {
    streamId: payload.threadBindingId,
    streamSequence,
    result: {
      eventId: event.id,
      patientId: patient.id,
      conversationId: message.conversationId,
      messageId: message.id,
      outboxEventType: PULSO_MESSAGE_EVENT_TYPE
    }
  };
}

function resolveChannelStreamPosition(
  event: ChannelInboundEvent,
  legacyPosition: ChannelEventPosition | undefined
): ChannelStreamPosition {
  if (isOrderedChannelInboundEvent(event)) {
    return { streamId: event.streamId, streamSequence: event.streamSequence };
  }
  if (!legacyPosition) throw new Error("Legacy Channel event has no owner-resolved stream position");
  if (legacyPosition.streamId !== event.payload.threadBindingId) {
    throw new ChannelSequenceConflictError();
  }
  return {
    streamId: legacyPosition.streamId,
    streamSequence: requirePositiveSequence(legacyPosition.streamSequence)
  };
}

function requireLegacyPositionResolver(
  resolver: LegacyChannelPositionResolver | undefined
): LegacyChannelPositionResolver {
  if (!resolver) throw new Error("Channel v1 compatibility requires an owner position resolver");
  return resolver;
}

async function findOrCreateActiveConversation(
  transaction: DatabaseExecutor,
  tenantId: string,
  patientId: string,
  threadConversationId: string | null,
  provider: string
): Promise<string> {
  if (threadConversationId) {
    const boundConversation = await transaction.query<ConversationRow>(
      `select id
       from pulso_iris.conversations
       where tenant_id = $1::uuid and id = $2::uuid and status in ('active', 'handoff_required')
       for update`,
      [tenantId, threadConversationId]
    );
    if (boundConversation.rows[0]) {
      return boundConversation.rows[0].id;
    }
  }

  const activeConversation = await transaction.query<ConversationRow>(
    `select id
     from pulso_iris.conversations
     where tenant_id = $1::uuid and patient_id = $2::uuid and channel = 'whatsapp'
       and status in ('active', 'handoff_required') and metadata->>'provider' = $3
     order by updated_at desc
     limit 1
     for update`,
    [tenantId, patientId, provider]
  );
  if (activeConversation.rows[0]) {
    return activeConversation.rows[0].id;
  }

  const created = await transaction.query<ConversationRow>(
    `insert into pulso_iris.conversations
       (tenant_id, patient_id, channel, direction, status, primary_intent, metadata)
     values ($1::uuid, $2::uuid, 'whatsapp', 'inbound', 'active', 'identifying',
             jsonb_build_object('provider', $3::text, 'origin', 'channel_inbound', 'sofiaStatus', 'queued'))
     returning id`,
    [tenantId, patientId, provider]
  );

  return requireRow(created.rows[0], "Conversation insert returned no row").id;
}

function constantTimeTextEquals(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function constantTimeHexEquals(left: string, right: string): boolean {
  return constantTimeTextEquals(left.toLowerCase(), right.toLowerCase());
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Channel event contains a non-JSON value");
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

class ChannelSequenceGapError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number
  ) {
    super("Channel event sequence contains a gap");
    this.name = "ChannelSequenceGapError";
  }
}

class ChannelSequenceConflictError extends Error {
  constructor() {
    super("Channel event sequence was already consumed");
    this.name = "ChannelSequenceConflictError";
  }
}

function requireNonNegativeSequence(value: string | number): number {
  const sequence = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("Channel thread has an invalid stream position");
  }
  return sequence;
}

function requirePositiveSequence(value: string | number): number {
  const sequence = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error("Channel event has an invalid durable stream position");
  }
  return sequence;
}

function isStreamSequenceUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const postgresError = error as { code?: unknown; constraint?: unknown };
  return postgresError.code === "23505" && postgresError.constraint === "uq_pulso_channel_inbox_stream_sequence";
}

export function readChannelInboundV1Compatibility(env: NodeJS.ProcessEnv): boolean {
  const value = env.CHANNEL_INBOUND_V1_COMPATIBILITY?.trim() || "disabled";
  if (value === "enabled") return true;
  if (value === "disabled") return false;
  throw new Error("CHANNEL_INBOUND_V1_COMPATIBILITY must be either enabled or disabled");
}

export function isOrderedChannelInboundEvent(event: ChannelInboundEvent): event is OrderedChannelInboundEvent {
  return event.type === CHANNEL_INBOUND_EVENT_V2_TYPE && event.version === ORDERED_EVENT_VERSION;
}

export function isLegacyChannelInboundEvent(event: ChannelInboundEvent): event is LegacyChannelInboundEvent {
  return event.type === CHANNEL_INBOUND_EVENT_V1_TYPE && event.version === LEGACY_EVENT_VERSION;
}
