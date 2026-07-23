import type { DatabaseClient } from "@hyperion/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_INBOUND_DURABLE_NAME,
  CHANNEL_INBOUND_EVENT_TYPE,
  createChannelInboundJetStreamHandler,
  startChannelInboundJetStreamConsumer,
  type ChannelInboundReceiver,
  type ManagedJetStreamConsumerFactory
} from "./channel-inbound-jetstream.js";

const EVENT = {
  id: "10dc657b-2dd8-4354-b10f-0cdf5741d7bc",
  type: CHANNEL_INBOUND_EVENT_TYPE,
  version: 2,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
  streamId: "0790ebc5-9058-4dcb-8be0-5e3e85858738",
  streamSequence: 1,
  payload: {
    inboundEventId: "2b7f8da4-74dc-487b-9cd9-d8d45eb8f99f",
    threadBindingId: "0790ebc5-9058-4dcb-8be0-5e3e85858738",
    provider: "whatsapp_web_test",
    externalThreadId: "thread-1",
    externalMessageId: "message-1",
    phoneHash: "a".repeat(64),
    phoneMasked: "***1234",
    body: "hola",
    receivedAt: "2026-07-13T15:00:00.000Z"
  }
} as const;

describe("channel inbound JetStream adapter", () => {
  const bindThread = vi.fn(async () => undefined);
  const channelThreads = { getThread: vi.fn(), bindThread };

  beforeEach(() => {
    bindThread.mockClear();
    bindThread.mockResolvedValue(undefined);
  });

  it("maps accepted and replayed database outcomes to ack after Channel bind", async () => {
    for (const status of ["accepted", "replayed"] as const) {
      const receive = receiverReturning(status);
      await expect(
        createChannelInboundJetStreamHandler(database(), receive, { channelThreads })(EVENT, context())
      ).resolves.toEqual({
        action: "ack"
      });
      expect(bindThread).toHaveBeenCalledWith(
        EVENT.tenantId,
        EVENT.payload.threadBindingId,
        expect.objectContaining({
          patientId: "7698487b-a4f1-4b60-a477-8a721c4583d5",
          conversationId: "f165b7ef-d842-41e7-80d6-176dfc4cb7fb",
          externalMessageId: EVENT.payload.externalMessageId,
          messageId: "45ab619c-4d5e-42ca-b45b-d7935a3d46bd"
        })
      );
    }
  });

  it("retries when Channel bind fails after a successful projection", async () => {
    bindThread.mockRejectedValueOnce(new Error("thread_binding_not_found"));
    await expect(
      createChannelInboundJetStreamHandler(database(), receiverReturning("accepted"), { channelThreads })(
        EVENT,
        context()
      )
    ).resolves.toEqual({ action: "retry" });
  });

  it("maps conflict or strict-envelope failure to term", async () => {
    await expect(
      createChannelInboundJetStreamHandler(database(), receiverReturning("conflict"), { channelThreads })(
        EVENT,
        context()
      )
    ).resolves.toEqual({ action: "term" });
    expect(bindThread).not.toHaveBeenCalled();
    await expect(
      createChannelInboundJetStreamHandler(database(), receiverReturning("accepted"), { channelThreads })(
        { ...EVENT, payload: { ...EVENT.payload, unexpected: true } },
        context()
      )
    ).resolves.toEqual({ action: "term" });
  });

  it("keeps v1 strict and accepts it only through the rollout compatibility handler", async () => {
    const legacy = {
      id: EVENT.id,
      type: "channel.inbound.received.v1",
      version: 1,
      occurredAt: EVENT.occurredAt,
      tenantId: EVENT.tenantId,
      payload: EVENT.payload
    };
    const receive = receiverReturning("accepted");

    await expect(
      createChannelInboundJetStreamHandler(database(), receive, { channelThreads })(legacy, context())
    ).resolves.toEqual({
      action: "term"
    });
    await expect(
      createChannelInboundJetStreamHandler(database(), receive, {
        allowLegacyV1: true,
        channelThreads,
        resolveLegacyPosition: async () => ({
          streamId: EVENT.streamId,
          streamSequence: EVENT.streamSequence
        })
      })(legacy, context())
    ).resolves.toEqual({ action: "ack" });
  });

  it("retries a valid event when PULSO detects a stream gap", async () => {
    await expect(
      createChannelInboundJetStreamHandler(database(), receiverReturning("gap"), { channelThreads })(EVENT, context())
    ).resolves.toEqual({ action: "retry" });
    expect(bindThread).not.toHaveBeenCalled();
  });

  it("maps a transient persistence error to retry", async () => {
    const receive = vi.fn<ChannelInboundReceiver>(async () => Promise.reject(new Error("temporary database failure")));
    await expect(
      createChannelInboundJetStreamHandler(database(), receive, { channelThreads })(EVENT, context())
    ).resolves.toEqual({
      action: "retry"
    });
  });

  it("starts once with fixed topology and stops through the registered close hook", async () => {
    const start = vi.fn();
    const stop = vi.fn(async () => undefined);
    const initialize = vi.fn(async () => undefined);
    const checkReadiness = vi.fn(async () => undefined);
    let closeHook: (() => Promise<void>) | undefined;
    const factory = vi.fn<ManagedJetStreamConsumerFactory>(() => ({ initialize, checkReadiness, start, stop }));

    await startChannelInboundJetStreamConsumer(
      (hook) => {
        closeHook = hook;
      },
      database(),
      { natsUrl: "nats://nats:4222", authToken: "controlled-token" },
      factory
    );

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: CHANNEL_INBOUND_EVENT_TYPE,
        durableName: CHANNEL_INBOUND_DURABLE_NAME,
        connectionName: "pulso-channel-inbound-v2",
        servers: "nats://nats:4222",
        authToken: "controlled-token",
        provisionTopology: false,
        handler: expect.any(Function)
      })
    );
    await closeHook?.();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("runs v1 and v2 durables together during expand/migrate and can contract back to v2 only", async () => {
    const instances: Array<{
      eventType: string;
      durableName: string;
      initialize: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }> = [];
    const factory: ManagedJetStreamConsumerFactory = (options) => {
      const instance = {
        eventType: options.eventType,
        durableName: options.durableName,
        initialize: vi.fn(async () => undefined),
        checkReadiness: vi.fn(async () => undefined),
        start: vi.fn(),
        stop: vi.fn(async () => undefined)
      };
      instances.push(instance);
      return instance;
    };

    const expanded = await startChannelInboundJetStreamConsumer(
      () => undefined,
      database(),
      {
        natsUrl: "nats://nats:4222",
        authToken: "controlled-token",
        allowLegacyV1: true,
        resolveLegacyPosition: async () => ({ streamId: EVENT.streamId, streamSequence: EVENT.streamSequence })
      },
      factory
    );
    expect(instances.map(({ eventType }) => eventType)).toEqual([
      "channel.inbound.received.v2",
      "channel.inbound.received.v1"
    ]);
    await expanded.stop();

    instances.length = 0;
    await startChannelInboundJetStreamConsumer(
      () => undefined,
      database(),
      { natsUrl: "nats://nats:4222", authToken: "controlled-token", allowLegacyV1: false },
      factory
    );
    expect(instances.map(({ eventType }) => eventType)).toEqual(["channel.inbound.received.v2"]);
  });
});

function database(): DatabaseClient {
  return {} as DatabaseClient;
}

function receiverReturning(status: "accepted" | "conflict" | "gap" | "replayed"): ChannelInboundReceiver {
  const receiver: ChannelInboundReceiver = async () => {
    if (status === "conflict") return { status, eventId: EVENT.id };
    if (status === "gap") {
      return {
        status,
        eventId: EVENT.id,
        streamId: EVENT.streamId,
        expectedSequence: 1,
        receivedSequence: 2
      };
    }
    const result = {
      eventId: EVENT.id,
      patientId: "7698487b-a4f1-4b60-a477-8a721c4583d5",
      conversationId: "f165b7ef-d842-41e7-80d6-176dfc4cb7fb",
      messageId: "45ab619c-4d5e-42ca-b45b-d7935a3d46bd",
      outboxEventType: "pulso.message.received.v2" as const
    };
    return status === "accepted" ? { status: "accepted", result } : { status: "replayed", result };
  };
  return vi.fn(receiver);
}

function context() {
  return { subject: `hyperion.events.${CHANNEL_INBOUND_EVENT_TYPE}`, deliveryCount: 1 } as const;
}
