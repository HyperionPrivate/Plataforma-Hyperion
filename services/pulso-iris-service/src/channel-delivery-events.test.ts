import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_DELIVERY_EVENT_TYPE,
  channelDeliveryEventSchema,
  receiveChannelDeliveryEvent
} from "./channel-delivery-events.js";

const event = {
  id: "e8eddf07-f9a0-4429-a1d2-0da2f7503c6c",
  type: CHANNEL_DELIVERY_EVENT_TYPE,
  version: 1 as const,
  occurredAt: "2026-07-14T00:00:00.000Z",
  tenantId: "c34ef856-72aa-4639-bdb0-3dc78caabc76",
  streamId: "6d89404b-9d1c-4e91-8780-1de98c98211a",
  streamSequence: 1,
  payload: {
    messageId: "6d89404b-9d1c-4e91-8780-1de98c98211a",
    outcome: "sent" as const,
    provider: "whatsapp_web_test" as const,
    providerMessageId: "provider-1"
  }
};

describe("Channel delivery events", () => {
  it("requires the stream identity to be the PULSO message", () => {
    expect(channelDeliveryEventSchema.safeParse(event).success).toBe(true);
    expect(channelDeliveryEventSchema.safeParse({ ...event, streamId: crypto.randomUUID() }).success).toBe(false);
  });

  it("requires uncertain provider identity fields to be supplied together", () => {
    const uncertain = {
      ...event,
      payload: {
        messageId: event.payload.messageId,
        outcome: "uncertain" as const,
        providerMessageId: "provider-1"
      }
    };
    expect(channelDeliveryEventSchema.safeParse(uncertain).success).toBe(false);
    expect(
      channelDeliveryEventSchema.safeParse({
        ...uncertain,
        payload: { ...uncertain.payload, provider: "whatsapp_web_test" }
      }).success
    ).toBe(true);
  });

  it("applies the projection and inbox result in one transaction", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes("returning event_id")) return { rows: [{ eventId: event.id }], rowCount: 1 };
      if (sql.includes('as "lastSequence"')) return { rows: [{ lastSequence: "0" }], rowCount: 1 };
      if (sql.includes("update pulso_iris.messages")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const db = {
      query,
      close: async () => undefined,
      transaction: async <T>(work: (executor: { query: typeof query }) => Promise<T>) => work({ query })
    };

    await expect(receiveChannelDeliveryEvent(db as never, event)).resolves.toEqual({
      status: "accepted",
      result: { messageId: event.payload.messageId, updated: true }
    });
    expect(calls.findIndex((sql) => sql.includes("update pulso_iris.messages"))).toBeLessThan(
      calls.findIndex((sql) => sql.includes("set processed_at"))
    );
  });

  it("reports a gap without applying the PULSO projection", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("returning event_id")) return { rows: [{ eventId: event.id }], rowCount: 1 };
      if (sql.includes('as "lastSequence"')) return { rows: [{ lastSequence: "0" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const db = {
      query,
      close: async () => undefined,
      transaction: async <T>(work: (executor: { query: typeof query }) => Promise<T>) => work({ query })
    };

    await expect(receiveChannelDeliveryEvent(db as never, { ...event, streamSequence: 2 })).resolves.toMatchObject({
      status: "gap",
      expectedSequence: 1,
      receivedSequence: 2
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("update pulso_iris.messages"))).toBe(false);
  });

  it("reports a missing target as retryable without completing the inbox row", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("returning event_id")) return { rows: [{ eventId: event.id }], rowCount: 1 };
      if (sql.includes('as "lastSequence"')) return { rows: [{ lastSequence: "0" }], rowCount: 1 };
      if (sql.includes("update pulso_iris.messages")) return { rows: [], rowCount: 0 };
      if (sql.includes("select exists(")) return { rows: [{ exists: false }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const db = {
      query,
      close: async () => undefined,
      transaction: async <T>(work: (executor: { query: typeof query }) => Promise<T>) => work({ query })
    };

    await expect(receiveChannelDeliveryEvent(db as never, event)).resolves.toEqual({
      status: "retryable",
      eventId: event.id,
      reason: "target_not_found"
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("set processed_at"))).toBe(false);
  });

  it("reports a provider identity mismatch as a conflict without completing the inbox row", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("returning event_id")) return { rows: [{ eventId: event.id }], rowCount: 1 };
      if (sql.includes('as "lastSequence"')) return { rows: [{ lastSequence: "0" }], rowCount: 1 };
      if (sql.includes("update pulso_iris.messages")) return { rows: [], rowCount: 0 };
      if (sql.includes("select exists(")) return { rows: [{ exists: true }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const db = {
      query,
      close: async () => undefined,
      transaction: async <T>(work: (executor: { query: typeof query }) => Promise<T>) => work({ query })
    };

    await expect(receiveChannelDeliveryEvent(db as never, event)).resolves.toEqual({
      status: "conflict",
      eventId: event.id
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("set processed_at"))).toBe(false);
  });
});
