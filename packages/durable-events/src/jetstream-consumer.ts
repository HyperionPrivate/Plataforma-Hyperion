import { createHash } from "node:crypto";
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  ReplayPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
  type ConsumerConfig,
  type ConsumerInfo,
  type JetStreamManager,
  type JsMsg,
  type StreamConfig,
  type StreamInfo
} from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { JsonValue, OutboxEventEnvelope } from "./index.js";
import { natsInboxPrefix, readNatsAuthentication, type NatsAuthentication } from "./nats-auth.js";

export const HYPERION_EVENTS_STREAM = "HYPERION_EVENTS";
export const HYPERION_EVENT_SUBJECT_PREFIX = "hyperion.events";
export const HYPERION_DLQ_SUBJECT_PREFIX = "hyperion.dlq";
export const HYPERION_STREAM_SUBJECTS = ["hyperion.events.>", "hyperion.dlq.>"] as const;
export const HYPERION_STREAM_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const HYPERION_STREAM_MAX_MESSAGE_BYTES = 128 * 1_024;
export const HYPERION_STREAM_DUPLICATE_WINDOW_MS = 2 * 60 * 1_000;
// JetStream makes ack_wait equal to the first backoff entry when backoff is configured.
export const HYPERION_CONSUMER_ACK_WAIT_MS = 1_000;
export const HYPERION_CONSUMER_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const;
// The server must keep redelivering until this process has durably published a DLQ record.
export const HYPERION_CONSUMER_SERVER_MAX_DELIVER = -1;
// Application policy: a retry decision starts attempting DLQ delivery at this delivery count.
export const HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD = 12;
export const DEFAULT_JETSTREAM_PULL_EXPIRES_MS = 30_000;
export const DEFAULT_JETSTREAM_RECONNECT_DELAY_MS = 1_000;
export const DEFAULT_JETSTREAM_IDLE_DELAY_MS = 25;
export const DEFAULT_JETSTREAM_HANDLER_RETRY_DELAY_MS = 1_000;
export const DEFAULT_JETSTREAM_CONSUMER_TIMEOUT_MS = 5_000;

const NANOS_PER_MILLISECOND = 1_000_000;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const SAFE_SUBJECT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_NAME_LENGTH = 128;
const MAX_EVENT_TYPE_LENGTH = 256;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_SERVER_LENGTH = 2_048;
const MAX_SERVERS = 8;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const LEGACY_HYPERION_CONSUMER_SERVER_MAX_DELIVER = 12;
const ENVELOPE_KEYS = new Set(["id", "type", "version", "occurredAt", "tenantId", "payload"]);

export interface HyperionStreamConfiguration {
  readonly name: typeof HYPERION_EVENTS_STREAM;
  readonly subjects: readonly string[];
  readonly retention: typeof RetentionPolicy.Limits;
  readonly storage: typeof StorageType.File;
  readonly max_age: number;
  readonly max_msg_size: number;
  readonly duplicate_window: number;
  readonly max_msgs: number;
  readonly max_bytes: number;
  readonly max_msgs_per_subject: number;
  readonly discard: typeof DiscardPolicy.Old;
  readonly num_replicas: number;
}

export interface HyperionConsumerConfiguration {
  readonly durable_name: string;
  readonly ack_policy: typeof AckPolicy.Explicit;
  readonly deliver_policy: typeof DeliverPolicy.All;
  readonly replay_policy: typeof ReplayPolicy.Instant;
  readonly filter_subject: string;
  readonly max_ack_pending: 1;
  readonly ack_wait: number;
  readonly backoff: readonly number[];
  readonly max_deliver: typeof HYPERION_CONSUMER_SERVER_MAX_DELIVER;
}

/** Values observed from a server, including values that may represent configuration drift. */
export interface HyperionConsumerTopologySnapshot {
  readonly durable_name: string;
  readonly ack_policy: AckPolicy;
  readonly deliver_policy: DeliverPolicy;
  readonly replay_policy: ReplayPolicy;
  readonly filter_subject: string;
  readonly max_ack_pending: number;
  readonly ack_wait: number;
  readonly backoff: readonly number[];
  readonly max_deliver: number;
}

/** Injectable topology boundary used both by provisioning tests and the real adapter. */
export interface JetStreamTopologyAdapter {
  getStream(name: string): Promise<Readonly<Partial<HyperionStreamConfiguration>> | undefined>;
  addStream(configuration: HyperionStreamConfiguration): Promise<void>;
  getConsumer(
    stream: string,
    durableName: string
  ): Promise<Readonly<Partial<HyperionConsumerTopologySnapshot>> | undefined>;
  addConsumer(stream: string, configuration: HyperionConsumerConfiguration): Promise<void>;
  /** Updates the existing durable in place; implementations must never delete and recreate it. */
  updateConsumerMaxDeliver(
    stream: string,
    durableName: string,
    maxDeliver: typeof HYPERION_CONSUMER_SERVER_MAX_DELIVER
  ): Promise<void>;
}

export interface HyperionJetStreamTopologyOptions {
  readonly eventType: string;
  readonly durableName: string;
}

export interface HyperionJetStreamTopologyResult {
  readonly streamCreated: boolean;
  readonly consumerCreated: boolean;
  readonly legacyConsumerUpgraded: boolean;
}

export class JetStreamTopologyDriftError extends Error {
  readonly resource: "consumer" | "stream";

  constructor(resource: "consumer" | "stream") {
    super(`jetstream_${resource}_configuration_drift`);
    this.name = "JetStreamTopologyDriftError";
    this.resource = resource;
  }
}

