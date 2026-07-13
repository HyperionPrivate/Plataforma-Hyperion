import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import type { ClaimedOutboxEvent, JsonValue, OutboxEventEnvelope } from "./index.js";
import { natsInboxPrefix, readNatsAuthentication, type NatsAuthentication } from "./nats-auth.js";

export const DEFAULT_JETSTREAM_OUTBOX_BATCH_SIZE = 25;
export const MAX_JETSTREAM_OUTBOX_BATCH_SIZE = 100;
export const DEFAULT_JETSTREAM_OUTBOX_INTERVAL_MS = 1_000;
export const DEFAULT_JETSTREAM_CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_JETSTREAM_PUBLISH_TIMEOUT_MS = 5_000;
export const DEFAULT_JETSTREAM_SUBJECT_PREFIX = "hyperion.events";

export type JetStreamOutboxFailureCode =
  | "ack_error"
  | "completion_error"
  | "connection_error"
  | "dispatcher_error"
  | "invalid_event"
  | "invalid_subject"
  | "publish_error"
  | "serialization_error";

export interface JetStreamPublishAck {
  readonly stream: string;
  readonly seq: number;
  readonly duplicate: boolean;
}

export interface JetStreamPublishOptions {
  readonly msgID: string;
  readonly timeout: number;
  readonly expect?: Readonly<{ streamName: string }>;
}

/** Small injectable boundary so dispatcher tests never need a NATS server. */
export interface JetStreamPublisherSession {
  publish(subject: string, payload: Uint8Array, options: JetStreamPublishOptions): Promise<JetStreamPublishAck>;
  /** Passive connection check. Real adapters use a protocol flush and never publish a probe event. */
  check?(): Promise<void>;
  close(): Promise<void>;
}

export type JetStreamSessionFactory = () => Promise<JetStreamPublisherSession>;

export interface JetStreamOutboxDispatcherOptions<TPayload = JsonValue> {
  readonly claim: (limit: number) => Promise<readonly ClaimedOutboxEvent<TPayload>[]>;
  readonly complete: (eventId: string) => Promise<void>;
  readonly fail: (eventId: string, errorCode: JetStreamOutboxFailureCode) => Promise<void>;
  readonly workerId: string;
  readonly servers?: string | readonly string[];
  readonly authToken?: string;
  readonly username?: string;
  readonly password?: string;
  readonly connectionName?: string;
  readonly subjectPrefix?: string;
  readonly expectedStream?: string;
  readonly sessionFactory?: JetStreamSessionFactory;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly connectTimeoutMs?: number;
  readonly publishTimeoutMs?: number;
}

export interface JetStreamOutboxDrainResult {
  readonly workerId: string;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly callbackErrors: number;
  readonly claimFailed: boolean;
}

type MutableDrainResult = {
  workerId: string;
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  callbackErrors: number;
  claimFailed: boolean;
};

type DispatchResult = {
  readonly completed: boolean;
  readonly callbackError: boolean;
};

const CONFIGURATION_VALUE_MAX_LENGTH = 512;
const SERVER_VALUE_MAX_LENGTH = 2_048;
const SUBJECT_MAX_LENGTH = 512;
const SUBJECT_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const STREAM_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Publishes already-claimed outbox events to JetStream. Persistence, leases and
 * retry scheduling remain owned by the supplied callbacks.
 */
export class JetStreamOutboxDispatcher<TPayload = JsonValue> {
  readonly workerId: string;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly connectTimeoutMs: number;
  readonly publishTimeoutMs: number;
  readonly subjectPrefix: string;
  readonly expectedStream: string | undefined;

  readonly #claim: JetStreamOutboxDispatcherOptions<TPayload>["claim"];
  readonly #complete: JetStreamOutboxDispatcherOptions<TPayload>["complete"];
  readonly #fail: JetStreamOutboxDispatcherOptions<TPayload>["fail"];
  readonly #sessionFactory: JetStreamSessionFactory;

  #activeDrain: Promise<JetStreamOutboxDrainResult> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;
  #session: JetStreamPublisherSession | undefined;
  #sessionPromise: Promise<JetStreamPublisherSession> | undefined;
  readonly #sessionClosePromises = new WeakMap<JetStreamPublisherSession, Promise<void>>();
  #stopPromise: Promise<void> | undefined;
  #stopping = false;

