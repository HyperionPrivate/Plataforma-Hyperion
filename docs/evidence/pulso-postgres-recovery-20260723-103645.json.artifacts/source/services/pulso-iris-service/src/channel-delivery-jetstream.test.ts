import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_DELIVERY_DURABLE_NAME,
  createChannelDeliveryJetStreamHandler,
  startChannelDeliveryJetStreamConsumer
} from "./channel-delivery-jetstream.js";
import { CHANNEL_DELIVERY_EVENT_TYPE } from "./channel-delivery-events.js";

const event = {
  id: "e8eddf07-f9a0-4429-a1d2-0da2f7503c6c",
  type: CHANNEL_DELIVERY_EVENT_TYPE,
  version: 1,
  occurredAt: "2026-07-14T00:00:00.000Z",
  tenantId: "c34ef856-72aa-4639-bdb0-3dc78caabc76",
  streamId: "6d89404b-9d1c-4e91-8780-1de98c98211a",
  streamSequence: 1,
  payload: { messageId: "6d89404b-9d1c-4e91-8780-1de98c98211a", outcome: "failed" }
};

describe("Channel delivery JetStream consumer", () => {
  it("ACKs accepted/replayed events, retries gaps or missing targets and terminates conflicts", async () => {
    const receive = vi
      .fn()
      .mockResolvedValueOnce({ status: "accepted", result: { messageId: event.payload.messageId, updated: true } })
      .mockResolvedValueOnce({ status: "gap" })
      .mockResolvedValueOnce({ status: "retryable", reason: "target_not_found" })
      .mockResolvedValueOnce({ status: "conflict" });
    const handler = createChannelDeliveryJetStreamHandler({} as never, receive as never);

    const context = { subject: `hyperion.events.${CHANNEL_DELIVERY_EVENT_TYPE}`, deliveryCount: 1 };
    await expect(handler(event as never, context)).resolves.toEqual({ action: "ack" });
    await expect(handler(event as never, context)).resolves.toEqual({ action: "retry" });
    await expect(handler(event as never, context)).resolves.toEqual({ action: "retry" });
    await expect(handler(event as never, context)).resolves.toEqual({ action: "term" });
    await expect(handler({ ...event, streamId: crypto.randomUUID() } as never, context)).resolves.toEqual({
      action: "term"
    });
  });

  it("uses the provisioned durable without allowing runtime topology mutation", async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn();
    const stop = vi.fn().mockResolvedValue(undefined);
    const checkReadiness = vi.fn().mockResolvedValue(undefined);
    let options: Record<string, unknown> | undefined;
    let closeHook: (() => Promise<void>) | undefined;

    const managed = await startChannelDeliveryJetStreamConsumer(
      (hook) => {
        closeHook = hook;
      },
      {} as never,
      { natsUrl: "nats://nats:4222", username: "pulso", password: "x".repeat(32) },
      ((input: Record<string, unknown>) => {
        options = input;
        return { initialize, start, stop, checkReadiness };
      }) as never
    );

    expect(options).toMatchObject({
      eventType: CHANNEL_DELIVERY_EVENT_TYPE,
      durableName: CHANNEL_DELIVERY_DURABLE_NAME,
      provisionTopology: false
    });
    expect(initialize).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    await managed.checkReadiness();
    await closeHook?.();
    expect(stop).toHaveBeenCalledOnce();
  });
});
