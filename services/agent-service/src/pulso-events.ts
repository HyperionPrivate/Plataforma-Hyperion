import { createHash, timingSafeEqual } from "node:crypto";
import { envelope } from "@hyperion/platform-contracts";
import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
import { readInternalCredential, validateInternalAuthorization, type RouteRegistrar } from "@hyperion/service-runtime";
import { z } from "zod";
import {
  createLegacyPulsoPositionResolver,
  type LegacyPulsoPositionResolver,
  type PulsoEventPosition
} from "./pulso-position-client.js";

export const PULSO_MESSAGE_EVENT_V1_TYPE = "pulso.message.received.v1" as const;
export const PULSO_MESSAGE_EVENT_V2_TYPE = "pulso.message.received.v2" as const;

const uuid = z.string().uuid();
const positiveSequence = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const pulsoMessagePayloadV1Schema = z
  .object({
    inboundEventId: uuid,
    threadBindingId: uuid,
    patientId: uuid,
    conversationId: uuid,
    messageId: uuid,
    occurredAt: z.string().datetime()
  })
  .strict();

const pulsoMessagePayloadV2Schema = pulsoMessagePayloadV1Schema
  .extend({
    sourceStreamId: uuid,
    sourceStreamSequence: positiveSequence
  })
  .strict();

export const pulsoMessageEventV1Schema = z
  .object({
    id: uuid,
    type: z.literal(PULSO_MESSAGE_EVENT_V1_TYPE),
    version: z.literal(1),
    occurredAt: z.string().datetime(),
    tenantId: uuid,
    payload: pulsoMessagePayloadV1Schema
  })
  .strict();

export const pulsoMessageEventSchema = z
  .object({
    id: uuid,
    type: z.literal(PULSO_MESSAGE_EVENT_V2_TYPE),
    version: z.literal(2),
    occurredAt: z.string().datetime(),
    tenantId: uuid,
    streamId: uuid,
    streamSequence: positiveSequence,
    payload: pulsoMessagePayloadV2Schema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.streamId !== event.payload.conversationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["streamId"],
        message: "streamId must match payload.conversationId"
      });
    }
    if (event.payload.sourceStreamId !== event.payload.threadBindingId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "sourceStreamId"],
        message: "sourceStreamId must match payload.threadBindingId"
      });
    }
  });

export const compatiblePulsoMessageEventSchema = z.union([pulsoMessageEventSchema, pulsoMessageEventV1Schema]);

export type LegacyPulsoMessageEvent = z.infer<typeof pulsoMessageEventV1Schema>;
export type OrderedPulsoMessageEvent = z.infer<typeof pulsoMessageEventSchema>;
export type PulsoMessageEvent = LegacyPulsoMessageEvent | OrderedPulsoMessageEvent;

export type PulsoMessageConsumption =
  | { status: "accepted" | "duplicate"; jobId: string }
  | { status: "conflict" }
  | { status: "gap"; streamId: string; expectedSequence: number; receivedSequence: number };

interface PulsoMessagePosition {
  streamId: string;
  streamSequence: number;
  sourceStreamId: string;
  sourceStreamSequence: number;
}

interface ExistingInboxRow {
  payloadHash: string;
  streamId: string;
  streamSequence: string | number;
  sourceStreamId: string;
  sourceStreamSequence: string | number;
  result: { jobId?: unknown };
}

export interface PulsoMessageCompatibilityOptions {
  readonly allowLegacyV1?: boolean;
  readonly resolveLegacyPosition?: LegacyPulsoPositionResolver;
}

export const registerPulsoEventRoutes: RouteRegistrar = (app, context) => {
  const allowLegacyV1 = readPulsoMessageV1Compatibility(process.env);
  const sofiaToPulsoToken = readInternalCredential(process.env, "SOFIA_TO_PULSO_TOKEN");
  return registerPulsoEventRoutesWithCompatibility(app, context, {
    allowLegacyV1,
    resolveLegacyPosition: allowLegacyV1
      ? createLegacyPulsoPositionResolver({
          pulsoServiceUrl: process.env.PULSO_IRIS_SERVICE_URL ?? "http://localhost:8088",
          credential: sofiaToPulsoToken ?? ""
        })
      : undefined
  });
};