  constructor(options: JetStreamOutboxDispatcherOptions<TPayload>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("JetStreamOutboxDispatcher options are required");
    }
    if (
      typeof options.claim !== "function" ||
      typeof options.complete !== "function" ||
      typeof options.fail !== "function"
    ) {
      throw new TypeError("claim, complete and fail callbacks are required");
    }

    this.workerId = requireSafeConfigurationValue(options.workerId, "workerId");
    this.batchSize = normalizeBatchSize(options.batchSize);
    this.intervalMs = requirePositiveInteger(options.intervalMs ?? DEFAULT_JETSTREAM_OUTBOX_INTERVAL_MS, "intervalMs");
    this.connectTimeoutMs = requirePositiveInteger(
      options.connectTimeoutMs ?? DEFAULT_JETSTREAM_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs"
    );
    this.publishTimeoutMs = requirePositiveInteger(
      options.publishTimeoutMs ?? DEFAULT_JETSTREAM_PUBLISH_TIMEOUT_MS,
      "publishTimeoutMs"
    );
    this.subjectPrefix = requireSubject(options.subjectPrefix ?? DEFAULT_JETSTREAM_SUBJECT_PREFIX, "subjectPrefix");
    this.expectedStream = requireOptionalStreamName(options.expectedStream);
    const authentication = readNatsAuthentication({
      authToken: options.authToken,
      username: options.username,
      password: options.password
    });
    this.#claim = options.claim;
    this.#complete = options.complete;
    this.#fail = options.fail;

