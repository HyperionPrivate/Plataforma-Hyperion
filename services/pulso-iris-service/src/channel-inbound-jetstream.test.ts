import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
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
  version: 1,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
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
  it("maps accepted and replayed database outcomes to ack", async () => {
    for (const status of ["accepted", "replayed"] as const) {
      const receive = receiverReturning(status);
      await expect(createChannelInboundJetStreamHandler(database(), receive)(EVENT, context())).resolves.toEqual({
        action: "ack"
      });
    }
  });

  it("maps conflict or strict-envelope failure to term", async () => {
    await expect(
      createChannelInboundJetStreamHandler(database(), receiverReturning("conflict"))(EVENT, context())
    ).resolves.toEqual({ action: "term" });
    await expect(
      createChannelInboundJetStreamHandler(database(), receiverReturning("accepted"))(
        { ...EVENT, payload: { ...EVENT.payload, unexpected: true } },
        context()
      )
    ).resolves.toEqual({ action: "term" });
  });

  it("maps a transient persistence error to retry", async () => {
    const receive = vi.fn<ChannelInboundReceiver>(async () => Promise.reject(new Error("temporary database failure")));
    await expect(createChannelInboundJetStreamHandler(database(), receive)(EVENT, context())).resolves.toEqual({
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
        connectionName: "pulso-channel-inbound",
        servers: "nats://nats:4222",
        authToken: "controlled-token",
        provisionTopology: false,
        handler: expect.any(Function)
      })
    );
    await closeHook?.();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

function database(): DatabaseClient {
  return {} as DatabaseClient;
}

function receiverReturning(status: "accepted" | "conflict" | "replayed"): ChannelInboundReceiver {
  const receiver: ChannelInboundReceiver = async () => {
    if (status === "conflict") return { status, eventId: EVENT.id };
    const result = {
      eventId: EVENT.id,
      patientId: "7698487b-a4f1-4b60-a477-8a721c4583d5",
      conversationId: "f165b7ef-d842-41e7-80d6-176dfc4cb7fb",
      messageId: "45ab619c-4d5e-42ca-b45b-d7935a3d46bd",
      outboxEventType: "pulso.message.received.v1" as const
    };
    return status === "accepted" ? { status: "accepted", result } : { status: "replayed", result };
  };
  return vi.fn(receiver);
}

function context() {
  return { subject: `hyperion.events.${CHANNEL_INBOUND_EVENT_TYPE}`, deliveryCount: 1 } as const;
}
