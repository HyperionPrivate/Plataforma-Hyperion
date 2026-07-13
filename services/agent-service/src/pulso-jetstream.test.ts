import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import {
  PULSO_MESSAGE_DURABLE_NAME,
  PULSO_MESSAGE_EVENT_TYPE,
  createPulsoMessageJetStreamHandler,
  startPulsoMessageJetStreamConsumer,
  type ManagedJetStreamConsumerFactory,
  type PulsoMessageReceiver
} from "./pulso-jetstream.js";

const EVENT = {
  id: "a56e320f-cbce-4e96-b7fc-c79e52970a52",
  type: PULSO_MESSAGE_EVENT_TYPE,
  version: 1,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
  payload: {
    inboundEventId: "2b7f8da4-74dc-487b-9cd9-d8d45eb8f99f",
    threadBindingId: "0790ebc5-9058-4dcb-8be0-5e3e85858738",
    patientId: "7698487b-a4f1-4b60-a477-8a721c4583d5",
    conversationId: "f165b7ef-d842-41e7-80d6-176dfc4cb7fb",
    messageId: "45ab619c-4d5e-42ca-b45b-d7935a3d46bd",
    occurredAt: "2026-07-13T15:00:00.000Z"
  }
} as const;

describe("SOFIA PULSO JetStream adapter", () => {
  it("maps accepted and duplicate database outcomes to ack", async () => {
    for (const status of ["accepted", "duplicate"] as const) {
      await expect(
        createPulsoMessageJetStreamHandler(database(), receiverReturning(status))(EVENT, context())
      ).resolves.toEqual({ action: "ack" });
    }
  });

  it("maps conflict or strict-envelope failure to term", async () => {
    await expect(
      createPulsoMessageJetStreamHandler(database(), receiverReturning("conflict"))(EVENT, context())
    ).resolves.toEqual({ action: "term" });
    await expect(
      createPulsoMessageJetStreamHandler(database(), receiverReturning("accepted"))(
        { ...EVENT, payload: { ...EVENT.payload, unexpected: true } },
        context()
      )
    ).resolves.toEqual({ action: "term" });
  });

  it("maps a transient persistence error to retry", async () => {
    const receive = vi.fn<PulsoMessageReceiver>(async () => Promise.reject(new Error("temporary database failure")));
    await expect(createPulsoMessageJetStreamHandler(database(), receive)(EVENT, context())).resolves.toEqual({
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

    await startPulsoMessageJetStreamConsumer(
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
        eventType: PULSO_MESSAGE_EVENT_TYPE,
        durableName: PULSO_MESSAGE_DURABLE_NAME,
        connectionName: "sofia-pulso-message",
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

function receiverReturning(status: "accepted" | "conflict" | "duplicate"): PulsoMessageReceiver {
  return vi.fn(async () =>
    status === "conflict"
      ? { status }
      : {
          status,
          jobId: "94f7d38e-a9b8-4861-8427-29abfe67b687"
        }
  );
}

function context() {
  return { subject: `hyperion.events.${PULSO_MESSAGE_EVENT_TYPE}`, deliveryCount: 1 } as const;
}