    if (options.sessionFactory !== undefined) {
      if (typeof options.sessionFactory !== "function") {
        throw new TypeError("sessionFactory must be a function");
      }
      this.#sessionFactory = options.sessionFactory;
    } else {
      const servers = normalizeServers(options.servers);
      const connectionName = requireSafeConfigurationValue(options.connectionName ?? this.workerId, "connectionName");
      this.#sessionFactory = createNatsSessionFactory({
        servers,
        authentication,
        connectionName,
        expectedStream: this.expectedStream,
        connectTimeoutMs: this.connectTimeoutMs,
        publishTimeoutMs: this.publishTimeoutMs
      });
    }
  }

  get isRunning(): boolean {
    return this.#interval !== undefined;
  }

  /** Opens and authenticates the publisher session before the service advertises readiness. */
  async initialize(): Promise<void> {
    await this.#getSession();
  }

  /** Verifies the existing session without claiming or publishing an outbox event. */
  async checkReadiness(): Promise<void> {
    let session: JetStreamPublisherSession | undefined;
    try {
      session = await this.#getSession();
      await withinReadinessTimeout(Promise.resolve(session.check?.()), this.connectTimeoutMs);
    } catch {
      if (session !== undefined) {
        await this.#invalidateSession(session);
      }
      throw new Error("jetstream_publisher_not_ready");
    }
  }

  /** Starts one immediate drain and an unreferenced periodic timer. */
  start(): void {
    if (this.#interval !== undefined || this.#stopping) {
      return;
    }

    void this.drainOnce();
    this.#interval = setInterval(() => {
      void this.drainOnce();
    }, this.intervalMs);
    this.#interval.unref?.();
  }

  /** Stops future drains, waits for in-flight work, then drains and closes NATS. */
  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }

    const stop = this.#runStop();
    this.#stopPromise = stop;
    void stop.then(
      () => {
        if (this.#stopPromise === stop) {
          this.#stopPromise = undefined;
        }
      },
      () => {
        if (this.#stopPromise === stop) {
          this.#stopPromise = undefined;
        }
      }
    );
    return stop;
  }

  /** Concurrent callers share one drain and cannot claim the same batch twice. */
  drainOnce(): Promise<JetStreamOutboxDrainResult> {
    if (this.#stopping) {
      return Promise.resolve(mutableDrainResult(this.workerId));
    }
    if (this.#activeDrain !== undefined) {
      return this.#activeDrain;
    }

    const drain = this.#runDrain();
    this.#activeDrain = drain;
    void drain.then(
      () => this.#releaseDrain(drain),
      () => this.#releaseDrain(drain)
    );
    return drain;
  }

  async #runStop(): Promise<void> {
    this.#stopping = true;
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }

    try {
      await this.#activeDrain;
      const session = this.#session;
      this.#session = undefined;
      this.#sessionPromise = undefined;
      if (session !== undefined) {
        try {
          await this.#closeSessionOnce(session);
        } catch {
          throw new Error("jetstream_close_error");
        }
      }
    } finally {
      this.#stopping = false;
    }
  }

  #releaseDrain(drain: Promise<JetStreamOutboxDrainResult>): void {
    if (this.#activeDrain === drain) {
      this.#activeDrain = undefined;
    }
  }

  async #runDrain(): Promise<JetStreamOutboxDrainResult> {
    const result = mutableDrainResult(this.workerId);
    let events: readonly ClaimedOutboxEvent<TPayload>[];

    try {
      events = await this.#claim(this.batchSize);
      if (!Array.isArray(events)) {
        result.claimFailed = true;
        return result;
      }
    } catch {
      result.claimFailed = true;
      return result;
    }

    let boundedEvents: readonly ClaimedOutboxEvent<TPayload>[];
    try {
      boundedEvents = events.slice(0, this.batchSize);
      result.claimed = boundedEvents.length;
      result.skipped = Math.max(0, events.length - boundedEvents.length);
    } catch {
      result.claimFailed = true;
      return result;
    }

    const seenIds = new Set<string>();
    for (const event of boundedEvents) {
      let eventId = "";
      try {
        eventId = typeof event?.id === "string" ? event.id : "";
        if (eventId && seenIds.has(eventId)) {
          result.skipped += 1;
          continue;
        }
        if (eventId) {
          seenIds.add(eventId);
        }

        const dispatch = await this.#dispatch(event);
        if (dispatch.completed) {
          result.completed += 1;
        } else {
          result.failed += 1;
        }
        if (dispatch.callbackError) {
          result.callbackErrors += 1;
        }
      } catch {
        result.failed += 1;
        if (eventId) {
          const callbackSucceeded = await this.#markFailed(eventId, "dispatcher_error");
          if (!callbackSucceeded) {
            result.callbackErrors += 1;
          }
        }
      }
    }

    return result;
  }

  async #dispatch(event: ClaimedOutboxEvent<TPayload>): Promise<DispatchResult> {
    if (!isValidEvent(event)) {
      return this.#failedDispatch(event?.id ?? "", "invalid_event");
    }

    const subject = `${this.subjectPrefix}.${event.type}`;
    if (!isValidSubject(subject)) {
      return this.#failedDispatch(event.id, "invalid_subject");
    }
    if (!isJsonValue(event.payload)) {
      return this.#failedDispatch(event.id, "serialization_error");
    }

    let payload: Uint8Array;
    try {
      const envelope: OutboxEventEnvelope<TPayload> = {
        id: event.id,
        type: event.type,
        version: event.version,
        occurredAt: event.occurredAt,
        tenantId: event.tenantId,
        payload: event.payload
      };
      payload = new TextEncoder().encode(stableStringify(envelope));
    } catch {
      return this.#failedDispatch(event.id, "serialization_error");
    }

    let session: JetStreamPublisherSession;
    try {
      session = await this.#getSession();
    } catch {
      return this.#failedDispatch(event.id, "connection_error");
    }

    let ack: JetStreamPublishAck;
    try {
      ack = await session.publish(subject, payload, {
        msgID: event.id,
        timeout: this.publishTimeoutMs,
        ...(this.expectedStream === undefined ? {} : { expect: { streamName: this.expectedStream } })
      });
    } catch {
      await this.#invalidateSession(session);
      return this.#failedDispatch(event.id, "publish_error");
    }

    if (!isValidAck(ack, this.expectedStream)) {
      await this.#invalidateSession(session);
      return this.#failedDispatch(event.id, "ack_error");
    }

    try {
      await this.#complete(event.id);
      return { completed: true, callbackError: false };
    } catch {
      const callbackSucceeded = await this.#markFailed(event.id, "completion_error");
      return { completed: false, callbackError: !callbackSucceeded };
    }
  }

  async #getSession(): Promise<JetStreamPublisherSession> {
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
      if (
        !session ||
        typeof session !== "object" ||
        typeof session.publish !== "function" ||
        typeof session.close !== "function"
      ) {
        throw new TypeError("invalid_jetstream_session");
      }
      this.#session = session;
      return session;
    } catch {
      throw new Error("jetstream_connection_error");
    } finally {
      if (this.#sessionPromise === pending) {
        this.#sessionPromise = undefined;
      }
    }
  }

  async #invalidateSession(session: JetStreamPublisherSession): Promise<void> {
    // Identity comparison prevents a late failure from clearing a replacement session.
    if (this.#session === session) {
      this.#session = undefined;
    }
    try {
      await this.#closeSessionOnce(session);
    } catch {
      // Publish failures expose only their stable failure code; close is best-effort here.
    }
  }

  #closeSessionOnce(session: JetStreamPublisherSession): Promise<void> {
    const existing = this.#sessionClosePromises.get(session);
    if (existing !== undefined) {
      return existing;
    }
    const closing = Promise.resolve().then(() => session.close());
    this.#sessionClosePromises.set(session, closing);
    return closing;
  }

  async #failedDispatch(eventId: string, errorCode: JetStreamOutboxFailureCode): Promise<DispatchResult> {
    const callbackSucceeded = await this.#markFailed(eventId, errorCode);
    return { completed: false, callbackError: !callbackSucceeded };
  }

  async #markFailed(eventId: string, errorCode: JetStreamOutboxFailureCode): Promise<boolean> {
    try {
      await this.#fail(eventId, errorCode);
      return true;
    } catch {
      return false;
    }
  }
}

