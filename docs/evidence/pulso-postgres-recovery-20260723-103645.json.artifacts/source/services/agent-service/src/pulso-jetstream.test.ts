import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import type { LegacyPulsoPositionResolver, PulsoEventPosition } from "./pulso-position-client.js";
import {
  LEGACY_PULSO_MESSAGE_DURABLE_NAME,
  LEGACY_PULSO_MESSAGE_EVENT_TYPE,
  PULSO_MESSAGE_DURABLE_NAME,
  PULSO_MESSAGE_EVENT_TYPE,
  createPulsoMessageJetStreamHandler,
  startPulsoMessageJetStreamConsumers,
  type ManagedJetStreamConsumerFactory,
  type PulsoMessageReceiver
} from "./pulso-jetstream.js";

const POSITION: PulsoEventPosition = {
  streamId: "f165b7ef-d842-41e7-80d6-176dfc4cb7fb",
  streamSequence: 1,
  sourceStreamId: "0790ebc5-9058-4dcb-8be0-5e3e85858738",
  sourceStreamSequence: 4
};

const V2_EVENT = {
  id: "a56e320f-cbce-4e96-b7fc-c79e52970a52",
  type: PULSO_MESSAGE_EVENT_TYPE,
  version: 2,
  occurredAt: "2026-07-13T15:00:00.000Z",
  tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
  streamId: POSITION.streamId,
  streamSequence: POSITION.streamSequence,
  payload: {
    inboundEventId: "2b7f8da4-74dc-487b-9cd9-d8d45eb8f99f",
    threadBindingId: POSITION.sourceStreamId,
    patientId: "7698487b-a4f1-4b60-a477-8a721c4583d5",
    conversationId: POSITION.streamId,
    messageId: "45ab619c-4d5e-42ca-b45b-d7935a3d46bd",
    occurredAt: "2026-07-13T15:00:00.000Z",
    sourceStreamId: POSITION.sourceStreamId,
    sourceStreamSequence: POSITION.sourceStreamSequence
  }
} as const;

const V1_EVENT = {
  id: V2_EVENT.id,
  type: LEGACY_PULSO_MESSAGE_EVENT_TYPE,
  version: 1,
  occurredAt: V2_EVENT.occurredAt,
  tenantId: V2_EVENT.tenantId,
  payload: {
    inboundEventId: V2_EVENT.payload.inboundEventId,
    threadBindingId: V2_EVENT.payload.threadBindingId,
    patientId: V2_EVENT.payload.patientId,
    conversationId: V2_EVENT.payload.conversationId,
    messageId: V2_EVENT.payload.messageId,
    occurredAt: V2_EVENT.payload.occurredAt
  }
} as const;