export function hyperionStreamConfiguration(): HyperionStreamConfiguration {
  return {
    name: HYPERION_EVENTS_STREAM,
    subjects: [...HYPERION_STREAM_SUBJECTS],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_age: toNanos(HYPERION_STREAM_MAX_AGE_MS),
    max_msg_size: HYPERION_STREAM_MAX_MESSAGE_BYTES,
    duplicate_window: toNanos(HYPERION_STREAM_DUPLICATE_WINDOW_MS),
    max_msgs: -1,
    max_bytes: -1,
    max_msgs_per_subject: -1,
    discard: DiscardPolicy.Old,
    num_replicas: 1
  };
}

export function hyperionConsumerConfiguration(
  options: HyperionJetStreamTopologyOptions
): HyperionConsumerConfiguration {
  const eventType = requireEventType(options.eventType);
  const durableName = requireSafeName(options.durableName, "durableName");
  return {
    durable_name: durableName,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    replay_policy: ReplayPolicy.Instant,
    filter_subject: eventSubject(eventType),
    max_ack_pending: 1,
    ack_wait: toNanos(HYPERION_CONSUMER_ACK_WAIT_MS),
    backoff: HYPERION_CONSUMER_BACKOFF_MS.map(toNanos),
    max_deliver: HYPERION_CONSUMER_SERVER_MAX_DELIVER
  };
}

/**
 * Creates the fixed stream and one event-type pull consumer when absent. Existing
 * resources are accepted only when all delivery and retention invariants match.
 */
export async function ensureHyperionJetStreamTopology(
  adapter: JetStreamTopologyAdapter,
  options: HyperionJetStreamTopologyOptions
): Promise<HyperionJetStreamTopologyResult> {
  if (!isTopologyAdapter(adapter)) {
    throw new TypeError("adapter must implement the JetStream topology boundary");
  }

  const expectedStream = hyperionStreamConfiguration();
  const expectedConsumer = hyperionConsumerConfiguration(options);
  let streamCreated = false;
  let consumerCreated = false;
  let legacyConsumerUpgraded = false;

  let stream = await sanitizedTopologyRead(() => adapter.getStream(expectedStream.name));
  if (stream === undefined) {
    await sanitizedTopologyCreate(
      () => adapter.addStream(expectedStream),
      () => adapter.getStream(expectedStream.name)
    );
    streamCreated = true;
    stream = await sanitizedTopologyRead(() => adapter.getStream(expectedStream.name));
  }
  if (stream === undefined) {
    throw new Error("jetstream_stream_provisioning_failed");
  }
  assertCompatibleStream(stream, expectedStream);

  let consumer = await sanitizedTopologyRead(() =>
    adapter.getConsumer(expectedStream.name, expectedConsumer.durable_name)
  );
  if (consumer === undefined) {
    await sanitizedTopologyCreate(
      () => adapter.addConsumer(expectedStream.name, expectedConsumer),
      () => adapter.getConsumer(expectedStream.name, expectedConsumer.durable_name)
    );
    consumerCreated = true;
    consumer = await sanitizedTopologyRead(() =>
      adapter.getConsumer(expectedStream.name, expectedConsumer.durable_name)
    );
  }
  if (consumer === undefined) {
    throw new Error("jetstream_consumer_provisioning_failed");
  }
  if (isLegacyMaxDeliverOnlyDrift(consumer, expectedConsumer)) {
    await sanitizedTopologyUpdate(
      () =>
        adapter.updateConsumerMaxDeliver(
          expectedStream.name,
          expectedConsumer.durable_name,
          HYPERION_CONSUMER_SERVER_MAX_DELIVER
        ),
      () => adapter.getConsumer(expectedStream.name, expectedConsumer.durable_name)
    );
    legacyConsumerUpgraded = true;
    consumer = await sanitizedTopologyRead(() =>
      adapter.getConsumer(expectedStream.name, expectedConsumer.durable_name)
    );
  }
  if (consumer === undefined) {
    throw new Error("jetstream_consumer_upgrade_failed");
  }
  assertCompatibleConsumer(consumer, expectedConsumer);

  return { streamCreated, consumerCreated, legacyConsumerUpgraded };
}

export type JetStreamHandlerDecision =
  Readonly<{ action: "ack" }> | Readonly<{ action: "retry"; delayMs?: number }> | Readonly<{ action: "term" }>;

export interface JetStreamEventContext {
  readonly subject: string;
  readonly deliveryCount: number;
}

export type JetStreamEventHandler<TPayload extends JsonValue = JsonValue> = (
  event: OutboxEventEnvelope<TPayload>,
  context: JetStreamEventContext
) => Promise<JetStreamHandlerDecision> | JetStreamHandlerDecision;

export interface JetStreamConsumerMessage {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly deliveryCount: number;
  readonly streamSequence: number;
  ack(): Promise<void> | void;
  nak(delayMs?: number): Promise<void> | void;
  term(reasonCode?: string): Promise<void> | void;
}

export interface JetStreamConsumerPublishAck {
  readonly stream: string;
  readonly seq: number;
  readonly duplicate: boolean;
}

export interface JetStreamConsumerPublishOptions {
  readonly msgID: string;
  readonly timeout: number;
  readonly expect: Readonly<{ streamName: typeof HYPERION_EVENTS_STREAM }>;
}

