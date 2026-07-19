import { describe, expect, it, vi } from "vitest";
import { acceptNovaInboxEvent } from "./routes.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = "33333333-3333-4333-8333-333333333333";
const event = {
  event_id: EVENT_ID,
  event_type: "provider.test.event",
  tenant_id: TENANT_ID,
  correlation_id: CORRELATION_ID,
  business_idempotency_key: "provider-test-1",
  payload: { result: "ok" }
} as never;
const serviceUrls = {
  audit: "http://audit-service:8086",
  novaCore: "http://nova-core-service:8091",
  voiceChannel: "http://voice-channel-service:8092",
  liwaChannel: "http://liwa-channel-service:8093",
  documents: "http://documents-service:8094"
};

function databaseWith(txQuery: ReturnType<typeof vi.fn>) {
  const transaction = vi.fn(async (work) => work({ query: txQuery }));
  return { db: { transaction } as never, transaction };
}

describe("NOVA provider inbox", () => {
  it("persists, applies and marks a new event in one transaction", async () => {
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ eventId: EVENT_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const { db, transaction } = databaseWith(txQuery);

    await expect(acceptNovaInboxEvent(db, event, serviceUrls)).resolves.toBe("accepted");
    expect(transaction).toHaveBeenCalledOnce();
    expect(String(txQuery.mock.calls[0]?.[0])).toMatch(/on conflict do nothing[\s\S]*returning event_id/i);
    expect(String(txQuery.mock.calls[1]?.[0])).toMatch(/set processed_at = now\(\)/i);
  });

  it("does not repeat an already processed logical event", async () => {
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ eventId: EVENT_ID, identityMatches: true, processedAt: new Date() }],
        rowCount: 1
      });
    const { db } = databaseWith(txQuery);

    await expect(acceptNovaInboxEvent(db, event, serviceUrls)).resolves.toBe("duplicate");
    expect(txQuery).toHaveBeenCalledTimes(2);
  });

  it("recovers a historical unprocessed receipt instead of treating it as completed", async () => {
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ eventId: EVENT_ID, identityMatches: true, processedAt: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const { db } = databaseWith(txQuery);

    await expect(acceptNovaInboxEvent(db, event, serviceUrls)).resolves.toBe("accepted");
    expect(String(txQuery.mock.calls[2]?.[0])).toMatch(/set processed_at = now\(\)/i);
  });

  it("rejects reuse of an event id or business key for different content", async () => {
    const txQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [{ eventId: EVENT_ID, identityMatches: false, processedAt: new Date() }],
        rowCount: 1
      });
    const { db } = databaseWith(txQuery);

    await expect(acceptNovaInboxEvent(db, event, serviceUrls)).rejects.toThrow("nova_inbox_event_conflict");
  });
});
