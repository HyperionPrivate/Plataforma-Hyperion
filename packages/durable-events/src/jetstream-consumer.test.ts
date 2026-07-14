import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableJetStreamConsumer,
  HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD,
  HYPERION_CONSUMER_SERVER_MAX_DELIVER,
  HYPERION_EVENTS_STREAM,
  JetStreamTopologyDriftError,
  createNatsJetStreamConsumerSessionFactory,
  ensureHyperionJetStreamTopology,
  hyperionConsumerConfiguration,
  hyperionStreamConfiguration,
  type HyperionConsumerConfiguration,
  type HyperionConsumerTopologySnapshot,
  type HyperionStreamConfiguration,
  type JetStreamConsumerMessage,
  type JetStreamConsumerSession,
  type JetStreamTopologyAdapter,
  type JsonValue,
  type OutboxEventEnvelope
} from "./index.js";

const EVENT_TYPE = "channel.inbound.received.v1";
const EVENT: OutboxEventEnvelope<{ readonly body: string }> = {
  id: "10dc657b-2dd8-4354-b10f-0cdf5741d7bc",
  type: EVENT_TYPE,
  version: 1,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
  payload: { body: "controlled-message" }
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DurableJetStreamConsumer", () => {
  it("preflights and checks the durable without pulling a message", async () => {
    const check = vi.fn(async () => undefined);
    const session = createSession({ check });
    const factory = vi.fn(async () => session);
    const consumer = createConsumer({ sessionFactory: factory });

    await expect(consumer.initialize()).resolves.toBeUndefined();
    await expect(consumer.checkReadiness()).resolves.toBeUndefined();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(session.next).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it("retires a durable session after a passive readiness failure", async () => {
    const first = createSession({ check: async () => Promise.reject(new Error("private broker detail")) });
    const second = createSession({ check: async () => undefined });
    const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const consumer = createConsumer({ sessionFactory: factory });

    await consumer.initialize();
    await expect(consumer.checkReadiness()).rejects.toThrow("jetstream_consumer_not_ready");
    expect(first.close).toHaveBeenCalledTimes(1);
    await expect(consumer.initialize()).resolves.toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(2);
    await consumer.stop();
  });

  it("bounds a stalled passive durable check without pulling a message", async () => {
    vi.useFakeTimers();
    const session = createSession({ check: async () => new Promise<void>(() => undefined) });
    const consumer = createConsumer({ sessionFactory: async () => session, connectTimeoutMs: 500 });
    await consumer.initialize();

    const readiness = expect(consumer.checkReadiness()).rejects.toThrow("jetstream_consumer_not_ready");
    await vi.advanceTimersByTimeAsync(500);
    await readiness;
    expect(session.next).not.toHaveBeenCalled();
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("acks only after a successful handler decision", async () => {
    const order: string[] = [];
    const message = createMessage({
      ack: async () => {
        order.push("ack");
      }
    });
    const session = createSession({ next: async () => message });
    const handler = vi.fn(async () => {
      order.push("handler");
      return { action: "ack" } as const;
    });
    const consumer = createConsumer({ sessionFactory: async () => session, handler });

    await expect(consumer.consumeOnce()).resolves.toEqual({ status: "acked", deliveryCount: 1 });
    expect(order).toEqual(["handler", "ack"]);
    expect(message.nak).not.toHaveBeenCalled();
    expect(message.term).not.toHaveBeenCalled();
    expect(session.publish).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it("preserves a complete ordered stream position for a v2 handler", async () => {
    const ordered = {
      ...EVENT,
      type: "channel.inbound.received.v2",
      version: 2,
      streamId: "0790ebc5-9058-4dcb-8be0-5e3e85858738",
      streamSequence: 9
    };
    const message = createMessage({
      subject: "hyperion.events.channel.inbound.received.v2",
      data: new TextEncoder().encode(JSON.stringify(ordered))
    });
    const session = createSession({ next: async () => message });
    const handler = vi.fn(async () => ({ action: "ack" }) as const);
    const consumer = createConsumer({
      eventType: "channel.inbound.received.v2",
      durableName: "pulso_channel_inbound_v2",
      sessionFactory: async () => session,
      handler
    });

    await expect(consumer.consumeOnce()).resolves.toMatchObject({ status: "acked" });
    expect(handler).toHaveBeenCalledWith(ordered, expect.any(Object));
    await consumer.stop();
  });

  it("dead-letters an envelope that supplies only half of an ordered stream position", async () => {
    const partial = { ...EVENT, streamId: "0790ebc5-9058-4dcb-8be0-5e3e85858738" };
    const message = createMessage({ data: new TextEncoder().encode(JSON.stringify(partial)) });
    const session = createSession({ next: async () => message });
    const handler = vi.fn(async () => ({ action: "ack" }) as const);
    const consumer = createConsumer({ sessionFactory: async () => session, handler });

    await expect(consumer.consumeOnce()).resolves.toMatchObject({ status: "terminated" });
    expect(handler).not.toHaveBeenCalled();
    expect(message.term).toHaveBeenCalledWith("invalid_envelope");
    await consumer.stop();
  });

  it("naks a retry decision with a bounded handler delay", async () => {
    const message = createMessage();
    const session = createSession({ next: async () => message });
    const consumer = createConsumer({
      sessionFactory: async () => session,
      handler: async () => ({ action: "retry", delayMs: 2_500 })
    });

    await expect(consumer.consumeOnce()).resolves.toEqual({ status: "retried", deliveryCount: 1 });
    expect(message.nak).toHaveBeenCalledWith(2_500);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.term).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it("publishes a minimal DLQ record and waits for its ack before terming a permanent failure", async () => {
    const order: string[] = [];
    const message = createMessage({
      term: async () => {
        order.push("term");
      }
    });
    const publish = vi.fn<JetStreamConsumerSession["publish"]>(async () => {
      order.push("dlq_ack");
      return { stream: HYPERION_EVENTS_STREAM, seq: 9, duplicate: false };
    });
    const session = createSession({ next: async () => message, publish });
    const consumer = createConsumer({
      sessionFactory: async () => session,
      handler: async () => ({ action: "term" }),
      now: () => new Date("2026-07-13T16:00:00.000Z")
    });

    await expect(consumer.consumeOnce()).resolves.toEqual({ status: "terminated", deliveryCount: 1 });
    expect(order).toEqual(["dlq_ack", "term"]);
    expect(publish).toHaveBeenCalledTimes(1);
    const [subject, bytes, options] = publish.mock.calls[0]!;
    expect(subject).toBe("hyperion.dlq.channel.inbound.received.v1");
    expect(options).toEqual({
      msgID: expect.stringMatching(/^dlq-event-[a-f0-9]{64}$/),
      timeout: 500,
      expect: { streamName: HYPERION_EVENTS_STREAM }
    });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      sourceEventId: EVENT.id,
      sourceEventType: EVENT_TYPE,
      sourceSubject: `hyperion.events.${EVENT_TYPE}`,
      deliveryCount: 1,
      reason: "handler_term",
      failedAt: "2026-07-13T16:00:00.000Z"
    });
    expect(new TextDecoder().decode(bytes)).not.toContain("controlled-message");
    expect(message.ack).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it("dead-letters a retry at the application delivery threshold", async () => {
    const message = createMessage({ deliveryCount: HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD });
    const session = createSession({ next: async () => message });
    const consumer = createConsumer({
      sessionFactory: async () => session,
      handler: async () => ({ action: "retry" })
    });

    await expect(consumer.consumeOnce()).resolves.toEqual({
      status: "terminated",
      deliveryCount: HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD
    });
    const dlqPayload = JSON.parse(new TextDecoder().decode(session.publish.mock.calls[0]![1])) as {
      reason: string;
    };
    expect(dlqPayload.reason).toBe("retry_threshold");
    expect(message.nak).not.toHaveBeenCalled();
    expect(message.term).toHaveBeenCalledWith("retry_threshold");
    await consumer.stop();
  });

  it("retries delivery 12 when DLQ fails and terminates only after DLQ succeeds on delivery 13", async () => {
    const delivery12 = createMessage({ deliveryCount: HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD });
    const delivery13 = createMessage({ deliveryCount: HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD + 1 });
    const next = vi.fn().mockResolvedValueOnce(delivery12).mockResolvedValueOnce(delivery13);
    const publish = vi
      .fn<JetStreamConsumerSession["publish"]>()
      .mockRejectedValueOnce(new Error("controlled DLQ outage"))
      .mockResolvedValueOnce({ stream: HYPERION_EVENTS_STREAM, seq: 13, duplicate: false });
    const session = createSession({ next, publish });
    const consumer = createConsumer({
      sessionFactory: async () => session,
      handler: async () => ({ action: "retry" }),
      retryDelayMs: 4_000
    });

    await expect(consumer.consumeOnce()).resolves.toEqual({
      status: "dlq_failed",
      deliveryCount: HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD
    });
    expect(delivery12.nak).toHaveBeenCalledWith(4_000);
    expect(delivery12.term).not.toHaveBeenCalled();

    await expect(consumer.consumeOnce()).resolves.toEqual({
      status: "terminated",
      deliveryCount: HYPERION_CONSUMER_DLQ_DELIVERY_THRESHOLD + 1
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(delivery13.term).toHaveBeenCalledWith("retry_threshold");
    expect(delivery13.nak).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it("does not ack or term when the DLQ publication fails", async () => {
    const message = createMessage();
    const session = createSession({
      next: async () => message,
      publish: async () => Promise.reject(new Error("private broker detail"))
    });
    const consumer = createConsumer({
      sessionFactory: async () => session,
      handler: async () => ({ action: "term" }),
      retryDelayMs: 4_000
    });

    await expect(consumer.consumeOnce()).resolves.toEqual({ status: "dlq_failed", deliveryCount: 1 });
    expect(message.nak).toHaveBeenCalledWith(4_000);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.term).not.toHaveBeenCalled();
    await consumer.stop();
  });

  it("dead-letters bounded invalid JSON without invoking the handler or copying its bytes", async () => {
    const invalidBytes = new TextEncoder().encode('{"payload":"private-value"');
    const message = createMessage({ data: invalidBytes });
    const session = createSession({ next: async () => message });
    const handler = vi.fn(async () => ({ action: "ack" }) as const);
    const consumer = createConsumer({
      sessionFactory: async () => session,
      handler,
      now: () => new Date("2026-07-13T16:00:00.000Z")
    });

    await expect(consumer.consumeOnce()).resolves.toEqual({ status: "terminated", deliveryCount: 1 });
    expect(handler).not.toHaveBeenCalled();
    const [, dlqBytes, options] = session.publish.mock.calls[0]!;
    expect(options.msgID).toMatch(/^dlq-invalid-[a-f0-9]{64}$/);
    const text = new TextDecoder().decode(dlqBytes);
    expect(text).toContain('"reason":"invalid_json"');
    expect(text).not.toContain("private-value");
    expect(message.term).toHaveBeenCalledWith("invalid_json");
    await consumer.stop();
  });

  it("uses distinct DLQ message ids for identical invalid bytes across subjects and stream messages", async () => {
    const invalidBytes = new TextEncoder().encode("{");
    const firstSession = createSession({
      next: async () => createMessage({ data: invalidBytes, streamSequence: 41 })
    });
    const secondSession = createSession({
      next: async () =>
        createMessage({
          subject: "hyperion.events.lumen.audit.event.record.v1",
          data: invalidBytes,
          streamSequence: 41
        })
    });
    const thirdSession = createSession({
      next: async () => createMessage({ data: invalidBytes, streamSequence: 42 })
    });
    const consumers = [
      createConsumer({ sessionFactory: async () => firstSession }),
      createConsumer({
        eventType: "lumen.audit.event.record.v1",
        durableName: "audit_lumen_event_record_v1",
        sessionFactory: async () => secondSession
      }),
      createConsumer({ sessionFactory: async () => thirdSession })
    ];

    await Promise.all(consumers.map((consumer) => consumer.consumeOnce()));
    const messageIds = [firstSession, secondSession, thirdSession].map(
      (session) => session.publish.mock.calls[0]![2].msgID
    );
    expect(new Set(messageIds).size).toBe(3);
    expect(messageIds.every((messageId) => /^dlq-invalid-[a-f0-9]{64}$/.test(messageId))).toBe(true);
    await Promise.all(consumers.map((consumer) => consumer.stop()));
  });

  it("treats an oversized body as permanent before JSON parsing", async () => {
    const message = createMessage({ data: new Uint8Array(33) });
    const session = createSession({ next: async () => message });
    const handler = vi.fn(async () => ({ action: "ack" }) as const);
    const consumer = createConsumer({ sessionFactory: async () => session, handler, maxPayloadBytes: 32 });

    await expect(consumer.consumeOnce()).resolves.toMatchObject({ status: "terminated" });
    expect(handler).not.toHaveBeenCalled();
    const record = JSON.parse(new TextDecoder().decode(session.publish.mock.calls[0]![1])) as { reason: string };
    expect(record.reason).toBe("payload_too_large");
    await consumer.stop();
  });

  it("serializes concurrent consumeOnce calls", async () => {
    let release!: (message: JetStreamConsumerMessage) => void;
    const pending = new Promise<JetStreamConsumerMessage>((resolve) => {
      release = resolve;
    });
    const next = vi.fn(async () => pending);
    const session = createSession({ next });
    const consumer = createConsumer({ sessionFactory: async () => session });

    const first = consumer.consumeOnce();
    const second = consumer.consumeOnce();
    expect(second).toBe(first);
    release(createMessage());
    await Promise.all([first, second]);
    expect(next).toHaveBeenCalledTimes(1);
    await consumer.stop();
  });

  it("starts and stops once, cancels the outstanding pull, and unreferences idle timers", async () => {
    let releaseNext!: (message: null) => void;
    const pending = new Promise<null>((resolve) => {
      releaseNext = resolve;
    });
    const next = vi.fn(async () => pending);
    const close = vi.fn(async () => {
      releaseNext(null);
    });
    const session = createSession({ next, close });
    const factory = vi.fn(async () => session);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const consumer = createConsumer({ sessionFactory: factory, idleDelayMs: 60_000 });

    consumer.start();
    consumer.start();
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
    expect(consumer.isRunning).toBe(true);

    releaseNext(null);
    await vi.waitFor(() => expect(setTimeoutSpy).toHaveBeenCalled());
    const timer = setTimeoutSpy.mock.results.at(-1)?.value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef?.()).toBe(false);

    const firstStop = consumer.stop();
    const secondStop = consumer.stop();
    expect(secondStop).toBe(firstStop);
    await Promise.all([firstStop, secondStop]);
    expect(consumer.isRunning).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("forces the transport closed and bounds stop when graceful close and pull are blocked", async () => {
    vi.useFakeTimers();
    const next = vi.fn(async () => new Promise<null>(() => undefined));
    const close = vi.fn(async () => new Promise<void>(() => undefined));
    const forceClose = vi.fn(async () => undefined);
    const session = createSession({ next, close, forceClose });
    const consumer = createConsumer({
      sessionFactory: async () => session,
      connectTimeoutMs: 100,
      stopTimeoutMs: 200
    });

    consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(next).toHaveBeenCalledOnce();

    const stopping = consumer.stop();
    await vi.advanceTimersByTimeAsync(80);
    expect(close).toHaveBeenCalledOnce();
    expect(forceClose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120);
    await expect(stopping).resolves.toBeUndefined();

    expect(consumer.isRunning).toBe(false);
    await expect(consumer.consumeOnce()).resolves.toEqual({ status: "idle" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("bounds stop and never acknowledges after a handler remains blocked", async () => {
    vi.useFakeTimers();
    const message = createMessage();
    const handler = vi.fn(async () => new Promise<{ action: "ack" }>(() => undefined));
    const session = createSession({ next: async () => message });
    const consumer = createConsumer({
      sessionFactory: async () => session,
      handler,
      stopTimeoutMs: 100
    });

    consumer.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();

    const stopping = consumer.stop();
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopping).resolves.toBeUndefined();

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.nak).not.toHaveBeenCalled();
    expect(message.term).not.toHaveBeenCalled();
    expect(consumer.isRunning).toBe(false);
  });

  it("closes a broken session and reconnects on the next pull", async () => {
    const first = createSession({ next: async () => Promise.reject(new Error("private disconnect")) });
    const second = createSession({ next: async () => createMessage() });
    const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const consumer = createConsumer({ sessionFactory: factory });

    await expect(consumer.consumeOnce()).resolves.toEqual({ status: "session_error" });
    expect(first.close).toHaveBeenCalledTimes(1);
    await expect(consumer.consumeOnce()).resolves.toEqual({ status: "acked", deliveryCount: 1 });
    expect(factory).toHaveBeenCalledTimes(2);
    await consumer.stop();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ eventType: "channel.*" }, "eventType"],
    [{ durableName: "invalid.name" }, "durableName"],
    [{ connectionName: "invalid name" }, "connectionName"],
    [{ servers: "nats://user:password@127.0.0.1:4222" }, "servers"],
    [{ servers: "https://127.0.0.1:4222" }, "servers"],
    [{ servers: "nats://127.0.0.1:4222/" }, "servers"],
    [{ servers: "nats://127.0.0.1:4222/path" }, "servers"],
    [{ servers: "nats://127.0.0.1:4222?token=unsafe" }, "servers"],
    [{ servers: "nats://127.0.0.1:4222#fragment" }, "servers"],
    [{ authToken: "secret\r\nvalue" }, "NATS_AUTH_TOKEN"],
    [{ authToken: "controlled-token", username: "pulso", password: "controlled-password" }, "mutually exclusive"],
    [{ username: "pulso" }, "provided together"],
    [{ pullExpiresMs: 999 }, "pullExpiresMs"],
    [{ stopTimeoutMs: 0 }, "stopTimeoutMs"],
    [{ maxPayloadBytes: 128 * 1_024 + 1 }, "maxPayloadBytes"]
  ] as const)("rejects unsafe or unbounded configuration %o", (override, field) => {
    expect(() => createConsumer(override)).toThrow(field);
  });

  it("does not expose the captured auth token on the consumer", () => {
    const token = "controlled-secret-token";
    const consumer = createConsumer({ authToken: token });
    expect(JSON.stringify(consumer)).not.toContain(token);
  });

  it("does not expose captured username/password credentials on the consumer", () => {
    const password = "controlled-password";
    const consumer = createConsumer({ username: "pulso", password });
    expect(JSON.stringify(consumer)).not.toContain(password);
  });
});

describe("ensureHyperionJetStreamTopology", () => {
  it("creates missing resources once and is idempotent", async () => {
    const fixture = createTopologyFixture();

    await expect(
      ensureHyperionJetStreamTopology(fixture.adapter, { eventType: EVENT_TYPE, durableName: "pulso_inbound" })
    ).resolves.toEqual({ streamCreated: true, consumerCreated: true, legacyConsumerUpgraded: false });
    await expect(
      ensureHyperionJetStreamTopology(fixture.adapter, { eventType: EVENT_TYPE, durableName: "pulso_inbound" })
    ).resolves.toEqual({ streamCreated: false, consumerCreated: false, legacyConsumerUpgraded: false });

    expect(fixture.addStream).toHaveBeenCalledTimes(1);
    expect(fixture.addConsumer).toHaveBeenCalledTimes(1);
    expect(fixture.stream).toEqual(hyperionStreamConfiguration());
    expect(fixture.consumer).toEqual(
      hyperionConsumerConfiguration({ eventType: EVENT_TYPE, durableName: "pulso_inbound" })
    );
  });

  it("accepts compatible topology regardless of stream subject order", async () => {
    const stream = hyperionStreamConfiguration();
    const consumer = hyperionConsumerConfiguration({ eventType: EVENT_TYPE, durableName: "pulso_inbound" });
    const adapter: JetStreamTopologyAdapter = {
      getStream: async () => ({ ...stream, subjects: [...stream.subjects].reverse() }),
      addStream: vi.fn(async () => undefined),
      getConsumer: async () => consumer,
      addConsumer: vi.fn(async () => undefined),
      updateConsumerMaxDeliver: vi.fn(async () => undefined)
    };

    await expect(
      ensureHyperionJetStreamTopology(adapter, { eventType: EVENT_TYPE, durableName: "pulso_inbound" })
    ).resolves.toEqual({ streamCreated: false, consumerCreated: false, legacyConsumerUpgraded: false });
    expect(adapter.addStream).not.toHaveBeenCalled();
    expect(adapter.addConsumer).not.toHaveBeenCalled();
  });

  it("rejects incompatible stream drift without mutating it", async () => {
    const stream = hyperionStreamConfiguration();
    const adapter: JetStreamTopologyAdapter = {
      getStream: async () => ({ ...stream, max_msg_size: stream.max_msg_size + 1 }),
      addStream: vi.fn(async () => undefined),
      getConsumer: async () => undefined,
      addConsumer: vi.fn(async () => undefined),
      updateConsumerMaxDeliver: vi.fn(async () => undefined)
    };

    await expect(
      ensureHyperionJetStreamTopology(adapter, { eventType: EVENT_TYPE, durableName: "pulso_inbound" })
    ).rejects.toEqual(expect.objectContaining<Partial<JetStreamTopologyDriftError>>({ resource: "stream" }));
    expect(adapter.addStream).not.toHaveBeenCalled();
    expect(adapter.addConsumer).not.toHaveBeenCalled();
  });

  it("rejects incompatible consumer drift without replacing it", async () => {
    const stream = hyperionStreamConfiguration();
    const consumer = hyperionConsumerConfiguration({ eventType: EVENT_TYPE, durableName: "pulso_inbound" });
    const adapter: JetStreamTopologyAdapter = {
      getStream: async () => stream,
      addStream: vi.fn(async () => undefined),
      getConsumer: async () => ({ ...consumer, max_ack_pending: 2 }),
      addConsumer: vi.fn(async () => undefined),
      updateConsumerMaxDeliver: vi.fn(async () => undefined)
    };

    await expect(
      ensureHyperionJetStreamTopology(adapter, { eventType: EVENT_TYPE, durableName: "pulso_inbound" })
    ).rejects.toEqual(expect.objectContaining<Partial<JetStreamTopologyDriftError>>({ resource: "consumer" }));
    expect(adapter.addConsumer).not.toHaveBeenCalled();
    expect(adapter.updateConsumerMaxDeliver).not.toHaveBeenCalled();
  });

  it("upgrades only the legacy max_deliver value in place", async () => {
    const fixture = createTopologyFixture();
    const expected = hyperionConsumerConfiguration({ eventType: EVENT_TYPE, durableName: "pulso_inbound" });
    fixture.stream = hyperionStreamConfiguration();
    fixture.consumer = { ...expected, max_deliver: 12 };

    await expect(
      ensureHyperionJetStreamTopology(fixture.adapter, { eventType: EVENT_TYPE, durableName: "pulso_inbound" })
    ).resolves.toEqual({ streamCreated: false, consumerCreated: false, legacyConsumerUpgraded: true });

    expect(fixture.updateConsumerMaxDeliver).toHaveBeenCalledWith(
      HYPERION_EVENTS_STREAM,
      "pulso_inbound",
      HYPERION_CONSUMER_SERVER_MAX_DELIVER
    );
    expect(fixture.consumer).toEqual(expected);
  });

  it("fails closed instead of upgrading legacy max_deliver when another field also drifted", async () => {
    const fixture = createTopologyFixture();
    const expected = hyperionConsumerConfiguration({ eventType: EVENT_TYPE, durableName: "pulso_inbound" });
    fixture.stream = hyperionStreamConfiguration();
    fixture.consumer = { ...expected, max_deliver: 12, max_ack_pending: 2 };

    await expect(
      ensureHyperionJetStreamTopology(fixture.adapter, { eventType: EVENT_TYPE, durableName: "pulso_inbound" })
    ).rejects.toEqual(expect.objectContaining<Partial<JetStreamTopologyDriftError>>({ resource: "consumer" }));
    expect(fixture.updateConsumerMaxDeliver).not.toHaveBeenCalled();
  });
});

const testNatsUrl = process.env.TEST_NATS_URL;

describe.skipIf(!testNatsUrl)("DurableJetStreamConsumer real JetStream integration", () => {
  it("provisions, pulls and confirms one event", async () => {
    const suffix = `${process.pid}_${Date.now()}`;
    const eventType = `durable_events.integration.${suffix}`;
    const durableName = `durable_events_${suffix}`;
    const connectionName = `durable_events_test_${suffix}`;
    const authToken = process.env.TEST_NATS_AUTH_TOKEN;
    const sessionFactory = createNatsJetStreamConsumerSessionFactory({
      eventType,
      durableName,
      connectionName,
      servers: testNatsUrl!,
      authToken,
      provisionTopology: true,
      connectTimeoutMs: 5_000,
      publishTimeoutMs: 5_000
    });
    const provisionSession = await sessionFactory();
    await provisionSession.close();

    const publisherConnection = await connect({
      servers: testNatsUrl!,
      name: `${connectionName}_publisher`,
      ...(authToken === undefined ? {} : { token: authToken })
    });
    const manager = await jetstreamManager(publisherConnection);
    const client = jetstream(publisherConnection);
    const provisionedInfo = await manager.consumers.info(HYPERION_EVENTS_STREAM, durableName);
    expect(provisionedInfo.config.max_deliver).toBe(HYPERION_CONSUMER_SERVER_MAX_DELIVER);
    const event: OutboxEventEnvelope<JsonValue> = {
      id: `event_${suffix}`,
      type: eventType,
      version: 1,
      occurredAt: new Date().toISOString(),
      tenantId: null,
      payload: { integration: true }
    };
    await client.publish(`hyperion.events.${eventType}`, new TextEncoder().encode(JSON.stringify(event)), {
      msgID: event.id,
      expect: { streamName: HYPERION_EVENTS_STREAM }
    });

    const handler = vi.fn(async () => ({ action: "ack" }) as const);
    const consumer = new DurableJetStreamConsumer({
      eventType,
      durableName,
      connectionName,
      servers: testNatsUrl!,
      authToken,
      pullExpiresMs: 2_000,
      handler
    });
    try {
      await expect(consumer.consumeOnce()).resolves.toEqual({ status: "acked", deliveryCount: 1 });
      expect(handler).toHaveBeenCalledWith(event, {
        subject: `hyperion.events.${eventType}`,
        deliveryCount: 1
      });
    } finally {
      await consumer.stop();
      await manager.consumers.delete(HYPERION_EVENTS_STREAM, durableName);
      await publisherConnection.drain();
    }
  }, 20_000);

  it("upgrades a legacy max_deliver=12 durable in place without resetting its cursor", async () => {
    const suffix = `${process.pid}_${Date.now()}_upgrade`;
    const eventType = `durable_events.integration.${suffix}`;
    const durableName = `durable_events_${suffix}`;
    const connectionName = `durable_events_test_${suffix}`;
    const authToken = process.env.TEST_NATS_AUTH_TOKEN;
    const sessionFactory = createNatsJetStreamConsumerSessionFactory({
      eventType,
      durableName,
      connectionName,
      servers: testNatsUrl!,
      authToken,
      provisionTopology: true,
      connectTimeoutMs: 5_000,
      publishTimeoutMs: 5_000
    });
    const initialSession = await sessionFactory();
    await initialSession.close();

    const publisherConnection = await connect({
      servers: testNatsUrl!,
      name: `${connectionName}_publisher`,
      ...(authToken === undefined ? {} : { token: authToken })
    });
    const manager = await jetstreamManager(publisherConnection);
    const client = jetstream(publisherConnection);
    let upgradedSession: JetStreamConsumerSession | undefined;
    try {
      await manager.consumers.update(HYPERION_EVENTS_STREAM, durableName, { max_deliver: 12 });
      const firstEvent = { ...EVENT, id: `event_${suffix}_1`, type: eventType, payload: { body: "first" } };
      await client.publish(`hyperion.events.${eventType}`, new TextEncoder().encode(JSON.stringify(firstEvent)), {
        msgID: firstEvent.id,
        expect: { streamName: HYPERION_EVENTS_STREAM }
      });

      const legacyConsumer = await client.consumers.get(HYPERION_EVENTS_STREAM, durableName);
      const firstMessage = await legacyConsumer.next({ expires: 2_000 });
      expect(firstMessage).not.toBeNull();
      expect(await firstMessage!.ackAck()).toBe(true);
      const before = await manager.consumers.info(HYPERION_EVENTS_STREAM, durableName);
      expect(before.config.max_deliver).toBe(12);
      expect(before.ack_floor.consumer_seq).toBeGreaterThan(0);

      upgradedSession = await sessionFactory();
      const after = await manager.consumers.info(HYPERION_EVENTS_STREAM, durableName);
      expect(after.config.max_deliver).toBe(HYPERION_CONSUMER_SERVER_MAX_DELIVER);
      expect(after.ack_floor.consumer_seq).toBe(before.ack_floor.consumer_seq);
      expect(after.ack_floor.stream_seq).toBe(before.ack_floor.stream_seq);
      expect(after.delivered.consumer_seq).toBe(before.delivered.consumer_seq);
      expect(after.delivered.stream_seq).toBe(before.delivered.stream_seq);

      const secondEvent = { ...EVENT, id: `event_${suffix}_2`, type: eventType, payload: { body: "second" } };
      await client.publish(`hyperion.events.${eventType}`, new TextEncoder().encode(JSON.stringify(secondEvent)), {
        msgID: secondEvent.id,
        expect: { streamName: HYPERION_EVENTS_STREAM }
      });
      const secondMessage = await upgradedSession.next(2_000);
      expect(secondMessage).not.toBeNull();
      expect(JSON.parse(new TextDecoder().decode(secondMessage!.data))).toEqual(secondEvent);
      await secondMessage!.ack();
    } finally {
      await upgradedSession?.close();
      await manager.consumers.delete(HYPERION_EVENTS_STREAM, durableName);
      await publisherConnection.drain();
    }
  }, 20_000);
});

function createConsumer(
  override: Partial<ConstructorParameters<typeof DurableJetStreamConsumer>[0]> = {}
): DurableJetStreamConsumer {
  return new DurableJetStreamConsumer({
    eventType: EVENT_TYPE,
    durableName: "pulso_inbound",
    connectionName: "pulso_inbound_test",
    handler: async () => ({ action: "ack" }),
    sessionFactory: async () => createSession(),
    pullExpiresMs: 1_000,
    reconnectDelayMs: 10,
    idleDelayMs: 10,
    retryDelayMs: 1_000,
    publishTimeoutMs: 500,
    connectTimeoutMs: 500,
    ...override
  });
}

function createMessage(override: Partial<JetStreamConsumerMessage> = {}): JetStreamConsumerMessage & {
  ack: ReturnType<typeof vi.fn>;
  nak: ReturnType<typeof vi.fn>;
  term: ReturnType<typeof vi.fn>;
} {
  return {
    subject: `hyperion.events.${EVENT_TYPE}`,
    data: new TextEncoder().encode(JSON.stringify(EVENT)),
    deliveryCount: 1,
    streamSequence: 1,
    ack: vi.fn(async () => undefined),
    nak: vi.fn(async () => undefined),
    term: vi.fn(async () => undefined),
    ...override
  } as JetStreamConsumerMessage & {
    ack: ReturnType<typeof vi.fn>;
    nak: ReturnType<typeof vi.fn>;
    term: ReturnType<typeof vi.fn>;
  };
}

function createSession(override: Partial<JetStreamConsumerSession> = {}): JetStreamConsumerSession & {
  next: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    next: vi.fn(async () => null),
    publish: vi.fn(async () => ({ stream: HYPERION_EVENTS_STREAM, seq: 1, duplicate: false })),
    close: vi.fn(async () => undefined),
    ...override
  } as JetStreamConsumerSession & {
    next: ReturnType<typeof vi.fn>;
    publish: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function createTopologyFixture(): {
  readonly adapter: JetStreamTopologyAdapter;
  readonly addStream: ReturnType<typeof vi.fn>;
  readonly addConsumer: ReturnType<typeof vi.fn>;
  readonly updateConsumerMaxDeliver: ReturnType<typeof vi.fn>;
  stream: HyperionStreamConfiguration | undefined;
  consumer: HyperionConsumerTopologySnapshot | undefined;
} {
  const fixture: {
    adapter: JetStreamTopologyAdapter;
    addStream: ReturnType<typeof vi.fn>;
    addConsumer: ReturnType<typeof vi.fn>;
    updateConsumerMaxDeliver: ReturnType<typeof vi.fn>;
    stream: HyperionStreamConfiguration | undefined;
    consumer: HyperionConsumerTopologySnapshot | undefined;
  } = {
    adapter: undefined as unknown as JetStreamTopologyAdapter,
    addStream: undefined as unknown as ReturnType<typeof vi.fn>,
    addConsumer: undefined as unknown as ReturnType<typeof vi.fn>,
    updateConsumerMaxDeliver: undefined as unknown as ReturnType<typeof vi.fn>,
    stream: undefined,
    consumer: undefined
  };
  fixture.addStream = vi.fn(async (configuration: HyperionStreamConfiguration) => {
    fixture.stream = configuration;
  });
  fixture.addConsumer = vi.fn(async (_stream: string, configuration: HyperionConsumerConfiguration) => {
    fixture.consumer = configuration;
  });
  fixture.updateConsumerMaxDeliver = vi.fn(
    async (_stream: string, _durableName: string, maxDeliver: typeof HYPERION_CONSUMER_SERVER_MAX_DELIVER) => {
      if (fixture.consumer !== undefined) {
        fixture.consumer = { ...fixture.consumer, max_deliver: maxDeliver };
      }
    }
  );
  fixture.adapter = {
    getStream: async () => fixture.stream,
    addStream: fixture.addStream,
    getConsumer: async () => fixture.consumer,
    addConsumer: fixture.addConsumer,
    updateConsumerMaxDeliver: fixture.updateConsumerMaxDeliver
  };
  return fixture;
}