/** Small injected session. It deliberately contains no credentials or connection metadata. */
export interface JetStreamConsumerSession {
  next(expiresMs: number): Promise<JetStreamConsumerMessage | null>;
  publish(
    subject: string,
    payload: Uint8Array,
    options: JetStreamConsumerPublishOptions
  ): Promise<JetStreamConsumerPublishAck>;
  /** Passive connection/durable check; it must not fetch a message. */
  check?(): Promise<void>;
  close(): Promise<void>;
}

export type JetStreamConsumerSessionFactory = () => Promise<JetStreamConsumerSession>;

export interface DurableJetStreamConsumerOptions<TPayload extends JsonValue = JsonValue> {
  readonly eventType: string;
  readonly durableName: string;
  readonly handler: JetStreamEventHandler<TPayload>;
  readonly servers?: string | readonly string[];
  readonly connectionName?: string;
  readonly authToken?: string;
  readonly username?: string;
  readonly password?: string;
  /** Administrative CREATE/UPDATE is reserved for the topology bootstrap in production. */
  readonly provisionTopology?: boolean;
  readonly sessionFactory?: JetStreamConsumerSessionFactory;
  readonly pullExpiresMs?: number;
  readonly reconnectDelayMs?: number;
  readonly idleDelayMs?: number;
  readonly retryDelayMs?: number;
  readonly publishTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly maxPayloadBytes?: number;
  readonly now?: () => Date;
}

export type JetStreamConsumeStatus = "acked" | "dlq_failed" | "idle" | "retried" | "session_error" | "terminated";

export interface JetStreamConsumeResult {
  readonly status: JetStreamConsumeStatus;
  readonly deliveryCount?: number;
}

type PermanentFailureReason =
  "handler_term" | "invalid_envelope" | "invalid_json" | "invalid_subject" | "payload_too_large" | "retry_threshold";

type ParsedEvent<TPayload extends JsonValue> =
  | Readonly<{ ok: true; event: OutboxEventEnvelope<TPayload> }>
  | Readonly<{
      ok: false;
      reason: Exclude<PermanentFailureReason, "handler_term" | "invalid_subject" | "retry_threshold">;
    }>;

/** Sequential durable pull consumer with explicit, post-handler acknowledgement. */
export class DurableJetStreamConsumer<TPayload extends JsonValue = JsonValue> {
  readonly eventType: string;
  readonly durableName: string;
  readonly pullExpiresMs: number;
  readonly reconnectDelayMs: number;
  readonly idleDelayMs: number;
  readonly retryDelayMs: number;
  readonly publishTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly maxPayloadBytes: number;

  readonly #handler: JetStreamEventHandler<TPayload>;
  readonly #sessionFactory: JetStreamConsumerSessionFactory;
  readonly #now: () => Date;

  #session: JetStreamConsumerSession | undefined;
  #sessionPromise: Promise<JetStreamConsumerSession> | undefined;
  #activeConsume: Promise<JetStreamConsumeResult> | undefined;
  #loop: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopping = false;
  #started = false;
  #delayCancel: (() => void) | undefined;

