export const DEFAULT_HTTP_OUTBOX_BATCH_SIZE = 25;
export const MAX_HTTP_OUTBOX_BATCH_SIZE = 100;
export const DEFAULT_HTTP_OUTBOX_INTERVAL_MS = 1_000;
export const DEFAULT_HTTP_OUTBOX_TIMEOUT_MS = 5_000;

export type DurableEventTransport = "http" | "jetstream";

/** HTTP event endpoints are fallback transports, not a parallel ingress path. */
export function isHttpDurableEventIngressEnabled(transport: DurableEventTransport): boolean {
  return transport === "http";
}

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[];

export interface ClaimedOutboxEvent<TPayload = JsonValue> {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly tenantId: string | null;
  readonly payload: TPayload;
  readonly destination: string;
}

export interface OutboxEventEnvelope<TPayload = JsonValue> {
  readonly id: string;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly tenantId: string | null;
  readonly payload: TPayload;
}

export type HttpOutboxFailureCode =
  | "claim_overflow"
  | "completion_error"
  | "dispatcher_error"
  | "http_error"
  | "invalid_destination"
  | "invalid_event"
  | "network_error"
  | "serialization_error"
  | "timeout"
  | `http_${number}`;

export type HttpOutboxFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HttpOutboxDispatcherOptions<TPayload = JsonValue> {
  readonly claim: (limit: number) => Promise<readonly ClaimedOutboxEvent<TPayload>[]>;
  readonly complete: (eventId: string) => Promise<void>;
  readonly fail: (eventId: string, errorCode: HttpOutboxFailureCode) => Promise<void>;
  readonly internalToken: string;
  readonly workerId: string;
  readonly fetch?: HttpOutboxFetch;
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

export interface HttpOutboxDrainResult {
  readonly workerId: string;
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly callbackErrors: number;
  readonly claimFailed: boolean;
}

type DispatchResult = {
  readonly completed: boolean;
  readonly callbackError: boolean;
};

type RequestOutcome = { readonly kind: "response"; readonly response: Response } | { readonly kind: "network_error" };

type TimeoutOutcome = { readonly kind: "timeout" };

const HEADER_VALUE_MAX_LENGTH = 512;

/**
 * Delivers already-claimed outbox events over HTTP without depending on a database client.
 * Persistence, retries and claim leases remain the responsibility of the supplied callbacks.
 */
export class HttpOutboxDispatcher<TPayload = JsonValue> {
  readonly workerId: string;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly timeoutMs: number;

  readonly #claim: HttpOutboxDispatcherOptions<TPayload>["claim"];
  readonly #complete: HttpOutboxDispatcherOptions<TPayload>["complete"];
  readonly #fail: HttpOutboxDispatcherOptions<TPayload>["fail"];
  readonly #internalToken: string;
  readonly #fetch: HttpOutboxFetch;

  #activeDrain: Promise<HttpOutboxDrainResult> | undefined;
  #interval: ReturnType<typeof setInterval> | undefined;

  constructor(options: HttpOutboxDispatcherOptions<TPayload>) {
    if (!options || typeof options !== "object") {
      throw new TypeError("HttpOutboxDispatcher options are required");
    }

    if (
      typeof options.claim !== "function" ||
      typeof options.complete !== "function" ||
      typeof options.fail !== "function"
    ) {
      throw new TypeError("claim, complete and fail callbacks are required");
    }

    this.workerId = requireSafeConfigurationValue(options.workerId, "workerId");
    this.#internalToken = requireSafeConfigurationValue(options.internalToken, "internalToken");
    this.batchSize = normalizeBatchSize(options.batchSize);
    this.intervalMs = requirePositiveInteger(options.intervalMs ?? DEFAULT_HTTP_OUTBOX_INTERVAL_MS, "intervalMs");
    this.timeoutMs = requirePositiveInteger(options.timeoutMs ?? DEFAULT_HTTP_OUTBOX_TIMEOUT_MS, "timeoutMs");
    this.#claim = options.claim;
    this.#complete = options.complete;
    this.#fail = options.fail;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  get isRunning(): boolean {
    return this.#interval !== undefined;
  }

  /** Starts one immediate drain and a non-blocking periodic timer. Calling start twice is a no-op. */
  start(): void {
    if (this.#interval !== undefined) {
      return;
    }

    void this.drainOnce();
    this.#interval = setInterval(() => {
      void this.drainOnce();
    }, this.intervalMs);
    this.#interval.unref?.();
  }

  /** Stops future drains and waits for a drain that is already in flight. */
  async stop(): Promise<void> {
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }

    await this.#activeDrain;
  }

  /**
   * Runs at most one drain at a time. Concurrent callers share the same promise and cannot
   * claim or deliver the same batch twice through this dispatcher instance.
   */
  drainOnce(): Promise<HttpOutboxDrainResult> {
    if (this.#activeDrain !== undefined) {
      return this.#activeDrain;
    }

    const drain = this.#runDrain();
    this.#activeDrain = drain;
    void drain.then(() => {
      if (this.#activeDrain === drain) {
        this.#activeDrain = undefined;
      }
    });
    return drain;
  }

  async #runDrain(): Promise<HttpOutboxDrainResult> {
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
    const invalidEventCode = validateEvent(event);
    if (invalidEventCode !== undefined) {
      return this.#failedDispatch(event.id, invalidEventCode);
    }

    if (!isHttpDestination(event.destination)) {
      return this.#failedDispatch(event.id, "invalid_destination");
    }

    if (!isJsonValue(event.payload)) {
      return this.#failedDispatch(event.id, "serialization_error");
    }

    let body: string;
    try {
      const envelope: OutboxEventEnvelope<TPayload> = {
        id: event.id,
        type: event.type,
        version: event.version,
        occurredAt: event.occurredAt,
        tenantId: event.tenantId,
        payload: event.payload
      };
      body = JSON.stringify(envelope);
    } catch {
      return this.#failedDispatch(event.id, "serialization_error");
    }

    const outcome = await this.#request(event, body);
    if (outcome.kind === "timeout") {
      return this.#failedDispatch(event.id, "timeout");
    }
    if (outcome.kind === "network_error") {
      return this.#failedDispatch(event.id, "network_error");
    }

    if (!Number.isInteger(outcome.response.status) || outcome.response.status < 200 || outcome.response.status >= 300) {
      return this.#failedDispatch(event.id, sanitizeHttpStatus(outcome.response.status));
    }

    try {
      await this.#complete(event.id);
      return { completed: true, callbackError: false };
    } catch {
      const callbackSucceeded = await this.#markFailed(event.id, "completion_error");
      return { completed: false, callbackError: !callbackSucceeded };
    }
  }

  async #request(event: ClaimedOutboxEvent<TPayload>, body: string): Promise<RequestOutcome | TimeoutOutcome> {
    const controller = new AbortController();
    const request: Promise<RequestOutcome> = Promise.resolve()
      .then(() =>
        this.#fetch(event.destination, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#internalToken}`,
            "content-type": "application/json",
            "x-hyperion-event-id": event.id,
            "x-hyperion-event-type": event.type,
            "x-hyperion-event-version": String(event.version),
            "x-hyperion-worker-id": this.workerId
          },
          body,
          signal: controller.signal
        })
      )
      .then(
        (response) => ({ kind: "response", response }),
        () => ({ kind: "network_error" })
      );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TimeoutOutcome>((resolve) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, this.timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async #failedDispatch(eventId: string, errorCode: HttpOutboxFailureCode): Promise<DispatchResult> {
    const callbackSucceeded = await this.#markFailed(eventId, errorCode);
    return { completed: false, callbackError: !callbackSucceeded };
  }

  async #markFailed(eventId: string, errorCode: HttpOutboxFailureCode): Promise<boolean> {
    try {
      await this.#fail(eventId, errorCode);
      return true;
    } catch {
      return false;
    }
  }
}

