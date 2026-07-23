import { novaAuditEventRecordContract } from "@hyperion/nova-contracts";
import { HttpOutboxDispatcher } from "@hyperion/nova-durable-events";
import { describe, expect, it, vi } from "vitest";
import { insertNovaAuditOutboxEvent, PostgresNovaOutbox } from "./outbox.js";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = "33333333-3333-4333-8333-333333333333";

describe("PostgresNovaOutbox.fail", () => {
  it("inserts into nova.outbox_dlq when the event reaches the failed threshold", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const outbox = new PostgresNovaOutbox({ query } as never, "worker-test");

    await outbox.fail("11111111-1111-4111-8111-111111111111", "Dialer Timeout!");

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toMatch(/insert into nova\.outbox_dlq/i);
    expect(sql).toMatch(/attempt_count >= 8/i);
    expect(sql).toMatch(/where status = 'failed'/i);
    expect(params).toEqual(["11111111-1111-4111-8111-111111111111", "worker-test", "dialer_timeout_", false]);
  });
});

describe("PostgresNovaOutbox.claim", () => {
  it("reclaims an expired dispatching lease after a worker crash", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const outbox = new PostgresNovaOutbox({ query } as never, "replacement-worker");

    await outbox.claim(10);

    const [sql, params] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toMatch(/status = 'pending' and available_at <= now\(\)/i);
    expect(sql).toMatch(/status = 'dispatching' and locked_at < now\(\) - interval '2 minutes'/i);
    expect(sql).toMatch(/for update skip locked/i);
    expect(params).toEqual(["replacement-worker", 10]);
  });
});