  constructor(options: DurableJetStreamConsumerOptions<TPayload>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("DurableJetStreamConsumer options are required");
    }
    this.eventType = requireEventType(options.eventType);
    this.durableName = requireSafeName(options.durableName, "durableName");
    if (typeof options.handler !== "function") {
      throw new TypeError("handler must be a function");
    }
    this.#handler = options.handler;
    this.pullExpiresMs = requireBoundedInteger(
      options.pullExpiresMs ?? DEFAULT_JETSTREAM_PULL_EXPIRES_MS,
      "pullExpiresMs",
      1_000,
      60_000
    );
    this.reconnectDelayMs = requireBoundedInteger(
      options.reconnectDelayMs ?? DEFAULT_JETSTREAM_RECONNECT_DELAY_MS,
      "reconnectDelayMs",
      1,
      60_000
    );
    this.idleDelayMs = requireBoundedInteger(
      options.idleDelayMs ?? DEFAULT_JETSTREAM_IDLE_DELAY_MS,
      "idleDelayMs",
      1,
      60_000
    );
    this.retryDelayMs = requireBoundedInteger(
      options.retryDelayMs ?? DEFAULT_JETSTREAM_HANDLER_RETRY_DELAY_MS,
      "retryDelayMs",
      1,
      MAX_RETRY_DELAY_MS
    );
    this.publishTimeoutMs = requireBoundedInteger(
      options.publishTimeoutMs ?? DEFAULT_JETSTREAM_CONSUMER_TIMEOUT_MS,
      "publishTimeoutMs",
      1,
      60_000
    );
    this.connectTimeoutMs = requireBoundedInteger(
      options.connectTimeoutMs ?? DEFAULT_JETSTREAM_CONSUMER_TIMEOUT_MS,
      "connectTimeoutMs",
      1,
      60_000
    );
    this.maxPayloadBytes = requireBoundedInteger(
      options.maxPayloadBytes ?? HYPERION_STREAM_MAX_MESSAGE_BYTES,
      "maxPayloadBytes",
      1,
      HYPERION_STREAM_MAX_MESSAGE_BYTES
    );
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new TypeError("now must be a function");
    }
    this.#now = options.now ?? (() => new Date());

    const servers = normalizeServers(options.servers);
    const connectionName = requireSafeName(options.connectionName ?? this.durableName, "connectionName");
    const authentication = readNatsAuthentication({
      authToken: options.authToken,
      username: options.username,
      password: options.password
    });
    const provisionTopology = requireOptionalBoolean(options.provisionTopology, "provisionTopology") ?? false;
    if (options.sessionFactory !== undefined) {
      if (typeof options.sessionFactory !== "function") {
        throw new TypeError("sessionFactory must be a function");
      }
      this.#sessionFactory = options.sessionFactory;
    } else {
      this.#sessionFactory = createNatsJetStreamConsumerSessionFactory({
        eventType: this.eventType,
        durableName: this.durableName,
        servers,
        connectionName,
        ...authentication,
        provisionTopology,
        connectTimeoutMs: this.connectTimeoutMs,
        publishTimeoutMs: this.publishTimeoutMs
      });
    }
  }

  get isRunning(): boolean {
    return this.#started && !this.#stopping;
  }

  /** Authenticates and binds the configured durable before the service starts listening. */
  async initialize(): Promise<void> {
    await this.#getSession();
  }

  /** Revalidates the connection and durable without pulling a message. */
  async checkReadiness(): Promise<void> {
    let session: JetStreamConsumerSession | undefined;
    try {
      session = await this.#getSession();
      await withinReadinessTimeout(Promise.resolve(session.check?.()), this.connectTimeoutMs);
    } catch {
      if (session !== undefined) {
        await this.#invalidateSession(session);
      }
      throw new Error("jetstream_consumer_not_ready");
    }
  }

  /** Starts one background loop. Repeated calls while running are no-ops. */
  start(): void {
    if (this.#started || this.#stopping) {
      return;
    }
    this.#started = true;
    const loop = this.#runLoop();
    this.#loop = loop;
    void loop.then(
      () => this.#releaseLoop(loop),
      () => this.#releaseLoop(loop)
    );
  }

  /** Stops a pull immediately, waits for active handling, and closes exactly one session. */
  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    const stop = this.#runStop();
    this.#stopPromise = stop;
    void stop.then(
      () => this.#releaseStop(stop),
      () => this.#releaseStop(stop)
    );
    return stop;
  }

  /** Pulls and handles at most one message. Concurrent callers share the same operation. */
  consumeOnce(): Promise<JetStreamConsumeResult> {
    if (this.#stopping) {
      return Promise.resolve({ status: "idle" });
    }
    if (this.#activeConsume !== undefined) {
      return this.#activeConsume;
    }
    const consume = this.#consumeOnce();
    this.#activeConsume = consume;
    void consume.then(
      () => this.#releaseConsume(consume),
      () => this.#releaseConsume(consume)
    );
    return consume;
  }

  async #runLoop(): Promise<void> {
    while (this.#started && !this.#stopping) {
      const result = await this.consumeOnce();
      if (!this.#started || this.#stopping) {
        return;
      }
      if (result.status === "session_error") {
        await this.#unreferencedDelay(this.reconnectDelayMs);
      } else if (result.status === "idle") {
        await this.#unreferencedDelay(this.idleDelayMs);
      }
    }
  }

  async #runStop(): Promise<void> {
    this.#stopping = true;
    this.#started = false;
    this.#delayCancel?.();

    const session = this.#session;
    this.#session = undefined;
    if (session !== undefined) {
      await sanitizedSessionClose(session);
    }

    try {
      await this.#sessionPromise;
      await this.#activeConsume;
      await this.#loop;
    } finally {
      const lateSession = this.#session;
      this.#session = undefined;
      this.#sessionPromise = undefined;
      if (lateSession !== undefined && lateSession !== session) {
        await sanitizedSessionClose(lateSession);
      }
      this.#loop = undefined;
      this.#stopping = false;
    }
  }

  async #consumeOnce(): Promise<JetStreamConsumeResult> {
    let session: JetStreamConsumerSession;
    try {
      session = await this.#getSession();
    } catch {
      return { status: "session_error" };
    }

    let message: JetStreamConsumerMessage | null;
    try {
      message = await session.next(this.pullExpiresMs);
    } catch {
      await this.#invalidateSession(session);
      return { status: "session_error" };
    }
    if (message === null) {
      return { status: "idle" };
    }
    if (!isConsumerMessage(message)) {
      await this.#invalidateSession(session);
      return { status: "session_error" };
    }
    return this.#processMessage(session, message);
  }

  async #processMessage(
    session: JetStreamConsumerSession,
    message: JetStreamConsumerMessage
  ): Promise<JetStreamConsumeResult> {
    const expectedSubject = eventSubject(this.eventType);
    if (message.subject !== expectedSubject) {
      return this.#deadLetterOrRetry(session, message, undefined, "invalid_subject");
    }

    const parsed = parseEventEnvelope<TPayload>(message.data, this.eventType, this.maxPayloadBytes);
    if (!parsed.ok) {
      return this.#deadLetterOrRetry(session, message, undefined, parsed.reason);
    }

    let decision: JetStreamHandlerDecision;
    try {
      decision = await this.#handler(parsed.event, {
        subject: expectedSubject,
        deliveryCount: message.deliveryCount
      });
    } catch {
      decision = { action: "retry" };
    }

    if (!isHandlerDecision(decision)) {
      decision = { action: "retry" };
    }
    if (decision.action === "ack") {
      try {
        await message.ack();
        return { status: "acked", deliveryCount: message.deliveryCount };
      } catch {
        await this.#invalidateSession(session);
        return { status: "session_error", deliveryCount: message.deliveryCount };
      }
    }
    if (decision.action === "term") {
      return this.#deadLetterOrRetry(session, message, parsed.event.id, "handler_term");
    }
    if (message.deliveryCount >= HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD) {
      return this.#deadLetterOrRetry(session, message, parsed.event.id, "retry_threshold");
    }

    const delayMs = normalizeHandlerRetryDelay(decision.delayMs, this.retryDelayMs);
    try {
      await message.nak(delayMs);
      return { status: "retried", deliveryCount: message.deliveryCount };
    } catch {
      await this.#invalidateSession(session);
      return { status: "session_error", deliveryCount: message.deliveryCount };
    }
  }

  async #deadLetterOrRetry(
    session: JetStreamConsumerSession,
    message: JetStreamConsumerMessage,
    sourceEventId: string | undefined,
    reason: PermanentFailureReason
  ): Promise<JetStreamConsumeResult> {
    const dlqId = deadLetterMessageId(this.eventType, sourceEventId, message.data, message.streamSequence);
    const record = {
      sourceEventId: sourceEventId ?? null,
      sourceEventType: this.eventType,
      sourceSubject: eventSubject(this.eventType),
      deliveryCount: message.deliveryCount,
      reason,
      failedAt: safeNow(this.#now)
    } satisfies JsonValue;
    const payload = new TextEncoder().encode(JSON.stringify(record));

    try {
      const ack = await session.publish(`${HYPERION_DLQ_SUBJECT_PREFIX}.${this.eventType}`, payload, {
        msgID: dlqId,
        timeout: this.publishTimeoutMs,
        expect: { streamName: HYPERION_EVENTS_STREAM }
      });
      if (!isValidPublishAck(ack)) {
        throw new Error("invalid_publish_ack");
      }
    } catch {
      try {
        await message.nak(this.retryDelayMs);
      } catch {
        await this.#invalidateSession(session);
      }
      return { status: "dlq_failed", deliveryCount: message.deliveryCount };
    }

    try {
      await message.term(reason);
      return { status: "terminated", deliveryCount: message.deliveryCount };
    } catch {
      await this.#invalidateSession(session);
      return { status: "session_error", deliveryCount: message.deliveryCount };
    }
  }

  async #getSession(): Promise<JetStreamConsumerSession> {
    if (this.#session !== undefined) {
      return this.#session;
    }
    if (this.#sessionPromise !== undefined) {
      return this.#sessionPromise;
    }

    const pending = Promise.resolve().then(() => this.#sessionFactory());
    this.#sessionPromise = pending;
    try {
      const session = await pending;
      if (!isConsumerSession(session)) {
        throw new TypeError("invalid_consumer_session");
      }
      if (this.#stopping) {
        await sanitizedSessionClose(session);
        throw new Error("consumer_stopping");
      }
      this.#session = session;
      return session;
    } catch {
      throw new Error("jetstream_consumer_connection_error");
    } finally {
      if (this.#sessionPromise === pending) {
        this.#sessionPromise = undefined;
      }
    }
  }

  async #invalidateSession(session: JetStreamConsumerSession): Promise<void> {
    if (this.#session === session) {
      this.#session = undefined;
    }
    await sanitizedSessionClose(session);
  }

  #releaseConsume(consume: Promise<JetStreamConsumeResult>): void {
    if (this.#activeConsume === consume) {
      this.#activeConsume = undefined;
    }
  }

  #releaseLoop(loop: Promise<void>): void {
    if (this.#loop === loop) {
      this.#loop = undefined;
    }
    this.#started = false;
  }

  #releaseStop(stop: Promise<void>): void {
    if (this.#stopPromise === stop) {
      this.#stopPromise = undefined;
    }
  }

  #unreferencedDelay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.#delayCancel = undefined;
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);
      timer.unref?.();
      this.#delayCancel = () => {
        clearTimeout(timer);
        finish();
      };
    });
  }
}