function mutableDrainResult(workerId: string): {
  workerId: string;
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  callbackErrors: number;
  claimFailed: boolean;
} {
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
  const batchSize = requirePositiveInteger(value ?? DEFAULT_HTTP_OUTBOX_BATCH_SIZE, "batchSize");
  return Math.min(batchSize, MAX_HTTP_OUTBOX_BATCH_SIZE);
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
  return value;
}

function requireSafeConfigurationValue(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || !isSafeHeaderValue(value.trim())) {
    throw new TypeError(`${field} must be a non-empty HTTP header-safe string`);
  }
  return value.trim();
}

function validateEvent<TPayload>(event: ClaimedOutboxEvent<TPayload>): HttpOutboxFailureCode | undefined {
  if (!event || typeof event !== "object") {
    return "invalid_event";
  }
  if (!isSafeHeaderValue(event.id) || !isSafeHeaderValue(event.type)) {
    return "invalid_event";
  }
  if (!Number.isSafeInteger(event.version) || event.version <= 0) {
    return "invalid_event";
  }
  if (
    typeof event.occurredAt !== "string" ||
    event.occurredAt.length === 0 ||
    !Number.isFinite(Date.parse(event.occurredAt))
  ) {
    return "invalid_event";
  }
  if (event.tenantId !== null && (typeof event.tenantId !== "string" || event.tenantId.length === 0)) {
    return "invalid_event";
  }
  return undefined;
}

function isSafeHeaderValue(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > HEADER_VALUE_MAX_LENGTH) {
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

function isHttpDestination(destination: unknown): destination is string {
  if (typeof destination !== "string" || destination.length === 0) {
    return false;
  }

  try {
    const url = new URL(destination);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

function sanitizeHttpStatus(status: number): HttpOutboxFailureCode {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? `http_${status}` : "http_error";
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
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
    for (const descriptor of Object.values(properties)) {
      if (!descriptor.enumerable || !("value" in descriptor) || !isJsonValue(descriptor.value, ancestors)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

export * from "./jetstream.js";
export * from "./jetstream-consumer.js";
export * from "./jetstream-bootstrap.js";
export * from "./nats-auth.js";