describe("NOVA Audit outbox contract", () => {
  it("adds event-scoped headers without allowing them to replace transport credentials", async () => {
    const delivery = {
      id: EVENT_ID,
      tenantId: TENANT_ID,
      correlationId: CORRELATION_ID,
      type: "voice.call.requested",
      version: 1,
      occurredAt: "2026-07-17T12:00:00.000Z",
      payload: {},
      destination: "http://voice-channel-service:8092/v1/voice/internal/events"
    } as const;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const dispatcher = new HttpOutboxDispatcher<Record<string, unknown>>({
      workerId: "nova-event-assertion-test",
      internalToken: "nova-to-voice-test-token-0001",
      fetch,
      requestHeaders: (event) => ({
        authorization: "Bearer attacker-controlled",
        "x-hyperion-operator-assertion": `signed:${event.tenantId}`
      }),
      claim: async () => [delivery],
      complete: async () => undefined,
      fail: async () => undefined
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer nova-to-voice-test-token-0001");
    expect(headers.get("x-hyperion-operator-assertion")).toBe(`signed:${TENANT_ID}`);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      id: EVENT_ID,
      correlationId: CORRELATION_ID,
      type: "voice.call.requested"
    });
  });

  it("persists a provider-owned audit envelope instead of a raw domain event", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));

    await insertNovaAuditOutboxEvent({ query } as never, {
      eventId: EVENT_ID,
      tenantId: TENANT_ID,
      correlationId: CORRELATION_ID,
      businessIdempotencyKey: `contact-import:${TENANT_ID}:contact-1`,
      domainEventType: "contact.imported",
      entityType: "contact",
      entityId: "44444444-4444-4444-8444-444444444444",
      payload: { contact_id: "44444444-4444-4444-8444-444444444444", phone_e164: "+573001112233" },
      destination: "http://audit-service:8086/internal/v1/events"
    });

    const [sql, params] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toMatch(/insert into nova\.outbox_events/i);
    expect(params[0]).toBe(EVENT_ID);
    expect(params[1]).toBe(novaAuditEventRecordContract.eventType);
    expect(params[2]).toBe(TENANT_ID);
    expect(params[3]).toBe(CORRELATION_ID);
    expect(JSON.parse(String(params[6]))).toEqual({
      tenantId: TENANT_ID,
      actorId: "nova-core-service",
      eventType: "contact.imported",
      entityType: "contact",
      entityId: "44444444-4444-4444-8444-444444444444",
      metadata: {
        correlationId: CORRELATION_ID,
        businessIdempotencyKey: `contact-import:${TENANT_ID}:contact-1`,
        domainPayload: {
          contact_id: "44444444-4444-4444-8444-444444444444",
          phone_e164: "+573001112233"
        }
      }
    });
  });

  it("claims the stable Audit event id unchanged for idempotent redelivery", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          eventId: EVENT_ID,
          tenantId: TENANT_ID,
          correlationId: CORRELATION_ID,
          eventType: novaAuditEventRecordContract.eventType,
          payload: {
            tenantId: TENANT_ID,
            actorId: "nova-core-service",
            eventType: "contact.imported",
            entityType: "contact",
            metadata: {}
          },
          destination: "http://audit-service:8086/internal/v1/events",
          createdAt: new Date("2026-07-17T12:00:00.000Z")
        }
      ],
      rowCount: 1
    }));
    const outbox = new PostgresNovaOutbox({ query } as never, "nova-worker-test");

    const [delivery] = await outbox.claim(10);

    expect(delivery).toMatchObject({
      id: EVENT_ID,
      type: novaAuditEventRecordContract.eventType,
      tenantId: TENANT_ID,
      version: 1
    });
    expect(delivery).not.toHaveProperty("correlationId");
  });

  it("keeps correlationId on voice deliveries while omitting it from the Audit wire contract", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          eventId: EVENT_ID,
          tenantId: TENANT_ID,
          correlationId: CORRELATION_ID,
          eventType: "voice.call.requested.v2",
          payload: { call_id: "44444444-4444-4444-8444-444444444444" },
          destination: "http://voice-channel-service:8092/v1/voice/internal/events",
          createdAt: new Date("2026-07-17T12:00:00.000Z")
        }
      ],
      rowCount: 1
    }));
    const outbox = new PostgresNovaOutbox({ query } as never, "nova-worker-test");

    await expect(outbox.claim(10)).resolves.toEqual([
      expect.objectContaining({
        id: EVENT_ID,
        type: "voice.call.requested.v2",
        tenantId: TENANT_ID,
        correlationId: CORRELATION_ID,
        version: 1
      })
    ]);
  });

  it("redelivers the same logical event after Audit recovers", async () => {
    const delivery = {
      id: EVENT_ID,
      tenantId: TENANT_ID,
      type: novaAuditEventRecordContract.eventType,
      version: 1,
      occurredAt: "2026-07-17T12:00:00.000Z",
      payload: {
        tenantId: TENANT_ID,
        actorId: "nova-core-service",
        eventType: "contact.imported",
        entityType: "contact",
        metadata: { businessIdempotencyKey: `contact-import:${TENANT_ID}:contact-1` }
      },
      destination: "http://audit-service:8086/internal/v1/events"
    } as const;
    let status: "pending" | "dispatching" | "completed" = "pending";
    const failures: Array<{ eventId: string; errorCode: string }> = [];
    const completed: string[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("Audit unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const dispatcher = new HttpOutboxDispatcher<Record<string, unknown>>({
      workerId: "nova-audit-outbox-test",
      internalToken: "nova-to-audit-test-token-0001",
      fetch,
      claim: async () => {
        if (status !== "pending") return [];
        status = "dispatching";
        return [delivery];
      },
      complete: async (eventId) => {
        completed.push(eventId);
        status = "completed";
      },
      fail: async (eventId, errorCode) => {
        failures.push({ eventId, errorCode });
        status = "pending";
      }
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, failed: 1, completed: 0 });
    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, failed: 0, completed: 1 });

    expect(failures).toEqual([{ eventId: EVENT_ID, errorCode: "network_error" }]);
    expect(completed).toEqual([EVENT_ID]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    const secondBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(firstBody).toEqual(secondBody);
    expect(secondBody).toMatchObject({ id: EVENT_ID, type: novaAuditEventRecordContract.eventType });
  });
});