export interface NatsJetStreamConsumerSessionFactoryOptions {
  readonly eventType: string;
  readonly durableName: string;
  readonly servers?: string | readonly string[];
  readonly connectionName: string;
  readonly authToken?: string;
  readonly username?: string;
  readonly password?: string;
  readonly provisionTopology?: boolean;
  readonly connectTimeoutMs?: number;
  readonly publishTimeoutMs?: number;
}

/** Real @nats-io adapter. Secrets stay captured in the factory closure. */
export function createNatsJetStreamConsumerSessionFactory(
  options: NatsJetStreamConsumerSessionFactoryOptions
): JetStreamConsumerSessionFactory {
  const eventType = requireEventType(options.eventType);
  const durableName = requireSafeName(options.durableName, "durableName");
  const servers = normalizeServers(options.servers);
  const connectionName = requireSafeName(options.connectionName, "connectionName");
  const authentication = readNatsAuthentication({
    authToken: options.authToken,
    username: options.username,
    password: options.password
  });
  const provisionTopology = requireOptionalBoolean(options.provisionTopology, "provisionTopology") ?? false;
  const connectTimeoutMs = requireBoundedInteger(
    options.connectTimeoutMs ?? DEFAULT_JETSTREAM_CONSUMER_TIMEOUT_MS,
    "connectTimeoutMs",
    1,
    60_000
  );
  const publishTimeoutMs = requireBoundedInteger(
    options.publishTimeoutMs ?? DEFAULT_JETSTREAM_CONSUMER_TIMEOUT_MS,
    "publishTimeoutMs",
    1,
    60_000
  );

  return async () => {
    let connection: NatsConnection | undefined;
    try {
      connection = await connect({
        servers,
        name: connectionName,
        timeout: connectTimeoutMs,
        inboxPrefix: natsInboxPrefix(authentication),
        ...toNatsConnectionAuthentication(authentication)
      });
      await connection.flush();
      const client = jetstream(connection, { timeout: publishTimeoutMs });
      if (provisionTopology) {
        const manager = await jetstreamManager(connection, { timeout: connectTimeoutMs });
        const adapter = createNatsTopologyAdapter(manager);
        await ensureHyperionJetStreamTopology(adapter, { eventType, durableName });
      }
      const consumer = await client.consumers.get(HYPERION_EVENTS_STREAM, durableName);
      assertCompatibleConsumer(
        mapConsumerInfo(await consumer.info(true)),
        hyperionConsumerConfiguration({ eventType, durableName })
      );
      const ownedConnection = connection;

      return {
        next: async (expiresMs) => {
          const message = await consumer.next({ expires: expiresMs });
          return message === null ? null : adaptNatsMessage(message);
        },
        publish: (subject, payload, publishOptions) => client.publish(subject, payload, publishOptions),
        check: async () => {
          if (ownedConnection.isClosed()) {
            throw new Error("jetstream_connection_closed");
          }
          await ownedConnection.flush();
          assertCompatibleConsumer(
            mapConsumerInfo(await consumer.info(true)),
            hyperionConsumerConfiguration({ eventType, durableName })
          );
        },
        close: async () => {
          if (!ownedConnection.isClosed()) {
            try {
              await ownedConnection.drain();
            } catch {
              if (!ownedConnection.isClosed()) {
                await ownedConnection.close();
              }
            }
          }
        }
      };
    } catch {
      if (connection !== undefined && !connection.isClosed()) {
        try {
          await connection.close();
        } catch {
          // Preserve only the stable connection classification.
        }
      }
      throw new Error("jetstream_consumer_connection_error");
    }
  };
}

