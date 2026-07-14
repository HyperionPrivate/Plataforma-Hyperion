import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it } from "vitest";
import { PostgresPulsoOutbox } from "./pulso-outbox.js";

describe("PostgresPulsoOutbox", () => {
  it.each([
    ["pulso.message.received.v1", 1],
    ["pulso.message.received.v2", 2]
  ] as const)("maps a stored %s row to the current SOFIA inbox contract", async (eventType, eventVersion) => {
    const db = fakeDatabase([
      {
        id: "00000000-0000-4000-8000-000000000301",
        tenantId: "00000000-0000-4000-8000-000000000302",
        eventType,
        eventVersion,
        occurredAt: new Date("2026-07-13T12:00:00.000Z"),
        payload: {
          conversationId: "00000000-0000-4000-8000-000000000304",
          messageId: "00000000-0000-4000-8000-000000000303"
        },
        streamId: "00000000-0000-4000-8000-000000000304",
        streamSequence: "7",
        sourceStreamId: "00000000-0000-4000-8000-000000000305",
        sourceStreamSequence: "11"
      }
    ]);
    const store = new PostgresPulsoOutbox(db.client, "pulso-worker", "http://agent.local/");

    await expect(store.claim(5)).resolves.toEqual([
      expect.objectContaining({
        type: "pulso.message.received.v2",
        version: 2,
        streamId: "00000000-0000-4000-8000-000000000304",
        streamSequence: 7,
        payload: expect.objectContaining({
          sourceStreamId: "00000000-0000-4000-8000-000000000305",
          sourceStreamSequence: 11
        }),
        destination: "http://agent.local/internal/v1/events/pulso-message-received"
      })
    ]);
    expect(db.calls[0]?.sql).toContain("for update of candidate skip locked");
    expect(db.calls[0]?.sql).toContain("predecessor.status <> 'published'");
    expect(db.calls[0]?.sql).toContain("event_type in ($4, $5)");
    expect(db.calls[0]?.sql).toContain("candidate.event_type in ($4, $5)");
    expect(db.calls[0]?.params?.slice(3)).toEqual(["pulso.message.received.v1", "pulso.message.received.v2"]);
  });

  it("uses the worker lease when completing or failing", async () => {
    const db = fakeDatabase([]);
    const store = new PostgresPulsoOutbox(db.client, "pulso-worker", "http://agent.local");
    await store.complete("00000000-0000-4000-8000-000000000301");
    await store.fail("00000000-0000-4000-8000-000000000302", "HTTP 503");
    expect(db.calls[0]?.params).toEqual(["00000000-0000-4000-8000-000000000301", "pulso-worker"]);
    expect(db.calls[1]?.params).toEqual(["00000000-0000-4000-8000-000000000302", "pulso-worker", "http_503"]);
  });

  it.each([
    ["pulso.message.received.v1", 2],
    ["pulso.message.received.v2", 1]
  ] as const)("rejects the invalid stored contract pair %s@%s", async (eventType, eventVersion) => {
    const db = fakeDatabase([outboxRow({ eventType, eventVersion })]);
    const store = new PostgresPulsoOutbox(db.client, "pulso-worker", "http://agent.local");

    await expect(store.claim(1)).rejects.toThrow(`Invalid PULSO outbox contract version: ${eventType}@${eventVersion}`);
  });

  it("accepts the largest safe sequence and rejects the next bigint", async () => {
    const safe = fakeDatabase([
      outboxRow({
        eventType: "pulso.message.received.v2",
        eventVersion: 2,
        streamSequence: String(Number.MAX_SAFE_INTEGER),
        sourceStreamSequence: String(Number.MAX_SAFE_INTEGER)
      })
    ]);
    await expect(new PostgresPulsoOutbox(safe.client, "pulso-worker", "http://agent.local").claim(1)).resolves.toEqual([
      expect.objectContaining({
        streamSequence: Number.MAX_SAFE_INTEGER,
        payload: expect.objectContaining({ sourceStreamSequence: Number.MAX_SAFE_INTEGER })
      })
    ]);

    const unsafe = fakeDatabase([
      outboxRow({
        eventType: "pulso.message.received.v2",
        eventVersion: 2,
        streamSequence: "9007199254740992"
      })
    ]);
    await expect(new PostgresPulsoOutbox(unsafe.client, "pulso-worker", "http://agent.local").claim(1)).rejects.toThrow(
      "PULSO outbox streamSequence is invalid"
    );
  });
});

function outboxRow(overrides: Record<string, unknown>) {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    tenantId: "00000000-0000-4000-8000-000000000302",
    occurredAt: new Date("2026-07-13T12:00:00.000Z"),
    payload: {
      conversationId: "00000000-0000-4000-8000-000000000304",
      messageId: "00000000-0000-4000-8000-000000000303"
    },
    streamId: "00000000-0000-4000-8000-000000000304",
    streamSequence: "7",
    sourceStreamId: "00000000-0000-4000-8000-000000000305",
    sourceStreamSequence: "11",
    ...overrides
  };
}

function fakeDatabase(rows: unknown[]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client: DatabaseClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as never;
    },
    async transaction(work) {
      return work(client as never);
    },
    async close() {}
  };
  return { calls, client };
}
