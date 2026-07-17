import { describe, expect, it, vi } from "vitest";
import { createLegacyChannelPositionResolver } from "./channel-position-client.js";
import type { LegacyChannelInboundEvent } from "./channel-inbound-events.js";

const EVENT: LegacyChannelInboundEvent = {
  id: "10000000-0000-4000-8000-000000000001",
  type: "channel.inbound.received.v1",
  version: 1,
  occurredAt: "2026-07-13T16:30:00.000Z",
  tenantId: "20000000-0000-4000-8000-000000000001",
  payload: {
    inboundEventId: "30000000-0000-4000-8000-000000000001",
    threadBindingId: "40000000-0000-4000-8000-000000000001",
    provider: "whatsapp_web_test",
    externalThreadId: "thread-1",
    externalMessageId: "message-1",
    phoneHash: "a".repeat(64),
    phoneMasked: "***1234",
    body: "hola",
    receivedAt: "2026-07-13T16:29:59.000Z"
  }
};

describe("Channel owner position lookup", () => {
  it("uses the dedicated PULSO workload identity and validates the owner response", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: {
          tenantId: EVENT.tenantId,
          eventId: EVENT.payload.inboundEventId,
          streamId: EVENT.payload.threadBindingId,
          streamSequence: 7
        },
        meta: { generatedAt: "2026-07-13T16:31:00.000Z" }
      })
    );
    const resolve = createLegacyChannelPositionResolver({
      channelServiceUrl: "http://channel:8089/",
      credential: "pulso-to-channel-test-token",
      fetch: request
    });

    await expect(resolve(EVENT)).resolves.toEqual({
      streamId: EVENT.payload.threadBindingId,
      streamSequence: 7
    });
    const [url, init] = request.mock.calls[0]!;
    expect(String(url)).toContain(`/channel-inbound/${EVENT.payload.inboundEventId}/stream-position`);
    expect(init?.headers).toMatchObject({
      authorization: "Bearer pulso-to-channel-test-token",
      "x-hyperion-caller": "pulso-iris-service"
    });
  });

  it("fails closed when the owner response is missing or belongs to another stream", async () => {
    const missing = createLegacyChannelPositionResolver({
      channelServiceUrl: "http://channel:8089",
      credential: "pulso-to-channel-test-token",
      fetch: async () => new Response(null, { status: 404 })
    });
    const conflicting = createLegacyChannelPositionResolver({
      channelServiceUrl: "http://channel:8089",
      credential: "pulso-to-channel-test-token",
      fetch: async () =>
        jsonResponse({
          data: {
            tenantId: EVENT.tenantId,
            eventId: EVENT.payload.inboundEventId,
            streamId: "40000000-0000-4000-8000-000000000099",
            streamSequence: 7
          },
          meta: { generatedAt: "2026-07-13T16:31:00.000Z" }
        })
    });

    await expect(missing(EVENT)).rejects.toThrow("status 404");
    await expect(conflicting(EVENT)).rejects.toThrow("conflicts");
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