export function createNatsTopologyAdapter(manager: JetStreamManager): JetStreamTopologyAdapter {
  return {
    getStream: async (name) => {
      try {
        return mapStreamInfo(await manager.streams.info(name));
      } catch (error) {
        if (isNotFound(error, JetStreamApiCodes.StreamNotFound)) {
          return undefined;
        }
        throw new Error("jetstream_topology_read_error", { cause: error });
      }
    },
    addStream: async (configuration) => {
      await manager.streams.add(toNatsStreamConfiguration(configuration));
    },
    getConsumer: async (stream, durableName) => {
      try {
        return mapConsumerInfo(await manager.consumers.info(stream, durableName));
      } catch (error) {
        if (isNotFound(error, JetStreamApiCodes.ConsumerNotFound)) {
          return undefined;
        }
        throw new Error("jetstream_topology_read_error", { cause: error });
      }
    },
    addConsumer: async (stream, configuration) => {
      await manager.consumers.add(stream, toNatsConsumerConfiguration(configuration));
    },
    updateConsumerMaxDeliver: async (stream, durableName, maxDeliver) => {
      await manager.consumers.update(stream, durableName, { max_deliver: maxDeliver });
    }
  };
}

function mapStreamInfo(info: StreamInfo): HyperionStreamConfiguration {
  const config = info.config;
  return {
    name: HYPERION_EVENTS_STREAM,
    subjects: [...config.subjects],
    retention: config.retention as typeof RetentionPolicy.Limits,
    storage: config.storage as typeof StorageType.File,
    max_age: config.max_age,
    max_msg_size: config.max_msg_size,
    duplicate_window: config.duplicate_window,
    max_msgs: config.max_msgs,
    max_bytes: config.max_bytes,
    max_msgs_per_subject: config.max_msgs_per_subject,
    discard: config.discard as typeof DiscardPolicy.Old,
    num_replicas: config.num_replicas
  };
}

function mapConsumerInfo(info: ConsumerInfo): HyperionConsumerTopologySnapshot {
  const config = info.config;
  return {
    durable_name: config.durable_name ?? info.name,
    ack_policy: config.ack_policy as typeof AckPolicy.Explicit,
    deliver_policy: config.deliver_policy as typeof DeliverPolicy.All,
    replay_policy: config.replay_policy as typeof ReplayPolicy.Instant,
    filter_subject: config.filter_subject ?? "",
    max_ack_pending: config.max_ack_pending as 1,
    ack_wait: config.ack_wait ?? 0,
    backoff: [...(config.backoff ?? [])],
    max_deliver: config.max_deliver ?? 0
  };
}

function toNatsStreamConfiguration(
  configuration: HyperionStreamConfiguration
): Partial<StreamConfig> & { name: string } {
  return {
    ...configuration,
    subjects: [...configuration.subjects]
  };
}

function toNatsConsumerConfiguration(configuration: HyperionConsumerConfiguration): Partial<ConsumerConfig> {
  return {
    ...configuration,
    backoff: [...configuration.backoff]
  };
}

function adaptNatsMessage(message: JsMsg): JetStreamConsumerMessage {
  const info = message.info;
  return {
    subject: message.subject,
    data: message.data,
    deliveryCount: info.deliveryCount,
    streamSequence: info.streamSequence,
    ack: async () => {
      const confirmed = await message.ackAck();
      if (!confirmed) {
        throw new Error("jetstream_ack_not_confirmed");
      }
    },
    nak: (delayMs) => message.nak(delayMs),
    term: (reasonCode) => message.term(reasonCode)
  };
}

