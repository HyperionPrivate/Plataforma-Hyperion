import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JetStreamOutboxDispatcher,
  MAX_JETSTREAM_OUTBOX_BATCH_SIZE,
  type ClaimedOutboxEvent,
  type JetStreamOutboxDispatcherOptions,
  type JetStreamOutboxFailureCode,
  type JetStreamPublishAck,
  type JetStreamPublisherSession
} from "./index.js";

const EVENT: ClaimedOutboxEvent = {
  id: "10dc657b-2dd8-4354-b10f-0cdf5741d7bc",
  type: "channel.inbound.received.v2",
  version: 2,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
  streamId: "0790ebc5-9058-4dcb-8be0-5e3e85858738",
  streamSequence: 7,
  payload: { conversationId: "controlled-conversation", body: "controlled-message" },
  destination: "ignored-by-jetstream"
};

const ACK: JetStreamPublishAck = {
  stream: "HYPERION_EVENTS",
  seq: 42,
  duplicate: false
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("JetStreamOutboxDispatcher", () => {
  it("preflights a publisher session without claiming or publishing an event", async () => {
    const check = vi.fn(async () => undefined);
    const publish = vi.fn<JetStreamPublisherSession["publish"]>(async () => ACK);
    const session = createSession({ check, publish });
    const factory = vi.fn(async () => session);
    const claim = vi.fn(async () => [EVENT]);
    const dispatcher = createDispatcher({ sessionFactory: factory, claim });

    await expect(dispatcher.initialize()).resolves.toBeUndefined();
    await expect(dispatcher.checkReadiness()).resolves.toBeUndefined();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    await dispatcher.stop();
  });

  it("marks a failed publisher check down, retires it and reconnects on the next preflight", async () => {
    const sensitiveDetail = "private-broker-address";
    const firstClose = vi.fn(async () => undefined);
    const first = createSession({ check: async () => Promise.reject(new Error(sensitiveDetail)), close: firstClose });
    const second = createSession({ check: async () => undefined });
    const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const dispatcher = createDispatcher({ sessionFactory: factory });

    await dispatcher.initialize();
    await expect(dispatcher.checkReadiness()).rejects.toThrow("jetstream_publisher_not_ready");
    expect(firstClose).toHaveBeenCalledTimes(1);
    await expect(dispatcher.initialize()).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
    await dispatcher.stop();
  });

  it("bounds a stalled passive publisher check", async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      sessionFactory: async () =>
        createSession({
          check: async () => new Promise<void>(() => undefined),
          close
        }),
      connectTimeoutMs: 500
    });
    await dispatcher.initialize();

    const readiness = expect(dispatcher.checkReadiness()).rejects.toThrow("jetstream_publisher_not_ready");
    await vi.advanceTimersByTimeAsync(500);
    await readiness;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("connects lazily, publishes stable JSON and completes only after a valid ack", async () => {
    const order: string[] = [];
    const publish = vi.fn<JetStreamPublisherSession["publish"]>(async (_subject, _payload, _options) => {
      order.push("ack");
      return ACK;
    });
    const close = vi.fn(async () => undefined);
    const sessionFactory = vi.fn(async () => ({ publish, close }));
    const complete = vi.fn(async () => {
      order.push("complete");
    });
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({ sessionFactory, complete, fail });

    expect(sessionFactory).not.toHaveBeenCalled();
    await expect(dispatcher.drainOnce()).resolves.toEqual({
      workerId: "channel-worker-1",
      claimed: 1,
      completed: 1,
      failed: 0,
      skipped: 0,
      callbackErrors: 0,
      claimFailed: false
    });

    expect(sessionFactory).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    const [subject, bytes, options] = publish.mock.calls[0]!;
    expect(subject).toBe("hyperion.events.channel.inbound.received.v2");
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"id":"10dc657b-2dd8-4354-b10f-0cdf5741d7bc","occurredAt":"2026-07-13T15:00:00.000Z","payload":{"body":"controlled-message","conversationId":"controlled-conversation"},"streamId":"0790ebc5-9058-4dcb-8be0-5e3e85858738","streamSequence":7,"tenantId":"7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c","type":"channel.inbound.received.v2","version":2}'
    );
    expect(options).toEqual({
      msgID: EVENT.id,
      timeout: 500,
      expect: { streamName: "HYPERION_EVENTS" }
    });
    expect(order).toEqual(["ack", "complete"]);
    expect(complete).toHaveBeenCalledWith(EVENT.id);
    expect(fail).not.toHaveBeenCalled();
  });

  it("accepts a duplicate PubAck as successful idempotent delivery", async () => {
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      sessionFactory: sessionFactory({ publish: async () => ({ ...ACK, duplicate: true }) }),
      complete,
      fail
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(complete).toHaveBeenCalledWith(EVENT.id);
    expect(fail).not.toHaveBeenCalled();
  });

  it("retires a session after publish throws and reconnects before retrying", async () => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstPublish = vi.fn<JetStreamPublisherSession["publish"]>(async () =>
      Promise.reject(new Error("private broker detail and payload"))
    );
    const secondPublish = vi.fn<JetStreamPublisherSession["publish"]>(async () => ACK);
    const firstSession = createSession({
      publish: firstPublish,
      close: firstClose
    });
    const secondSession = createSession({ publish: secondPublish, close: secondClose });
    const factory = vi.fn().mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession);
    const fail = vi.fn(async () => undefined);
    const complete = vi.fn(async () => undefined);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dispatcher = createDispatcher({ sessionFactory: factory, fail, complete });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 0, failed: 1 });
    expect(fail).toHaveBeenLastCalledWith(EVENT.id, "publish_error");
    expect(firstClose).toHaveBeenCalledTimes(1);
    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 1, failed: 0 });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(firstPublish).toHaveBeenCalledTimes(1);
    expect(secondPublish).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    await dispatcher.stop();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("retries a lazy connection after a sanitized connection failure", async () => {
    const session = createSession();
    const factory = vi.fn().mockRejectedValueOnce(new Error("private server address")).mockResolvedValueOnce(session);
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({ sessionFactory: factory, fail });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ failed: 1 });
    expect(fail).toHaveBeenLastCalledWith(EVENT.id, "connection_error");
    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 1 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("rejects an unsafe event-derived subject before connecting", async () => {
    const factory = vi.fn(async () => createSession());
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      claim: async () => [{ ...EVENT, type: "channel.*.received" }],
      sessionFactory: factory,
      fail
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 0, failed: 1 });
    expect(fail).toHaveBeenCalledWith(EVENT.id, "invalid_subject");
    expect(factory).not.toHaveBeenCalled();
  });

  it("retires a session after an invalid PubAck and reconnects before retrying", async () => {
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const firstPublish = vi.fn<JetStreamPublisherSession["publish"]>(async () => ({
      ...ACK,
      stream: "OTHER_STREAM"
    }));
    const secondPublish = vi.fn<JetStreamPublisherSession["publish"]>(async () => ACK);
    const firstSession = createSession({
      publish: firstPublish,
      close: firstClose
    });
    const secondSession = createSession({ publish: secondPublish, close: secondClose });
    const factory = vi.fn().mockResolvedValueOnce(firstSession).mockResolvedValueOnce(secondSession);
    const complete = vi.fn(async () => undefined);
    const fail = vi.fn(async () => undefined);
    const dispatcher = createDispatcher({
      sessionFactory: factory,
      complete,
      fail
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 0, failed: 1 });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(EVENT.id, "ack_error");
    expect(firstClose).toHaveBeenCalledTimes(1);

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(firstPublish).toHaveBeenCalledTimes(1);
    expect(secondPublish).toHaveBeenCalledTimes(1);
    await dispatcher.stop();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight publish among concurrent drain callers", async () => {
    let releasePublish!: (ack: JetStreamPublishAck) => void;
    const pending = new Promise<JetStreamPublishAck>((resolve) => {
      releasePublish = resolve;
    });
    const publish = vi.fn(async () => pending);
    const claim = vi.fn(async () => [EVENT]);
    const dispatcher = createDispatcher({ claim, sessionFactory: sessionFactory({ publish }) });

    const first = dispatcher.drainOnce();
    const second = dispatcher.drainOnce();

    expect(second).toBe(first);
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    releasePublish(ACK);
    await Promise.all([first, second]);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("bounds each claim and deduplicates repeated ids", async () => {
    const publish = vi.fn(async () => ACK);
    const claim = vi.fn(async () => [EVENT, EVENT, { ...EVENT, id: "event-2" }]);
    const dispatcher = createDispatcher({
      claim,
      sessionFactory: sessionFactory({ publish }),
      batchSize: 2
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 2, completed: 1, skipped: 2 });
    expect(claim).toHaveBeenCalledWith(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("does not connect for an empty batch", async () => {
    const factory = vi.fn(async () => createSession());
    const dispatcher = createDispatcher({ claim: async () => [], sessionFactory: factory });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 0, completed: 0 });
    expect(factory).not.toHaveBeenCalled();
    await dispatcher.stop();
    expect(factory).not.toHaveBeenCalled();
  });

  it("stops its timer, waits for the ack and closes the session exactly once", async () => {
    let releasePublish!: (ack: JetStreamPublishAck) => void;
    const pending = new Promise<JetStreamPublishAck>((resolve) => {
      releasePublish = resolve;
    });
    const close = vi.fn(async () => undefined);
    const publish = vi.fn(async () => pending);
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const dispatcher = createDispatcher({
      sessionFactory: sessionFactory({ publish, close }),
      intervalMs: 60_000
    });

    dispatcher.start();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
    expect(dispatcher.isRunning).toBe(true);
    const timer = setIntervalSpy.mock.results[0]?.value as ReturnType<typeof setInterval>;
    expect(timer.hasRef?.()).toBe(false);

    const firstStop = dispatcher.stop();
    const secondStop = dispatcher.stop();
    expect(secondStop).toBe(firstStop);
    expect(close).not.toHaveBeenCalled();
    releasePublish(ACK);
    await Promise.all([firstStop, secondStop]);

    expect(dispatcher.isRunning).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the active session and does not publish the remainder of a claimed batch on stop", async () => {
    let releasePublish!: (ack: JetStreamPublishAck) => void;
    const pending = new Promise<JetStreamPublishAck>((resolve) => {
      releasePublish = resolve;
    });
    const publish = vi.fn(async () => pending);
    const close = vi.fn(async () => undefined);
    const secondEvent = { ...EVENT, id: "event-2" };
    const dispatcher = createDispatcher({
      claim: async () => [EVENT, secondEvent],
      sessionFactory: sessionFactory({ publish, close }),
      batchSize: 2
    });

    const draining = dispatcher.drainOnce();
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    const stopping = dispatcher.stop();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    releasePublish(ACK);
    const result = await draining;
    await stopping;

    expect(result).toMatchObject({ claimed: 2, completed: 1, skipped: 1 });
    expect(publish).toHaveBeenCalledOnce();
    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 0 });
  });

  it("reports only a sanitized close failure", async () => {
    const dispatcher = createDispatcher({
      sessionFactory: sessionFactory({ close: async () => Promise.reject(new Error("private close detail")) })
    });

    await dispatcher.drainOnce();
    await expect(dispatcher.stop()).rejects.toThrow("jetstream_close_error");
  });

  it.each([
    [{ workerId: "" }, "workerId"],
    [{ subjectPrefix: "hyperion.*" }, "subjectPrefix"],
    [{ expectedStream: "EVENTS.INVALID" }, "expectedStream"],
    [{ authToken: "" }, "NATS_AUTH_TOKEN"],
    [{ authToken: "controlled\r\ntoken" }, "NATS_AUTH_TOKEN"],
    [{ authToken: "controlled-token", username: "channel", password: "controlled-password" }, "mutually exclusive"],
    [{ username: "channel" }, "provided together"],
    [{ servers: [], sessionFactory: undefined }, "servers"],
    [{ servers: "https://nats.example.test:4222", sessionFactory: undefined }, "servers"],
    [{ servers: "nats://user:secret@nats.example.test:4222", sessionFactory: undefined }, "servers"],
    [{ servers: "nats://nats.example.test:4222/private", sessionFactory: undefined }, "servers"],
    [{ servers: "nats://nats.example.test:4222?token=private", sessionFactory: undefined }, "servers"],
    [{ batchSize: 0 }, "batchSize"],
    [{ intervalMs: -1 }, "intervalMs"],
    [{ connectTimeoutMs: 1.5 }, "connectTimeoutMs"],
    [{ publishTimeoutMs: 0 }, "publishTimeoutMs"]
  ] as const)("rejects invalid configuration %o", (override, field) => {
    expect(() => createDispatcher(override)).toThrow(field);
  });

  it("caps an oversized batch at the package maximum", () => {
    const dispatcher = createDispatcher({ batchSize: MAX_JETSTREAM_OUTBOX_BATCH_SIZE + 1_000 });
    expect(dispatcher.batchSize).toBe(MAX_JETSTREAM_OUTBOX_BATCH_SIZE);
  });

  it("captures username/password without exposing either secret on the dispatcher", () => {
    const password = "controlled-password";
    const dispatcher = createDispatcher({ username: "channel", password, sessionFactory: undefined });
    expect(JSON.stringify(dispatcher)).not.toContain(password);
  });
});

function createSession(override: Partial<JetStreamPublisherSession> = {}): JetStreamPublisherSession {
  return {
    publish: async () => ACK,
    close: async () => undefined,
    ...override
  };
}

function sessionFactory(override: Partial<JetStreamPublisherSession> = {}) {
  return async () => createSession(override);
}

function createDispatcher(
  override: Partial<JetStreamOutboxDispatcherOptions<unknown>> = {}
): JetStreamOutboxDispatcher<unknown> {
  const options: JetStreamOutboxDispatcherOptions<unknown> = {
    claim: async () => [EVENT as ClaimedOutboxEvent<unknown>],
    complete: async () => undefined,
    fail: async (_eventId: string, _errorCode: JetStreamOutboxFailureCode) => undefined,
    workerId: "channel-worker-1",
    subjectPrefix: "hyperion.events",
    expectedStream: "HYPERION_EVENTS",
    sessionFactory: sessionFactory(),
    batchSize: 25,
    intervalMs: 1_000,
    connectTimeoutMs: 500,
    publishTimeoutMs: 500,
    ...override
  };
  return new JetStreamOutboxDispatcher(options);
}
