import { describe, expect, it, vi } from "vitest";
import { CHANNEL_DELIVERY_EVENT_TYPE, PostgresChannelDeliveryOutbox } from "./channel-delivery-outbox.js";

describe("PostgresChannelDeliveryOutbox", () => {
  it("claims only ordered delivery projections for the PULSO event ingress", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "711d8ea7-8015-4ad5-8517-67805a141eb8",
          tenantId: "c34ef856-72aa-4639-bdb0-3dc78caabc76",
          eventType: CHANNEL_DELIVERY_EVENT_TYPE,
          eventVersion: 1,
          occurredAt: new Date("2026-07-14T00:00:00.000Z"),
          streamId: "6d89404b-9d1c-4e91-8780-1de98c98211a",
          streamSequence: "2",
          payload: { messageId: "6d89404b-9d1c-4e91-8780-1de98c98211a", outcome: "sent" }
        }
      ]
    });
    const outbox = new PostgresChannelDeliveryOutbox({ query } as never, "delivery-worker", "http://pulso:8088/");

    await expect(outbox.claim(100)).resolves.toEqual([
      expect.objectContaining({
        type: CHANNEL_DELIVERY_EVENT_TYPE,
        version: 1,
        streamSequence: 2,
        destination: "http://pulso:8088/internal/v1/events/channel-delivery"
      })
    ]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("predecessor.status <> 'published'"), [
      "delivery-worker",
      20,
      CHANNEL_DELIVERY_EVENT_TYPE
    ]);
  });

  it("scopes completion and retry updates to the delivery contract", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const outbox = new PostgresChannelDeliveryOutbox({ query } as never, "worker", "http://pulso");

    await outbox.complete("711d8ea7-8015-4ad5-8517-67805a141eb8");
    await outbox.fail("711d8ea7-8015-4ad5-8517-67805a141eb8", "HTTP 503");

    expect(query.mock.calls[0]?.[1]).toEqual([
      "711d8ea7-8015-4ad5-8517-67805a141eb8",
      "worker",
      CHANNEL_DELIVERY_EVENT_TYPE
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      "711d8ea7-8015-4ad5-8517-67805a141eb8",
      "worker",
      "http_503",
      CHANNEL_DELIVERY_EVENT_TYPE
    ]);
  });
});