export function registerPulsoEventRoutesWithCompatibility(
  app: Parameters<RouteRegistrar>[0],
  context: Parameters<RouteRegistrar>[1],
  options: PulsoMessageCompatibilityOptions
): void {
  const pulsoToken = readInternalCredential(process.env, "PULSO_TO_SOFIA_TOKEN");
  const allowLegacyV1 = options.allowLegacyV1 === true;
  app.post("/internal/v1/events/pulso-message-received", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, { "pulso-iris-service": pulsoToken });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }
    const parsed = (allowLegacyV1 ? compatiblePulsoMessageEventSchema : pulsoMessageEventSchema).safeParse(
      request.body
    );
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid durable event" }, request.id));
    }
    if (isLegacyPulsoMessageEvent(parsed.data)) {
      context.logger.warn("legacy PULSO event accepted during the v2 rollout window", {
        requestId: request.id,
        eventId: parsed.data.id,
        tenantId: parsed.data.tenantId,
        compatibilityMode: "pulso_message_v1",
        targetContract: PULSO_MESSAGE_EVENT_V2_TYPE
      });
    }

    const legacyPosition = isLegacyPulsoMessageEvent(parsed.data)
      ? await requireLegacyPositionResolver(options.resolveLegacyPosition)(parsed.data)
      : undefined;
    const result = await consumePulsoMessageEvent(context.db, parsed.data, legacyPosition);
    if (result.status === "gap") {
      return reply.code(409).send(
        envelope(
          {
            error: "Event sequence gap",
            streamId: result.streamId,
            expectedSequence: result.expectedSequence,
            receivedSequence: result.receivedSequence
          },
          request.id
        )
      );
    }
    if (result.status === "conflict") {
      return reply
        .code(409)
        .send(envelope({ error: "Event identity or stream position conflicts with persisted state" }, request.id));
    }
    return reply
      .code(result.status === "accepted" ? 202 : 200)
      .send(envelope({ accepted: true, duplicate: result.status === "duplicate", jobId: result.jobId }, request.id));
  });
}

export function readPulsoMessageV1Compatibility(env: NodeJS.ProcessEnv): boolean {
  const value = env.PULSO_MESSAGE_V1_COMPATIBILITY?.trim() || "disabled";
  if (value !== "enabled" && value !== "disabled") {
    throw new Error("PULSO_MESSAGE_V1_COMPATIBILITY must be enabled or disabled");
  }
  return value === "enabled";
}