function assertCompatibleStream(
  actual: Readonly<Partial<HyperionStreamConfiguration>>,
  expected: HyperionStreamConfiguration
): void {
  if (
    actual.name !== expected.name ||
    !sameStringSet(actual.subjects, expected.subjects) ||
    actual.retention !== expected.retention ||
    actual.storage !== expected.storage ||
    actual.max_age !== expected.max_age ||
    actual.max_msg_size !== expected.max_msg_size ||
    actual.duplicate_window !== expected.duplicate_window ||
    actual.max_msgs !== expected.max_msgs ||
    actual.max_bytes !== expected.max_bytes ||
    actual.max_msgs_per_subject !== expected.max_msgs_per_subject ||
    actual.discard !== expected.discard ||
    actual.num_replicas !== expected.num_replicas
  ) {
    throw new JetStreamTopologyDriftError("stream");
  }
}

function assertCompatibleConsumer(
  actual: Readonly<Partial<HyperionConsumerTopologySnapshot>>,
  expected: HyperionConsumerConfiguration
): void {
  if (!isCompatibleConsumer(actual, expected)) {
    throw new JetStreamTopologyDriftError("consumer");
  }
}

function isCompatibleConsumer(
  actual: Readonly<Partial<HyperionConsumerTopologySnapshot>>,
  expected: HyperionConsumerConfiguration
): boolean {
  return (
    actual.durable_name === expected.durable_name &&
    actual.ack_policy === expected.ack_policy &&
    actual.deliver_policy === expected.deliver_policy &&
    actual.replay_policy === expected.replay_policy &&
    actual.filter_subject === expected.filter_subject &&
    actual.max_ack_pending === expected.max_ack_pending &&
    actual.ack_wait === expected.ack_wait &&
    sameNumberArray(actual.backoff, expected.backoff) &&
    actual.max_deliver === expected.max_deliver
  );
}

function isLegacyMaxDeliverOnlyDrift(
  actual: Readonly<Partial<HyperionConsumerTopologySnapshot>>,
  expected: HyperionConsumerConfiguration
): boolean {
  return (
    actual.max_deliver === LEGACY_HYPERION_CONSUMER_SERVER_MAX_DELIVER &&
    isCompatibleConsumer({ ...actual, max_deliver: expected.max_deliver }, expected)
  );
}

async function sanitizedTopologyRead<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof JetStreamTopologyDriftError) {
      throw error;
    }
    throw new Error("jetstream_topology_read_error", { cause: error });
  }
}

async function sanitizedTopologyCreate<T>(
  create: () => Promise<void>,
  read: () => Promise<T | undefined>
): Promise<void> {
  try {
    await create();
    return;
  } catch {
    // An idempotent concurrent creator may have won. Verify by reading it back.
  }
  const resource = await sanitizedTopologyRead(read);
  if (resource === undefined) {
    throw new Error("jetstream_topology_create_error");
  }
}

async function sanitizedTopologyUpdate<T>(
  update: () => Promise<void>,
  read: () => Promise<T | undefined>
): Promise<void> {
  try {
    await update();
    return;
  } catch {
    // A concurrent instance may have completed the same narrow migration.
  }
  const resource = await sanitizedTopologyRead(read);
  if (resource === undefined) {
    throw new Error("jetstream_topology_update_error");
  }
}

function parseEventEnvelope<TPayload extends JsonValue>(
  data: Uint8Array,
  expectedType: string,
  maxPayloadBytes: number
): ParsedEvent<TPayload> {
  if (data.byteLength > maxPayloadBytes) {
    return { ok: false, reason: "payload_too_large" };
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isPlainObject(value)) {
    return { ok: false, reason: "invalid_envelope" };
  }
  if (
    Object.keys(value).length !== ENVELOPE_KEYS.size ||
    !Object.keys(value).every((key) => ENVELOPE_KEYS.has(key)) ||
    ![...ENVELOPE_KEYS].every((key) => Object.hasOwn(value, key)) ||
    !isSafeIdentifier(value.id, MAX_EVENT_ID_LENGTH) ||
    value.type !== expectedType ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) <= 0 ||
    typeof value.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(value.occurredAt)) ||
    (value.tenantId !== null && !isSafeIdentifier(value.tenantId, MAX_EVENT_ID_LENGTH)) ||
    !isJsonValue(value.payload)
  ) {
    return { ok: false, reason: "invalid_envelope" };
  }
  return {
    ok: true,
    event: {
      id: value.id,
      type: value.type,
      version: value.version as number,
      occurredAt: value.occurredAt,
      tenantId: value.tenantId as string | null,
      payload: value.payload as TPayload
    }
  };
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((entry, index) => index in value && isJsonValue(entry, ancestors));
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(
      (descriptor) => descriptor.enumerable && "value" in descriptor && isJsonValue(descriptor.value, ancestors)
    );
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isHandlerDecision(value: unknown): value is JetStreamHandlerDecision {
  if (!isPlainObject(value) || (value.action !== "ack" && value.action !== "retry" && value.action !== "term")) {
    return false;
  }
  if (value.action !== "retry") {
    return value.delayMs === undefined;
  }
  return value.delayMs === undefined || isBoundedInteger(value.delayMs, 0, MAX_RETRY_DELAY_MS);
}

function isValidPublishAck(value: unknown): value is JetStreamConsumerPublishAck {
  if (!value || typeof value !== "object") {
    return false;
  }
  const ack = value as Partial<JetStreamConsumerPublishAck>;
  return (
    ack.stream === HYPERION_EVENTS_STREAM &&
    Number.isSafeInteger(ack.seq) &&
    (ack.seq ?? 0) > 0 &&
    typeof ack.duplicate === "boolean"
  );
}