function createNatsSessionFactory(options: {
  readonly servers: string | string[];
  readonly authentication: NatsAuthentication | undefined;
  readonly connectionName: string;
  readonly expectedStream: string | undefined;
  readonly connectTimeoutMs: number;
  readonly publishTimeoutMs: number;
}): JetStreamSessionFactory {
  return async () => {
    let connection: NatsConnection | undefined;
    try {
      connection = await connect({
        servers: options.servers,
        ...toNatsConnectionAuthentication(options.authentication),
        inboxPrefix: natsInboxPrefix(options.authentication),
        name: options.connectionName,
        timeout: options.connectTimeoutMs
      });
      await connection.flush();
      const manager = await jetstreamManager(connection, { timeout: options.connectTimeoutMs });
      await manager.getAccountInfo();
      if (options.expectedStream !== undefined) {
        await manager.streams.info(options.expectedStream);
      }
      const client = jetstream(connection, { timeout: options.publishTimeoutMs });
      const ownedConnection = connection;
      return {
        publish: (subject, payload, publishOptions) => client.publish(subject, payload, publishOptions),
        check: async () => {
          if (ownedConnection.isClosed()) {
            throw new Error("jetstream_connection_closed");
          }
          await ownedConnection.flush();
          await manager.getAccountInfo();
          if (options.expectedStream !== undefined) {
            await manager.streams.info(options.expectedStream);
          }
        },
        close: async () => {
          if (connection?.isClosed()) {
            return;
          }
          try {
            await connection?.drain();
          } catch {
            if (connection !== undefined && !connection.isClosed()) {
              await connection.close();
            }
          }
        }
      };
    } catch {
      if (connection !== undefined && !connection.isClosed()) {
        try {
          await connection.close();
        } catch {
          // Preserve only the stable connection failure classification.
        }
      }
      throw new Error("jetstream_connection_error");
    }
  };
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

function toNatsConnectionAuthentication(
  authentication: NatsAuthentication | undefined
): Record<string, never> | Readonly<{ token: string }> | Readonly<{ user: string; pass: string }> {
  if (authentication === undefined) return {};
  if (authentication.authToken !== undefined) return { token: authentication.authToken };
  return { user: authentication.username, pass: authentication.password };
}

function mutableDrainResult(workerId: string): MutableDrainResult {
  return {
    workerId,
    claimed: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    callbackErrors: 0,
    claimFailed: false
  };
}

function normalizeBatchSize(value: number | undefined): number {
  return Math.min(
    requirePositiveInteger(value ?? DEFAULT_JETSTREAM_OUTBOX_BATCH_SIZE, "batchSize"),
    MAX_JETSTREAM_OUTBOX_BATCH_SIZE
  );
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function requireSafeConfigurationValue(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a non-empty safe string`);
  }
  const normalized = value.trim();
  if (!isSafeText(normalized, CONFIGURATION_VALUE_MAX_LENGTH)) {
    throw new TypeError(`${field} must be a non-empty safe string`);
  }
  return normalized;
}

function requireSubject(value: string, field: string): string {
  const subject = requireSafeConfigurationValue(value, field);
  if (!isValidSubject(subject)) {
    throw new TypeError(`${field} must contain only safe NATS subject tokens`);
  }
  return subject;
}

function requireOptionalStreamName(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const stream = requireSafeConfigurationValue(value, "expectedStream");
  if (!STREAM_NAME_PATTERN.test(stream)) {
    throw new TypeError("expectedStream must be a safe NATS stream name");
  }
  return stream;
}

function normalizeServers(value: string | readonly string[] | undefined): string | string[] {
  const servers = value ?? "nats://127.0.0.1:4222";
  if (typeof servers === "string") {
    return requireSafeServer(servers);
  }
  if (!Array.isArray(servers) || servers.length === 0) {
    throw new TypeError("servers must contain at least one safe NATS server");
  }
  return servers.map((server) => requireSafeServer(server));
}

function requireSafeServer(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("servers must contain only safe NATS server strings");
  }
  const server = value.trim();
  if (!isSafeText(server, SERVER_VALUE_MAX_LENGTH)) {
    throw new TypeError("servers must contain only safe NATS server strings");
  }
  try {
    const url = new URL(server);
    if (
      (url.protocol !== "nats:" && url.protocol !== "tls:") ||
      url.username ||
      url.password ||
      !url.hostname ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      throw new TypeError("invalid_server");
    }
  } catch {
    throw new TypeError("servers must contain only safe credential-free NATS URLs");
  }
  return server;
}

function isValidEvent<TPayload>(event: ClaimedOutboxEvent<TPayload>): boolean {
  return Boolean(
    event &&
    typeof event === "object" &&
    isSafeText(event.id, CONFIGURATION_VALUE_MAX_LENGTH) &&
    isSafeText(event.type, CONFIGURATION_VALUE_MAX_LENGTH) &&
    Number.isSafeInteger(event.version) &&
    event.version > 0 &&
    typeof event.occurredAt === "string" &&
    event.occurredAt.length > 0 &&
    Number.isFinite(Date.parse(event.occurredAt)) &&
    (event.tenantId === null || (typeof event.tenantId === "string" && event.tenantId.length > 0))
  );
}

function isValidSubject(value: string): boolean {
  return (
    value.length <= SUBJECT_MAX_LENGTH &&
    value.split(".").every((token) => token.length > 0 && SUBJECT_TOKEN_PATTERN.test(token))
  );
}

function isValidAck(value: unknown, expectedStream: string | undefined): value is JetStreamPublishAck {
  if (!value || typeof value !== "object") {
    return false;
  }
  const ack = value as Partial<JetStreamPublishAck>;
  return Boolean(
    typeof ack.stream === "string" &&
    STREAM_NAME_PATTERN.test(ack.stream) &&
    Number.isSafeInteger(ack.seq) &&
    (ack.seq ?? 0) > 0 &&
    typeof ack.duplicate === "boolean" &&
    (expectedStream === undefined || ack.stream === expectedStream)
  );
}

function isSafeText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
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
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !isJsonValue(value[index], ancestors)) {
          return false;
        }
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return false;
    }
    const properties = Object.getOwnPropertyDescriptors(value);
    return Object.values(properties).every(
      (descriptor) => descriptor.enumerable && "value" in descriptor && isJsonValue(descriptor.value, ancestors)
    );
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") {
      throw new TypeError("non_json_value");
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const descriptors = Object.getOwnPropertyDescriptors(value);
  return `{${Object.keys(descriptors)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(descriptors[key]!.value)}`)
    .join(",")}}`;
}