export async function consumePulsoMessageEvent(
  db: DatabaseClient,
  event: PulsoMessageEvent,
  legacyPosition?: PulsoEventPosition
): Promise<PulsoMessageConsumption> {
  const position = resolvePulsoMessagePosition(event, legacyPosition);
  const normalizedEvent = normalizePulsoMessageEvent(event, position);
  const payloadHash = createHash("sha256").update(canonicalJson(normalizedEvent)).digest("hex");
  const legacyPayloadHash = createHash("sha256")
    .update(canonicalJson(toLegacyPulsoMessageEvent(normalizedEvent)))
    .digest("hex");
  try {
    return await db.transaction(async (transaction) => {
      const acceptedPayloadHashes = [payloadHash, legacyPayloadHash];
      const existing = await readExistingInbox(transaction, event.id);
      const existingReplay = resolveExistingInboxReplay(existing, acceptedPayloadHashes, position);
      if (existingReplay) return existingReplay;

      await transaction.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `agent:pulso:${event.tenantId}:${position.streamId}`
      ]);

      // A concurrent delivery can insert the inbox row while this transaction
      // waits for the per-stream lock. READ COMMITTED gives this statement a
      // fresh snapshot, so re-read before evaluating the stream checkpoint.
      const concurrentlyPersisted = await readExistingInbox(transaction, event.id);
      const concurrentReplay = resolveExistingInboxReplay(concurrentlyPersisted, acceptedPayloadHashes, position);
      if (concurrentReplay) return concurrentReplay;

      await transaction.query(
        `insert into agent_runtime.pulso_stream_positions (tenant_id, stream_id, last_sequence)
         values ($1::uuid, $2::uuid, 0)
         on conflict (tenant_id, stream_id) do nothing`,
        [event.tenantId, position.streamId]
      );
      const checkpoint = await transaction.query<{ lastSequence: string | number }>(
        `select last_sequence as "lastSequence"
           from agent_runtime.pulso_stream_positions
          where tenant_id = $1::uuid and stream_id = $2::uuid
          for update`,
        [event.tenantId, position.streamId]
      );
      const lastSequence = requireNonNegativeSequence(checkpoint.rows[0]?.lastSequence, "consumer checkpoint");
      const expectedSequence = lastSequence + 1;
      if (position.streamSequence > expectedSequence) {
        throw new PulsoSequenceGapError(position.streamId, expectedSequence, position.streamSequence);
      }
      if (position.streamSequence < expectedSequence) throw new PulsoSequenceConflictError();

      const occupiedPosition = await transaction.query<{ eventId: string }>(
        `select event_id as "eventId"
           from agent_runtime.inbox_events
          where tenant_id = $1::uuid
            and source_service = 'pulso-iris-service'
            and stream_id = $2::uuid
            and stream_sequence = $3::bigint
          limit 1`,
        [event.tenantId, position.streamId, position.streamSequence]
      );
      if (occupiedPosition.rows[0]) throw new PulsoSequenceConflictError();

      await transaction.query(
        `insert into agent_runtime.inbox_events (
           event_id, tenant_id, source_service, event_type, event_version, payload_hash, occurred_at,
           stream_id, stream_sequence, source_stream_id, source_stream_sequence
         ) values (
           $1::uuid, $2::uuid, 'pulso-iris-service', $3, 2, $4, $5::timestamptz,
           $6::uuid, $7::bigint, $8::uuid, $9::bigint
         )`,
        [
          event.id,
          event.tenantId,
          PULSO_MESSAGE_EVENT_V2_TYPE,
          payloadHash,
          event.occurredAt,
          position.streamId,
          position.streamSequence,
          position.sourceStreamId,
          position.sourceStreamSequence
        ]
      );

      const insertedJob = await transaction.query<{ id: string }>(
        `insert into agent_runtime.jobs (
           tenant_id, conversation_id, inbound_event_id, idempotency_key, status, input,
           stream_id, stream_sequence, ordering_source
         ) values (
           $1::uuid, $2::uuid, $3::uuid, $4, 'queued', $5::jsonb,
           $2::uuid, $6::bigint, 'pulso_durable'
         )
         on conflict (tenant_id, inbound_event_id) do nothing
         returning id`,
        [
          event.tenantId,
          normalizedEvent.payload.conversationId,
          normalizedEvent.payload.inboundEventId,
          `sofia-inbound:${normalizedEvent.payload.inboundEventId}`,
          JSON.stringify({
            patientId: normalizedEvent.payload.patientId,
            messageId: normalizedEvent.payload.messageId,
            threadBindingId: normalizedEvent.payload.threadBindingId,
            occurredAt: normalizedEvent.payload.occurredAt,
            sourceStreamId: position.sourceStreamId,
            sourceStreamSequence: position.sourceStreamSequence,
            streamId: position.streamId,
            streamSequence: position.streamSequence
          }),
          position.streamSequence
        ]
      );
      const existingJob = insertedJob.rows[0]
        ? undefined
        : (
            await transaction.query<{ id: string; streamId: string; streamSequence: string | number }>(
              `select id, stream_id as "streamId", stream_sequence as "streamSequence"
                 from agent_runtime.jobs
                where tenant_id = $1::uuid and inbound_event_id = $2::uuid`,
              [event.tenantId, normalizedEvent.payload.inboundEventId]
            )
          ).rows[0];
      if (
        existingJob &&
        (existingJob.streamId !== position.streamId ||
          requirePositiveSequence(existingJob.streamSequence, "existing job") !== position.streamSequence)
      ) {
        throw new PulsoSequenceConflictError();
      }
      const jobId = insertedJob.rows[0]?.id ?? existingJob?.id;
      if (!jobId) throw new Error("Unable to create or recover SOFIA job");

      await transaction.query(
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
            metadata: {
              sourceEventType: event.type,
              orderedContract: PULSO_MESSAGE_EVENT_V2_TYPE,
              streamSequence: position.streamSequence
            }
          }),
          event.occurredAt
        ]
      );
      await transaction.query(
        `update agent_runtime.inbox_events
            set processed_at = now(), result = jsonb_build_object('jobId', $2::text)
          where event_id = $1::uuid`,
        [event.id, jobId]
      );
      const advanced = await transaction.query(
        `update agent_runtime.pulso_stream_positions
            set last_sequence = $3::bigint, updated_at = now()
          where tenant_id = $1::uuid and stream_id = $2::uuid and last_sequence = $4::bigint`,
        [event.tenantId, position.streamId, position.streamSequence, lastSequence]
      );
      if (advanced.rowCount !== 1) throw new Error("PULSO stream checkpoint changed during consumption");
      return { status: "accepted", jobId };
    });
  } catch (error) {
    if (error instanceof PulsoSequenceGapError) {
      return {
        status: "gap",
        streamId: error.streamId,
        expectedSequence: error.expected,
        receivedSequence: error.received
      };
    }
    if (error instanceof PulsoSequenceConflictError || isUniqueViolation(error)) return { status: "conflict" };
    throw error;
  }
}

async function readExistingInbox(
  transaction: DatabaseExecutor,
  eventId: string
): Promise<ExistingInboxRow | undefined> {
  const existingInbox = await transaction.query<ExistingInboxRow>(
    `select payload_hash as "payloadHash", stream_id as "streamId",
            stream_sequence as "streamSequence", source_stream_id as "sourceStreamId",
            source_stream_sequence as "sourceStreamSequence", result
       from agent_runtime.inbox_events
      where event_id = $1::uuid
      for update`,
    [eventId]
  );
  return existingInbox.rows[0];
}

