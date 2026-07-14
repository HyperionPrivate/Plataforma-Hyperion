import type { DatabaseClient } from "@hyperion/database";
import { HttpOutboxDispatcher } from "@hyperion/durable-events";
import { describe, expect, it, vi } from "vitest";
import { PULSO_AUDIT_EVENT_TYPE } from "./audit-client.js";
import { PostgresPulsoAuditOutbox } from "./pulso-audit-outbox.js";

describe("PostgresPulsoAuditOutbox", () => {
  it("claims audit rows toward the internal Audit destination", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "c1d91672-5d10-4bdc-a887-a07645a28e90",
          tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
          eventType: PULSO_AUDIT_EVENT_TYPE,
          eventVersion: 1,
          occurredAt: new Date("2026-07-13T15:00:00.000Z"),
          payload: { eventType: "appointment.cancelled" }
        }
      ]
    });
    const outbox = new PostgresPulsoAuditOutbox(database(query), "pulso-audit-worker", "http://audit:8086/");

    await expect(outbox.claim(999)).resolves.toEqual([
      expect.objectContaining({
        id: "c1d91672-5d10-4bdc-a887-a07645a28e90",
        destination: "http://audit:8086/internal/v1/events",
        type: PULSO_AUDIT_EVENT_TYPE
      })
    ]);
    expect(query.mock.calls[0]![1]).toEqual(["pulso-audit-worker", 20, PULSO_AUDIT_EVENT_TYPE]);
  });

  it("keeps events in outbox while Audit is down and delivers later without duplicate side effects", async () => {
    const eventId = "c1d91672-5d10-4bdc-a887-a07645a28e90";
    const deliveries: string[] = [];
    let auditAvailable = false;
    let status: "queued" | "processing" | "retry_scheduled" | "published" = "queued";
    let attemptCount = 0;

    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").toLowerCase();
      if (normalized.includes("from candidates where event.id = candidates.id")) {
        if (status !== "queued" && status !== "retry_scheduled") return { rows: [] };
        status = "processing";
        attemptCount += 1;
        return {
          rows: [
            {
              id: eventId,
              tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
              eventType: PULSO_AUDIT_EVENT_TYPE,
              eventVersion: 1,
              occurredAt: new Date("2026-07-13T15:00:00.000Z"),
              payload: { eventType: "appointment.cancelled" }
            }
          ]
        };
      }
      if (normalized.includes("status = 'published'")) {
        expect(params?.[0]).toBe(eventId);
        status = "published";
        return { rows: [] };
      }
      if (normalized.includes("retry_scheduled")) {
        expect(params?.[0]).toBe(eventId);
        status = "retry_scheduled";
        return { rows: [] };
      }
      return { rows: [] };
    });

    const outbox = new PostgresPulsoAuditOutbox(database(query), "pulso-audit-worker", "http://audit.test");
    const acceptedIds = new Set<string>();
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (!auditAvailable) return new Response(null, { status: 503 });
      const body = JSON.parse(String(init?.body)) as { id: string };
      const duplicate = acceptedIds.has(body.id);
      acceptedIds.add(body.id);
      deliveries.push(body.id);
      return new Response(JSON.stringify({ status: duplicate ? "duplicate" : "accepted" }), {
        status: duplicate ? 200 : 201
      });
    });

    const dispatcher = new HttpOutboxDispatcher({
      workerId: "pulso-audit-worker",
      internalToken: "token",
      fetch: fetchImpl as unknown as typeof fetch,
      claim: (limit) => outbox.claim(limit),
      complete: (id) => outbox.complete(id),
      fail: (id, code) => outbox.fail(id, code),
      batchSize: 1,
      intervalMs: 60_000,
      timeoutMs: 500
    });

    expect(await dispatcher.drainOnce()).toMatchObject({ failed: 1, completed: 0 });
    expect(status).toBe("retry_scheduled");
    expect(deliveries).toEqual([]);

    auditAvailable = true;
    status = "queued";
    expect(await dispatcher.drainOnce()).toMatchObject({ completed: 1, failed: 0 });
    expect(status).toBe("published");
    expect(deliveries).toEqual([eventId]);

    status = "queued";
    expect(await dispatcher.drainOnce()).toMatchObject({ completed: 1, failed: 0 });
    expect(deliveries).toEqual([eventId, eventId]);
    expect(acceptedIds.size).toBe(1);
    expect(attemptCount).toBeGreaterThanOrEqual(3);
  });
});

function database(query: ReturnType<typeof vi.fn>): DatabaseClient {
  return { query } as unknown as DatabaseClient;
}
