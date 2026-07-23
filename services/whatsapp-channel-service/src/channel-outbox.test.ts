import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it } from "vitest";
import { PostgresChannelOutbox } from "./channel-outbox.js";

describe("PostgresChannelOutbox", () => {
  it("claims a bounded batch and maps the PULSO destination without exposing it in SQL", async () => {
    const db = fakeDatabase([
      response([
        {
          id: "00000000-0000-4000-8000-000000000101",
          tenantId: "00000000-0000-4000-8000-000000000102",
          eventType: "channel.inbound.received.v2",
          eventVersion: 2,
          occurredAt: new Date("2026-07-13T12:00:00.000Z"),
          streamId: "00000000-0000-4000-8000-000000000104",
          streamSequence: "7",
          payload: { inboundEventId: "00000000-0000-4000-8000-000000000103" }
        }
      ])
    ]);
    const outbox = new PostgresChannelOutbox(db.client, "channel-worker", "http://pulso.local/");

    const claimed = await outbox.claim(999);

    expect(claimed).toEqual([
      expect.objectContaining({
        type: "channel.inbound.received.v2",
        occurredAt: "2026-07-13T12:00:00.000Z",
        streamId: "00000000-0000-4000-8000-000000000104",
        streamSequence: 7,
        destination: "http://pulso.local/internal/v1/events/channel-inbound"
      })
    ]);
    expect(db.calls[0]?.params).toEqual(["channel-worker", 20, null]);
    expect(db.calls[0]?.sql).toContain("for update skip locked");
    expect(db.calls[0]?.sql).toContain("predecessor.stream_sequence < candidate.stream_sequence");
    expect(db.calls[0]?.sql).toContain("predecessor.status <> 'published'");
    expect(db.calls[0]?.sql).toContain(
      "candidate.event_type in ('channel.inbound.received.v1', 'channel.inbound.received.v2')"
    );
    expect(db.calls[0]?.sql).toContain("candidate.tenant_id = $3::uuid");
    expect(db.calls[0]?.sql).toContain("terminalized_sources");
    expect(db.calls[0]?.sql).toContain("'outboxStatus', 'dead_letter'");
  });

  it("keeps a legacy v1 envelope strict while the database still uses its sequence for head-of-line blocking", async () => {
    const db = fakeDatabase([
      response([
        {
          id: "00000000-0000-4000-8000-000000000101",
          tenantId: "00000000-0000-4000-8000-000000000102",
          eventType: "channel.inbound.received.v1",
          eventVersion: 1,
          occurredAt: new Date("2026-07-13T12:00:00.000Z"),
          streamId: "00000000-0000-4000-8000-000000000104",
          streamSequence: "8",
          payload: { inboundEventId: "00000000-0000-4000-8000-000000000103" }
        }
      ])
    ]);
    const outbox = new PostgresChannelOutbox(db.client, "channel-worker", "http://pulso.local");

    const claimed = await outbox.claim(1);

    expect(claimed[0]).toMatchObject({ type: "channel.inbound.received.v1", version: 1 });
    expect(claimed[0]).not.toHaveProperty("streamId");
    expect(claimed[0]).not.toHaveProperty("streamSequence");
  });

  it("completes the outbox and its inbound source in the same transaction", async () => {
    const eventId = "00000000-0000-4000-8000-000000000101";
    const sourceId = "00000000-0000-4000-8000-000000000103";
    const tenantId = "00000000-0000-4000-8000-000000000102";
    const db = fakeDatabase([
      response([
        {
          id: eventId,
          tenantId,
          aggregateId: sourceId,
          aggregateType: "channel_inbound_event",
          status: "published"
        }
      ]),
      response([{ id: sourceId }])
    ]);
    const outbox = new PostgresChannelOutbox(db.client, "channel-worker", "http://pulso.local");

    await outbox.complete(eventId);

    expect(db.calls[0]?.sql).toContain("status = 'published'");
    expect(db.calls[0]?.params).toEqual([eventId, "channel-worker"]);
    expect(db.calls[1]?.sql).toContain("status = 'processed'");
    expect(db.calls[1]?.params).toEqual([tenantId, sourceId, eventId]);
    expect(db.transactionCount).toBe(1);
  });

  it("keeps a retry local to the leased outbox row and dead-letters the source only at exhaustion", async () => {
    const retryId = "00000000-0000-4000-8000-000000000101";
    const terminalId = "00000000-0000-4000-8000-000000000104";
    const sourceId = "00000000-0000-4000-8000-000000000103";
    const tenantId = "00000000-0000-4000-8000-000000000102";
    const db = fakeDatabase([
      response([
        {
          id: retryId,
          tenantId,
          aggregateId: sourceId,
          aggregateType: "channel_inbound_event",
          status: "retry_scheduled"
        }
      ]),
      response([
        {
          id: terminalId,
          tenantId,
          aggregateId: sourceId,
          aggregateType: "channel_inbound_event",
          status: "dead_letter"
        }
      ]),
      response([{ id: sourceId }])
    ]);
    const outbox = new PostgresChannelOutbox(db.client, "channel-worker", "http://pulso.local");

    await outbox.fail(retryId, "HTTP 503/private detail");
    await outbox.fail(terminalId, "Timeout/private detail");

    expect(db.calls[0]?.sql).toContain("'retry_scheduled'");
    expect(db.calls[0]?.params).toEqual([retryId, "channel-worker", "http_503_private_detail", false]);
    expect(db.calls[1]?.params).toEqual([terminalId, "channel-worker", "timeout_private_detail", false]);
    expect(db.calls[2]?.sql).toContain("else 'dead_letter'");
    expect(db.calls[2]?.sql).toContain("status in ('processed', 'ignored')");
    expect(db.calls[2]?.params).toEqual([tenantId, sourceId, terminalId, "timeout_private_detail"]);
    expect(db.transactionCount).toBe(2);
  });

  it("does not touch the source after losing the outbox lease", async () => {
    const db = fakeDatabase([response([])]);
    const outbox = new PostgresChannelOutbox(db.client, "channel-worker", "http://pulso.local");

    await outbox.complete("00000000-0000-4000-8000-000000000101");

    expect(db.calls).toHaveLength(1);
    expect(db.transactionCount).toBe(1);
  });

  it("rejects publishing when its source row is missing so the transaction can roll back", async () => {
    const db = fakeDatabase([
      response([
        {
          id: "00000000-0000-4000-8000-000000000101",
          tenantId: "00000000-0000-4000-8000-000000000102",
          aggregateId: "00000000-0000-4000-8000-000000000103",
          aggregateType: "channel_inbound_event",
          status: "published"
        }
      ]),
      response([])
    ]);
    const outbox = new PostgresChannelOutbox(db.client, "channel-worker", "http://pulso.local");

    await expect(outbox.complete("00000000-0000-4000-8000-000000000101")).rejects.toThrow(
      "Channel inbound source missing"
    );
  });
});

interface FakeResponse {
  rows: unknown[];
  rowCount: number;
}

function response(rows: unknown[]): FakeResponse {
  return { rows, rowCount: rows.length };
}

function fakeDatabase(responses: FakeResponse[]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let transactionCount = 0;
  const client: DatabaseClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      const next = responses.shift() ?? response([]);
      return { ...next, command: "", oid: 0, fields: [] } as never;
    },
    async transaction(work) {
      transactionCount += 1;
      return work(client as never);
    },
    async close() {}
  };
  return {
    calls,
    client,
    get transactionCount() {
      return transactionCount;
    }
  };
}