function resolveExistingInboxReplay(
  existing: ExistingInboxRow | undefined,
  acceptedPayloadHashes: readonly string[],
  position: PulsoMessagePosition
): PulsoMessageConsumption | undefined {
  if (!existing) return undefined;
  if (!sameInboxContract(existing, acceptedPayloadHashes, position)) return { status: "conflict" };
  const jobId = typeof existing.result?.jobId === "string" ? existing.result.jobId : undefined;
  if (!jobId) throw new Error("Durable inbox replay is missing its result");
  return { status: "duplicate", jobId };
}

function resolvePulsoMessagePosition(
  event: PulsoMessageEvent,
  legacyPosition: PulsoEventPosition | undefined
): PulsoMessagePosition {
  if (!isLegacyPulsoMessageEvent(event)) {
    return {
      streamId: event.streamId,
      streamSequence: event.streamSequence,
      sourceStreamId: event.payload.sourceStreamId,
      sourceStreamSequence: event.payload.sourceStreamSequence
    };
  }

  if (!legacyPosition) throw new Error("Legacy PULSO event has no owner-resolved stream position");
  if (legacyPosition.streamId !== event.payload.conversationId) throw new PulsoSequenceConflictError();
  return {
    streamId: legacyPosition.streamId,
    streamSequence: requirePositiveSequence(legacyPosition.streamSequence, "legacy stream position"),
    sourceStreamId: legacyPosition.sourceStreamId,
    sourceStreamSequence: requirePositiveSequence(legacyPosition.sourceStreamSequence, "legacy source position")
  };
}

function requireLegacyPositionResolver(resolver: LegacyPulsoPositionResolver | undefined): LegacyPulsoPositionResolver {
  if (!resolver) throw new Error("PULSO v1 compatibility requires an owner position resolver");
  return resolver;
}

function normalizePulsoMessageEvent(
  event: PulsoMessageEvent,
  position: PulsoMessagePosition
): OrderedPulsoMessageEvent {
  return pulsoMessageEventSchema.parse({
    id: event.id,
    type: PULSO_MESSAGE_EVENT_V2_TYPE,
    version: 2,
    occurredAt: event.occurredAt,
    tenantId: event.tenantId,
    streamId: position.streamId,
    streamSequence: position.streamSequence,
    payload: {
      ...event.payload,
      sourceStreamId: position.sourceStreamId,
      sourceStreamSequence: position.sourceStreamSequence
    }
  });
}

function toLegacyPulsoMessageEvent(event: OrderedPulsoMessageEvent): LegacyPulsoMessageEvent {
  return pulsoMessageEventV1Schema.parse({
    id: event.id,
    type: PULSO_MESSAGE_EVENT_V1_TYPE,
    version: 1,
    occurredAt: event.occurredAt,
    tenantId: event.tenantId,
    payload: {
      inboundEventId: event.payload.inboundEventId,
      threadBindingId: event.payload.threadBindingId,
      patientId: event.payload.patientId,
      conversationId: event.payload.conversationId,
      messageId: event.payload.messageId,
      occurredAt: event.payload.occurredAt
    }
  });
}

function sameInboxContract(
  existing: ExistingInboxRow,
  acceptedPayloadHashes: readonly string[],
  position: PulsoMessagePosition
): boolean {
  return (
    acceptedPayloadHashes.some((payloadHash) => constantTimeHexEquals(existing.payloadHash, payloadHash)) &&
    existing.streamId === position.streamId &&
    requirePositiveSequence(existing.streamSequence, "inbox stream") === position.streamSequence &&
    existing.sourceStreamId === position.sourceStreamId &&
    requirePositiveSequence(existing.sourceStreamSequence, "inbox source stream") === position.sourceStreamSequence
  );
}

export function isLegacyPulsoMessageEvent(event: PulsoMessageEvent): event is LegacyPulsoMessageEvent {
  return event.type === PULSO_MESSAGE_EVENT_V1_TYPE;
}

function requirePositiveSequence(value: string | number | undefined, label: string): number {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error(`${label} is invalid`);
  return sequence;
}

function requireNonNegativeSequence(value: string | number | undefined, label: string): number {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`${label} is invalid`);
  return sequence;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

class PulsoSequenceGapError extends Error {
  constructor(
    readonly streamId: string,
    readonly expected: number,
    readonly received: number
  ) {
    super(`PULSO stream sequence gap: expected ${expected}, received ${received}`);
  }
}

class PulsoSequenceConflictError extends Error {}

function constantTimeHexEquals(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Durable event contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
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
