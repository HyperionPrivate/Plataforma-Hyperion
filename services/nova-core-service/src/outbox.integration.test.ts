import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase, type DatabaseClient } from "@hyperion/database";
import { novaAuditEventRecordContract } from "@hyperion/nova-contracts";
import { HttpOutboxDispatcher } from "@hyperion/nova-durable-events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertNovaAuditOutboxEvent, PostgresNovaOutbox } from "./outbox.js";

const TEST_NOVA_DATABASE_URL = process.env.TEST_NOVA_DATABASE_URL?.trim();
const describeIntegration = TEST_NOVA_DATABASE_URL ? describe : describe.skip;
const AUDIT_DESTINATION = "https://audit.test.invalid/internal/v1/events";

interface PersistedOutboxState {
  eventId: string;
  eventType: string;
  status: "pending" | "dispatching" | "completed" | "failed";
  attemptCount: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  payload: Record<string, unknown>;
}

describeIntegration("NOVA Audit outbox PostgreSQL recovery", () => {
  let db: DatabaseClient | undefined;
  const eventIds: string[] = [];

  beforeAll(async () => {
    db = createDatabase(TEST_NOVA_DATABASE_URL ?? "");
    const identity = await db.query<{ currentUser: string }>(`select current_user as "currentUser"`);
    expect(identity.rows[0]?.currentUser).toBe("hyperion_nova");
  });

  afterAll(async () => {
    if (!db) return;
    try {
      for (const eventId of eventIds) {
        await db.query("delete from nova.outbox_dlq where event_id = $1", [eventId]);
        await db.query("delete from nova.outbox_events where event_id = $1", [eventId]);
      }
    } finally {
      await db.close();
    }
  });

  it("returns a failed Audit delivery to pending and completes the same event id after recovery", async () => {
    if (!db) throw new Error("NOVA integration database was not initialized");

    const eventId = randomUUID();
    eventIds.push(eventId);
    const tenantId = randomUUID();
    const correlationId = randomUUID();
    const entityId = randomUUID();
    const workerId = `nova-audit-integration-${randomUUID()}`;
    const businessIdempotencyKey = `integration:${tenantId}:${entityId}`;

    await insertNovaAuditOutboxEvent(db, {
      eventId,
      tenantId,
      correlationId,
      businessIdempotencyKey,
      domainEventType: "contact.imported",
      entityType: "contact",
      entityId,
      payload: { contactId: entityId, source: "nova-outbox-integration" },
      destination: AUDIT_DESTINATION
    });

    const outbox = new PostgresNovaOutbox(db, workerId);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("synthetic Audit outage"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const dispatcher = new HttpOutboxDispatcher<Record<string, unknown>>({
      workerId,
      internalToken: "nova-to-audit-integration-token-0001",
      fetch,
      claim: (limit) => outbox.claim(limit),
      complete: (claimedEventId) => outbox.complete(claimedEventId),
      fail: (claimedEventId, errorCode) => outbox.fail(claimedEventId, errorCode)
    });

    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 0, failed: 1 });

    const retryable = await readOutboxState(db, eventId);
    expect(retryable).toMatchObject({
      eventId,
      eventType: novaAuditEventRecordContract.eventType,
      status: "pending",
      attemptCount: 1,
      lockedAt: null,
      lockedBy: null,
      lastError: "network_error",
      payload: {
        tenantId,
        actorId: "nova-core-service",
        eventType: "contact.imported",
        entityType: "contact",
        entityId
      }
    });

    await waitUntilRetryIsAvailable(db, eventId);
    await expect(dispatcher.drainOnce()).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    const completed = await readOutboxState(db, eventId);
    expect(completed).toMatchObject({
      eventId,
      eventType: novaAuditEventRecordContract.eventType,
      status: "completed",
      attemptCount: 2,
      lockedAt: null,
      lockedBy: null,
      lastError: null
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    const requestBodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(requestBodies[0]).toEqual(requestBodies[1]);
    expect(requestBodies[1]).toMatchObject({
      id: eventId,
      type: novaAuditEventRecordContract.eventType,
      version: 1,
      tenantId
    });
    for (const [destination, init] of fetch.mock.calls) {
      expect(destination).toBe(AUDIT_DESTINATION);
      const headers =
        init?.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : ((init?.headers as Record<string, string> | undefined) ?? {});
      expect(headers).toMatchObject({
        "x-hyperion-event-id": eventId,
        "x-hyperion-event-type": novaAuditEventRecordContract.eventType,
        "x-hyperion-event-version": "1"
      });
    }
  });

  it("reclaims and completes a dispatching event whose worker lease expired", async () => {
    if (!db) throw new Error("NOVA integration database was not initialized");

    const eventId = randomUUID();
    eventIds.push(eventId);
    const tenantId = randomUUID();
    await insertNovaAuditOutboxEvent(db, {
      eventId,
      tenantId,
      correlationId: randomUUID(),
      businessIdempotencyKey: `expired-lease:${eventId}`,
      domainEventType: "contact.imported",
      entityType: "contact",
      entityId: randomUUID(),
      payload: { source: "expired-worker" },
      destination: AUDIT_DESTINATION
    });
    await db.query(
      `update nova.outbox_events
          set status = 'dispatching', locked_by = 'crashed-worker', locked_at = now() - interval '3 minutes',
              attempt_count = 1
        where event_id = $1`,
      [eventId]
    );

    const replacement = new PostgresNovaOutbox(db, "replacement-worker");
    await expect(replacement.claim(1)).resolves.toEqual([
      expect.objectContaining({ id: eventId, tenantId, type: novaAuditEventRecordContract.eventType })
    ]);
    await replacement.complete(eventId);

    await expect(readOutboxState(db, eventId)).resolves.toMatchObject({
      status: "completed",
      attemptCount: 2,
      lockedAt: null,
      lockedBy: null
    });
  });
});

async function readOutboxState(db: DatabaseClient, eventId: string): Promise<PersistedOutboxState> {
  const result = await db.query<PersistedOutboxState>(
    `select event_id::text as "eventId",
            event_type as "eventType",
            status,
            attempt_count::int as "attemptCount",
            available_at as "availableAt",
            locked_at as "lockedAt",
            locked_by as "lockedBy",
            last_error as "lastError",
            payload
       from nova.outbox_events
      where event_id = $1`,
    [eventId]
  );
  const state = result.rows[0];
  if (!state) throw new Error(`NOVA outbox event ${eventId} was not persisted`);
  return state;
}

async function waitUntilRetryIsAvailable(db: DatabaseClient, eventId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = await db.query<{ available: boolean }>(
      `select available_at <= now() as available
         from nova.outbox_events
        where event_id = $1`,
      [eventId]
    );
    if (result.rows[0]?.available) return;
    await delay(100);
  }
  throw new Error(`NOVA outbox event ${eventId} did not become retryable`);
}