describe("SOFIA PULSO JetStream adapter", () => {
  it("acks accepted and duplicate v2 events and retries a detected gap", async () => {
    for (const status of ["accepted", "duplicate"] as const) {
      await expect(
        createPulsoMessageJetStreamHandler(database(), receiverReturning(status))(V2_EVENT, context(V2_EVENT.type))
      ).resolves.toEqual({ action: "ack" });
    }
    await expect(
      createPulsoMessageJetStreamHandler(database(), receiverReturning("gap"))(V2_EVENT, context(V2_EVENT.type))
    ).resolves.toEqual({ action: "retry" });
  });

  it("terminates a conflict or a payload that violates its durable contract", async () => {
    await expect(
      createPulsoMessageJetStreamHandler(database(), receiverReturning("conflict"))(V2_EVENT, context(V2_EVENT.type))
    ).resolves.toEqual({ action: "term" });
    await expect(
      createPulsoMessageJetStreamHandler(database(), receiverReturning("accepted"))(
        { ...V2_EVENT, payload: { ...V2_EVENT.payload, unexpected: true } },
        context(V2_EVENT.type)
      )
    ).resolves.toEqual({ action: "term" });
  });

  it("keeps v1 on its own durable and resolves the producer position before persistence", async () => {
    const db = database();
    const resolveLegacyPosition = vi.fn<LegacyPulsoPositionResolver>(async () => POSITION);
    const receive = receiverReturning("accepted");

    await expect(createPulsoMessageJetStreamHandler(db, receive)(V1_EVENT, context(V1_EVENT.type))).resolves.toEqual({
      action: "term"
    });
    await expect(
      createPulsoMessageJetStreamHandler(db, receive, {
        legacyV1: true,
        resolveLegacyPosition
      })(V1_EVENT, context(V1_EVENT.type))
    ).resolves.toEqual({ action: "ack" });

    expect(resolveLegacyPosition).toHaveBeenCalledWith(V1_EVENT);
    expect(receive).toHaveBeenLastCalledWith(db, expect.objectContaining({ type: V1_EVENT.type }), POSITION);
  });

  it("retries lookup and persistence failures without inventing a v1 sequence", async () => {
    const unavailableResolver = vi.fn<LegacyPulsoPositionResolver>(async () => {
      throw new Error("owner unavailable");
    });
    await expect(
      createPulsoMessageJetStreamHandler(database(), receiverReturning("accepted"), {
        legacyV1: true,
        resolveLegacyPosition: unavailableResolver
      })(V1_EVENT, context(V1_EVENT.type))
    ).resolves.toEqual({ action: "retry" });

    const receive = vi.fn<PulsoMessageReceiver>(async () => Promise.reject(new Error("temporary database failure")));
    await expect(
      createPulsoMessageJetStreamHandler(database(), receive)(V2_EVENT, context(V2_EVENT.type))
    ).resolves.toEqual({ action: "retry" });
  });

  it("starts v2 alone by default with fixed topology", async () => {
    const fixture = consumerFixture();
    const consumers = await startPulsoMessageJetStreamConsumers(
      database(),
      { natsUrl: "nats://nats:4222", authToken: "controlled-token" },
      fixture.factory
    );

    expect(consumers).toHaveLength(1);
    expect(fixture.definitions).toEqual([
      expect.objectContaining({
        eventType: PULSO_MESSAGE_EVENT_TYPE,
        durableName: PULSO_MESSAGE_DURABLE_NAME,
        connectionName: "sofia-pulso-message-v2",
        provisionTopology: false
      })
    ]);
    expect(fixture.initialize).toHaveBeenCalledOnce();
    expect(fixture.start).toHaveBeenCalledOnce();
    await Promise.all(consumers.map((consumer) => consumer.stop()));
    expect(fixture.stop).toHaveBeenCalledOnce();
  });

  it("runs separate v1 and v2 durables only during the explicit compatibility window", async () => {
    const fixture = consumerFixture();
    const resolveLegacyPosition = vi.fn<LegacyPulsoPositionResolver>(async () => POSITION);
    const consumers = await startPulsoMessageJetStreamConsumers(
      database(),
      {
        natsUrl: "nats://nats:4222",
        authToken: "controlled-token",
        allowLegacyV1: true,
        resolveLegacyPosition
      },
      fixture.factory
    );

    expect(consumers).toHaveLength(2);
    expect(fixture.definitions.map(({ eventType, durableName }) => ({ eventType, durableName }))).toEqual([
      { eventType: PULSO_MESSAGE_EVENT_TYPE, durableName: PULSO_MESSAGE_DURABLE_NAME },
      { eventType: LEGACY_PULSO_MESSAGE_EVENT_TYPE, durableName: LEGACY_PULSO_MESSAGE_DURABLE_NAME }
    ]);
    expect(fixture.initialize).toHaveBeenCalledTimes(2);
    expect(fixture.start).toHaveBeenCalledTimes(2);
    await Promise.all(consumers.map((consumer) => consumer.stop()));
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });

  it("fails startup when v1 is enabled without the owner position resolver", async () => {
    await expect(
      startPulsoMessageJetStreamConsumers(
        database(),
        { natsUrl: "nats://nats:4222", authToken: "controlled-token", allowLegacyV1: true },
        consumerFixture().factory
      )
    ).rejects.toThrow("owner position resolver");
  });

  it("closes every constructed consumer when initialization fails", async () => {
    const fixture = consumerFixture();
    fixture.initialize.mockRejectedValueOnce(new Error("controlled initialization failure"));

    await expect(
      startPulsoMessageJetStreamConsumers(
        database(),
        { natsUrl: "nats://nats:4222", authToken: "controlled-token" },
        fixture.factory
      )
    ).rejects.toThrow("controlled initialization failure");

    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.stop).toHaveBeenCalledOnce();
  });
});

function database(): DatabaseClient {
  return {} as DatabaseClient;
}

function receiverReturning(status: "accepted" | "conflict" | "duplicate" | "gap"): PulsoMessageReceiver {
  return vi.fn(async (_db, event) => {
    if (status === "conflict") return { status };
    if (status === "gap") {
      return {
        status,
        streamId: event.payload.conversationId,
        expectedSequence: 1,
        receivedSequence: 2
      };
    }
    return { status, jobId: "94f7d38e-a9b8-4861-8427-29abfe67b687" };
  });
}

function context(eventType: string) {
  return { subject: `hyperion.events.${eventType}`, deliveryCount: 1 } as const;
}

function consumerFixture() {
  const initialize = vi.fn(async () => undefined);
  const checkReadiness = vi.fn(async () => undefined);
  const start = vi.fn();
  const stop = vi.fn(async () => undefined);
  const definitions: Array<Parameters<ManagedJetStreamConsumerFactory>[0]> = [];
  const fixture: {
    definitions: typeof definitions;
    initialize: typeof initialize;
    start: typeof start;
    stop: typeof stop;
    factory: ManagedJetStreamConsumerFactory;
  } = {
    definitions,
    initialize,
    start,
    stop,
    factory: (options) => {
      definitions.push(options);
      return { initialize, checkReadiness, start, stop };
    }
  };
  return fixture;
}
