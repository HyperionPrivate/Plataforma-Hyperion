import type { DatabaseClient } from "@hyperion/database";
import { HttpOutboxDispatcher } from "@hyperion/durable-events";
import { describe, expect, it, vi } from "vitest";
import { CHANNEL_AUDIT_EVENT_TYPE, PostgresChannelAuditOutbox } from "./channel-audit-outbox.js";

describe("PostgresChannelAuditOutbox", () => {
  it("claims channel.message.sent audit rows toward Audit", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          tenantId: "22222222-2222-4222-8222-222222222222",
          eventType: CHANNEL_AUDIT_EVENT_TYPE,
          eventVersion: 1,
          occurredAt: new Date("2026-07-13T15:00:00.000Z"),
          payload: { eventType: "channel.message.sent" }
        }
      ]
    });
    const outbox = new PostgresChannelAuditOutbox(database(query), "channel-audit-worker", "http://audit:8086/");
    await expect(outbox.claim(5)).resolves.toEqual([
      expect.objectContaining({
        destination: "http://audit:8086/internal/v1/events",
        type: CHANNEL_AUDIT_EVENT_TYPE
      })
    ]);
  });

  it("retries while Audit is down and stays idempotent for the consumer", async () => {
    const eventId = "11111111-1111-4111-8111-111111111111";
    let status: "queued" | "processing" | "retry_scheduled" | "published" = "queued";
    let auditAvailable = false;
    const accepted = new Set<string>();

    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, " ").toLowerCase();
      if (normalized.includes("from candidates where event.id = candidates.id")) {
        if (status !== "queued" && status !== "retry_scheduled") return { rows: [] };
        status = "processing";
        return {
          rows: [
            {
              id: eventId,
              tenantId: "22222222-2222-4222-8222-222222222222",
              eventType: CHANNEL_AUDIT_EVENT_TYPE,
              eventVersion: 1,
              occurredAt: new Date("2026-07-13T15:00:00.000Z"),
              payload: { eventType: "channel.message.sent" }
            }
          ]
        };
      }
      if (normalized.includes("status = 'published'")) {
        status = "published";
        return { rows: [] };
      }
      if (normalized.includes("retry_scheduled")) {
        status = "retry_scheduled";
        return { rows: [] };
      }
      return { rows: [] };
    });

    const outbox = new PostgresChannelAuditOutbox(database(query), "channel-audit-worker", "http://audit.test");
    const dispatcher = new HttpOutboxDispatcher({
      workerId: "channel-audit-worker",
      internalToken: "token",
      fetch: (async (_url: unknown, init?: RequestInit) => {
        if (!auditAvailable) return new Response(null, { status: 503 });
        const body = JSON.parse(String(init?.body)) as { id: string };
        const duplicate = accepted.has(body.id);
        accepted.add(body.id);
        return new Response(null, { status: duplicate ? 200 : 201 });
      }) as unknown as typeof fetch,
      claim: (limit) => outbox.claim(limit),
      complete: (id) => outbox.complete(id),
      fail: (id, code) => outbox.fail(id, code),
      batchSize: 1,
      intervalMs: 60_000,
      timeoutMs: 500
    });

    expect(await dispatcher.drainOnce()).toMatchObject({ failed: 1 });
    expect(status).toBe("retry_scheduled");
    expect(accepted.size).toBe(0);

    auditAvailable = true;
    status = "queued";
    expect(await dispatcher.drainOnce()).toMatchObject({ completed: 1 });
    expect(accepted.size).toBe(1);

    status = "queued";
    expect(await dispatcher.drainOnce()).toMatchObject({ completed: 1 });
    expect(accepted.size).toBe(1);
  });
});

function database(query: ReturnType<typeof vi.fn>): DatabaseClient {
  return { query } as unknown as DatabaseClient;
}
