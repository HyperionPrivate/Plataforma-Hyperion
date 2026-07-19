import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpOutboxDispatcher,
  MAX_HTTP_OUTBOX_BATCH_SIZE,
  isHttpDurableEventIngressEnabled,
  type ClaimedOutboxEvent,
  type HttpOutboxDispatcherOptions,
  type HttpOutboxFailureCode,
  type JsonValue
} from "./index.js";

const EVENT: ClaimedOutboxEvent = {
  id: "10dc657b-2dd8-4354-b10f-0cdf5741d7bc",
  type: "channel.message.received",
  version: 1,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
  streamId: "0790ebc5-9058-4dcb-8be0-5e3e85858738",
  streamSequence: 7,
  payload: { conversationId: "controlled-conversation", body: "controlled-message" },
  destination: "http://pulso-iris-service:3000/internal/events"
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("durable event ingress selection", () => {
  it("exposes HTTP event ingress only while HTTP is the selected transport", () => {
    expect(isHttpDurableEventIngressEnabled("http")).toBe(true);
    expect(isHttpDurableEventIngressEnabled("jetstream")).toBe(false);
  });
});

describe("HttpOutboxDispatcher", () => {
  it("posts the stable envelope and completes every 2xx response", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(null, { status: 204 });
    });
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({ fetch, complete, fail });

    const result = await dispatcher.drainOnce();

    expect(result).toEqual({
      workerId: "channel-worker-1",
      claimed: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      callbackErrors: 0,
      claimFailed: false
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [destination, init] = fetch.mock.calls[0]!;
    expect(destination).toBe(EVENT.destination);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(init?.headers).toEqual({
      authorization: "Bearer controlled-internal-token",
      "content-type": "application/json",
      "x-hyperion-event-id": EVENT.id,
      "x-hyperion-event-type": EVENT.type,
      "x-hyperion-event-version": "1",
      "x-hyperion-worker-id": "channel-worker-1"
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      id: EVENT.id,
      type: EVENT.type,
      version: EVENT.version,
      occurredAt: EVENT.occurredAt,
      tenantId: EVENT.tenantId,
      streamId: EVENT.streamId,
      streamSequence: EVENT.streamSequence,
      payload: EVENT.payload
    });
    expect(complete).toHaveBeenCalledWith(EVENT.id);
    expect(fail).not.toHaveBeenCalled();
  });

  it.each([200, 299])("treats HTTP %i as successful delivery", async (status) => {
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      fetch: async () => new Response(null, { status }),
      complete,
      fail
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(complete).toHaveBeenCalledWith(EVENT.id);
    expect(fail).not.toHaveBeenCalled();
  });

  it("treats HTTP 300 as a failed delivery boundary", async () => {
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      fetch: async () => new Response(null, { status: 300 }),
      fail
    });

    await dispatcher.drainOnce();

    expect(fail).toHaveBeenCalledWith(EVENT.id, "http_300");
  });

  it("marks non-2xx responses with only a sanitized status code", async () => {
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => {
      const response = new Response("sensitive upstream detail", { status: 503 });
      vi.spyOn(response, "text").mockRejectedValue(new Error("must not read body"));
      return response;
    });
    const dispatcher = createDispatcher({ fetch, complete, fail });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 0, failed: 1 });

    expect(fail).toHaveBeenCalledWith(EVENT.id, "http_503");
    expect(complete).not.toHaveBeenCalled();
  });

  it("sanitizes invalid injected HTTP status values", async () => {
    const fail = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => ({ status: Number.NaN }) as Response);
    const dispatcher = createDispatcher({ fetch, fail });

    await dispatcher.drainOnce();

    expect(fail).toHaveBeenCalledWith(EVENT.id, "http_error");
  });

  it("converts network failures to network_error without rejecting", async () => {
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      fetch: vi.fn(async () => Promise.reject(new Error("private network detail"))),
      fail
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ failed: 1, callbackErrors: 0 });

    expect(fail).toHaveBeenCalledWith(EVENT.id, "network_error");
  });

  it("aborts and marks a request that exceeds its timeout", async () => {
    vi.useFakeTimers();
    const fail = vi.fn(async () => undefined);
    let observedSignal: AbortSignal | undefined;
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>(() => {
          observedSignal = init?.signal ?? undefined;
        })
    );
    const dispatcher = createDispatcher({ fetch, fail, timeoutMs: 50 });

    const drain = dispatcher.drainOnce();
    await vi.advanceTimersByTimeAsync(50);

    await expect(drain).resolves.toMatchObject({ failed: 1 });
    expect(observedSignal?.aborted).toBe(true);
    expect(fail).toHaveBeenCalledWith(EVENT.id, "timeout");
  });

  it("rejects non-HTTP destinations without calling fetch", async () => {
    const fail = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatcher = createDispatcher({
      claim: async () => [{ ...EVENT, destination: "file:///private/event" }],
      fetch,
      fail
    });

    await dispatcher.drainOnce();

    expect(fetch).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(EVENT.id, "invalid_destination");
  });

  it("rejects destinations containing embedded credentials", async () => {
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      claim: async () => [{ ...EVENT, destination: "https://user:password@example.test/events" }],
      fail
    });

    await dispatcher.drainOnce();

    expect(fail).toHaveBeenCalledWith(EVENT.id, "invalid_destination");
  });

  it("rejects malformed event headers before making a request", async () => {
    const fail = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatcher = createDispatcher({
      claim: async () => [{ ...EVENT, type: "channel.received\r\ninjected: value" }],
      fetch,
      fail
    });

    await dispatcher.drainOnce();

    expect(fetch).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(EVENT.id, "invalid_event");
  });

  it.each([
    { streamId: EVENT.streamId, streamSequence: undefined },
    { streamId: undefined, streamSequence: EVENT.streamSequence },
    { streamId: EVENT.streamId, streamSequence: 0 },
    { streamId: "stream\r\ninjected", streamSequence: 1 }
  ])("rejects an incomplete or invalid ordered stream position %o", async (position) => {
    const fail = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatcher = createDispatcher({ claim: async () => [{ ...EVENT, ...position }], fetch, fail });

    await dispatcher.drainOnce();

    expect(fetch).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(EVENT.id, "invalid_event");
  });

  it("rejects cyclic and non-JSON payloads without exposing their content", async () => {
    const payload: Record<string, unknown> = { secret: "must-not-be-logged" };
    payload.self = payload;
    const fail = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dispatcher = createDispatcher({
      claim: async () => [{ ...EVENT, payload }],
      fetch,
      fail
    });

    await dispatcher.drainOnce();

    expect(fetch).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(EVENT.id, "serialization_error");
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("releases the event through fail when complete itself fails", async () => {
    const complete = vi.fn(async () => Promise.reject(new Error("database detail")));
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({ complete, fail });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 0, failed: 1, callbackErrors: 0 });

    expect(fail).toHaveBeenCalledWith(EVENT.id, "completion_error");
  });

  it("swallows fail callback errors and reports only their count", async () => {
    const fail = vi.fn(async () => Promise.reject(new Error("database detail")));
    const dispatcher = createDispatcher({
      fetch: vi.fn(async () => new Response(null, { status: 500 })),
      fail
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ failed: 1, callbackErrors: 1 });
  });

  it("swallows claim errors without invoking event callbacks", async () => {
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      claim: async () => Promise.reject(new Error("database detail")),
      complete,
      fail
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 0, claimFailed: true });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it("shares one in-flight drain among concurrent callers", async () => {
    let releaseRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      releaseRequest = resolve;
    });
    const claim = vi.fn(async () => [EVENT]);
    const fetch = vi.fn(async () => request);
    const dispatcher = createDispatcher({ claim, fetch });

    const first = dispatcher.drainOnce();
    const second = dispatcher.drainOnce();

    expect(second).toBe(first);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    releaseRequest(new Response(null, { status: 200 }));
    await Promise.all([first, second]);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated ids inside a claimed batch", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const complete = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({ claim: async () => [EVENT, EVENT], fetch, complete, batchSize: 2 });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 2, completed: 1, skipped: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("never requests or processes more than the configured bounded batch", async () => {
    const events = [EVENT, { ...EVENT, id: "event-2" }, { ...EVENT, id: "event-3" }];
    const claim = vi.fn(async () => events);
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const dispatcher = createDispatcher({ claim, fetch, batchSize: 2 });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 2, completed: 2, skipped: 1 });
    expect(claim).toHaveBeenCalledWith(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("caps an oversized configured batch at the package maximum", () => {
    const claim = vi.fn(async () => []);
    const dispatcher = createDispatcher({ claim, batchSize: MAX_HTTP_OUTBOX_BATCH_SIZE + 5_000 });

    expect(dispatcher.batchSize).toBe(MAX_HTTP_OUTBOX_BATCH_SIZE);
  });

  it("starts immediately, keeps a single unreferenced interval and stops idempotently", async () => {
    const claim = vi.fn(async () => []);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const dispatcher = createDispatcher({ claim, intervalMs: 60_000 });

    dispatcher.start();
    dispatcher.start();
    expect(dispatcher.isRunning).toBe(true);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const timer = setIntervalSpy.mock.results[0]?.value as ReturnType<typeof setInterval>;
    expect(timer.hasRef?.()).toBe(false);
    await dispatcher.stop();
    await dispatcher.stop();

    expect(dispatcher.isRunning).toBe(false);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("does not overlap periodic drains while a request is in flight", async () => {
    vi.useFakeTimers();
    let releaseRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => {
      releaseRequest = resolve;
    });
    const claim = vi.fn(async () => [EVENT]);
    const dispatcher = createDispatcher({ claim, fetch: async () => request, intervalMs: 25, timeoutMs: 1_000 });

    dispatcher.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(claim).toHaveBeenCalledTimes(1);
    releaseRequest(new Response(null, { status: 200 }));
    await vi.runOnlyPendingTimersAsync();
    await dispatcher.stop();
  });

  it("aborts the active request and leaves the remainder of a claimed batch for lease recovery on stop", async () => {
    const secondEvent = { ...EVENT, id: "event-2" };
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
            once: true
          });
        })
    );
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({ claim: async () => [EVENT, secondEvent], fetch, fail, batchSize: 2 });

    const draining = dispatcher.drainOnce();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const stopping = dispatcher.stop();
    const result = await draining;
    await stopping;

    expect(result).toMatchObject({ claimed: 2, failed: 1, skipped: 1 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledWith(EVENT.id, "network_error");
    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 0 });
  });

  it.each([
    [{ internalToken: "" }, "internalToken"],
    [{ internalToken: "token\r\ninjected" }, "internalToken"],
    [{ workerId: "" }, "workerId"],
    [{ batchSize: 0 }, "batchSize"],
    [{ intervalMs: -1 }, "intervalMs"],
    [{ timeoutMs: 1.5 }, "timeoutMs"]
  ] as const)("rejects invalid configuration %o", (override, field) => {
    expect(() => createDispatcher(override)).toThrow(field);
  });
});

function createDispatcher(override: Partial<HttpOutboxDispatcherOptions<unknown>> = {}): HttpOutboxDispatcher<unknown> {
  const options: HttpOutboxDispatcherOptions<unknown> = {
    claim: async () => [EVENT as ClaimedOutboxEvent<unknown>],
    complete: async () => undefined,
    fail: async (_eventId: string, _errorCode: HttpOutboxFailureCode) => undefined,
    internalToken: "controlled-internal-token",
    workerId: "channel-worker-1",
    fetch: async () => new Response(null, { status: 200 }),
    batchSize: 25,
    intervalMs: 1_000,
    timeoutMs: 500,
    ...override
  };
  return new HttpOutboxDispatcher(options);
}

const _jsonTypeCompileCheck: JsonValue = { nested: [true, 1, "value", null] };
void _jsonTypeCompileCheck;