function isTopologyAdapter(value: unknown): value is JetStreamTopologyAdapter {
  if (!value || typeof value !== "object") {
    return false;
  }
  const adapter = value as Partial<JetStreamTopologyAdapter>;
  return (
    typeof adapter.getStream === "function" &&
    typeof adapter.addStream === "function" &&
    typeof adapter.getConsumer === "function" &&
    typeof adapter.addConsumer === "function" &&
    typeof adapter.updateConsumerMaxDeliver === "function"
  );
}

function isConsumerSession(value: unknown): value is JetStreamConsumerSession {
  if (!value || typeof value !== "object") {
    return false;
  }
  const session = value as Partial<JetStreamConsumerSession>;
  return (
    typeof session.next === "function" && typeof session.publish === "function" && typeof session.close === "function"
  );
}

function isConsumerMessage(value: unknown): value is JetStreamConsumerMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const message = value as Partial<JetStreamConsumerMessage>;
  return (
    typeof message.subject === "string" &&
    message.data instanceof Uint8Array &&
    Number.isSafeInteger(message.deliveryCount) &&
    (message.deliveryCount ?? 0) > 0 &&
    Number.isSafeInteger(message.streamSequence) &&
    (message.streamSequence ?? 0) > 0 &&
    typeof message.ack === "function" &&
    typeof message.nak === "function" &&
    typeof message.term === "function"
  );
}

function isNotFound(error: unknown, apiCode: number): boolean {
  return error instanceof JetStreamApiError && (error.code === apiCode || error.status === 404);
}

async function sanitizedSessionClose(session: JetStreamConsumerSession): Promise<void> {
  try {
    await session.close();
  } catch {
    // Closing is best-effort and must not leak transport details.
  }
}

function normalizeServers(value: string | readonly string[] | undefined): string | string[] {
  const input = value ?? "nats://127.0.0.1:4222";
  if (typeof input === "string") {
    return requireSafeServer(input);
  }
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SERVERS) {
    throw new TypeError(`servers must contain between 1 and ${MAX_SERVERS} entries`);
  }
  return input.map(requireSafeServer);
}

function requireSafeServer(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("servers must contain safe NATS URLs");
  }
  const server = value.trim();
  if (!isSafeText(server, MAX_SERVER_LENGTH)) {
    throw new TypeError("servers must contain safe NATS URLs");
  }
  try {
    const url = new URL(server);
    if (
      (url.protocol !== "nats:" && url.protocol !== "tls:") ||
      url.username ||
      url.password ||
      !url.hostname ||
      url.pathname !== "" ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("invalid_server");
    }
  } catch {
    throw new TypeError("servers must contain safe credential-free NATS URLs");
  }
  return server;
}

function requireSafeName(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_NAME_LENGTH ||
    !SAFE_NAME_PATTERN.test(value)
  ) {
    throw new TypeError(`${field} must be a safe NATS name`);
  }
  return value;
}

function requireEventType(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EVENT_TYPE_LENGTH ||
    !value.split(".").every((token) => token.length > 0 && SAFE_SUBJECT_TOKEN_PATTERN.test(token))
  ) {
    throw new TypeError("eventType must contain only safe NATS subject tokens");
  }
  return value;
}

function eventSubject(eventType: string): string {
  return `${HYPERION_EVENT_SUBJECT_PREFIX}.${eventType}`;
}

function requireBoundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!isBoundedInteger(value, minimum, maximum)) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireOptionalBoolean(value: boolean | undefined, field: string): boolean | undefined {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }
  return value;
}

function toNatsConnectionAuthentication(
  authentication: NatsAuthentication | undefined
): Record<string, never> | Readonly<{ token: string }> | Readonly<{ user: string; pass: string }> {
  if (authentication === undefined) return {};
  if (authentication.authToken !== undefined) return { token: authentication.authToken };
  return { user: authentication.username, pass: authentication.password };
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

async function withinReadinessTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("jetstream_readiness_timeout")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function toNanos(milliseconds: number): number {
  return milliseconds * NANOS_PER_MILLISECOND;
}

function sameStringSet(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value)) &&
    new Set(actual).size === actual.length
  );
}

function sameNumberArray(actual: readonly number[] | undefined, expected: readonly number[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value, index) => actual[index] === value)
  );
}

function isSafeIdentifier(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && SAFE_NAME_PATTERN.test(value) && value.length <= maximumLength;
}

function isSafeText(value: string, maximumLength: number): boolean {
  if (value.length === 0 || value.length > maximumLength) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) {
      return false;
    }
  }
  return true;
}

function normalizeHandlerRetryDelay(value: number | undefined, fallback: number): number {
  return isBoundedInteger(value, 0, MAX_RETRY_DELAY_MS) ? value : fallback;
}

function deadLetterMessageId(
  eventType: string,
  sourceEventId: string | undefined,
  data: Uint8Array,
  streamSequence: number
): string {
  if (sourceEventId !== undefined && isSafeIdentifier(sourceEventId, MAX_EVENT_ID_LENGTH)) {
    const digest = createHash("sha256").update(eventType).update("\0").update(sourceEventId).digest("hex");
    return `dlq-event-${digest}`;
  }
  const digest = createHash("sha256")
    .update(eventType)
    .update("\0")
    .update(String(streamSequence))
    .update("\0")
    .update(data)
    .digest("hex");
  return `dlq-invalid-${digest}`;
}

function safeNow(now: () => Date): string {
  try {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      return new Date(0).toISOString();
    }
    return value.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}
