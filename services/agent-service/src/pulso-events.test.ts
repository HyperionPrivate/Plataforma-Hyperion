import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it } from "vitest";
import { consumePulsoMessageEvent, type PulsoMessageEvent } from "./pulso-events.js";

const EVENT: PulsoMessageEvent = {
  id: "00000000-0000-4000-8000-000000000201",
  type: "pulso.message.received.v1",
  version: 1,
  occurredAt: "2026-07-13T12:00:00.000Z",
  tenantId: "00000000-0000-4000-8000-000000000202",
  payload: {
    inboundEventId: "00000000-0000-4000-8000-000000000203",
    threadBindingId: "00000000-0000-4000-8000-000000000204",
    patientId: "00000000-0000-4000-8000-000000000205",
    conversationId: "00000000-0000-4000-8000-000000000206",
    messageId: "00000000-0000-4000-8000-000000000207",
    occurredAt: "2026-07-13T12:00:00.000Z"
  }
};

describe("consumePulsoMessageEvent", () => {
  it("creates the SOFIA job and audit outbox in one transaction", async () => {
    const db = scriptedDatabase([[{ eventId: EVENT.id }], [{ id: "00000000-0000-4000-8000-000000000208" }], [], []]);

    await expect(consumePulsoMessageEvent(db.client, EVENT)).resolves.toEqual({
      status: "accepted",
      jobId: "00000000-0000-4000-8000-000000000208"
    });

    expect(db.transactions).toBe(1);
    expect(db.calls.map((call) => call.sql)).toEqual([
      expect.stringContaining("insert into agent_runtime.inbox_events"),
      expect.stringContaining("insert into agent_runtime.jobs"),
      expect.stringContaining("insert into agent_runtime.outbox_events"),
      expect.stringContaining("update agent_runtime.inbox_events")
    ]);
    expect(db.calls[2]?.sql).toContain("'sofia.audit.event.record.v1'");
    expect(db.calls[2]?.sql).not.toContain("'audit.event.record.v1'");
    expect(db.calls.some((call) => call.sql.includes("pulso_iris.") || call.sql.includes("channel_runtime."))).toBe(
      false
    );
  });

  it("replays the stored result without a second job", async () => {
    const jobId = "00000000-0000-4000-8000-000000000208";
    const first = scriptedDatabase([[{ eventId: EVENT.id }], [{ id: jobId }], [], []]);
    await consumePulsoMessageEvent(first.client, EVENT);
    const hash = String(first.calls[0]?.params?.[4]);
    const replay = scriptedDatabase([[], [{ payloadHash: hash, result: { jobId } }]]);

    await expect(consumePulsoMessageEvent(replay.client, EVENT)).resolves.toEqual({ status: "duplicate", jobId });
    expect(replay.calls).toHaveLength(2);
  });

  it("rejects a reused event id with a different payload hash", async () => {
    const db = scriptedDatabase([[], [{ payloadHash: "f".repeat(64), result: {} }]]);
    await expect(consumePulsoMessageEvent(db.client, EVENT)).resolves.toEqual({ status: "conflict" });
    expect(db.calls).toHaveLength(2);
  });

  it("rejects a replayed event id from a different tenant even when the domain payload is unchanged", async () => {
    const accepted = scriptedDatabase([
      [{ eventId: EVENT.id }],
      [{ id: "00000000-0000-4000-8000-000000000208" }],
      [],
      []
    ]);
    await consumePulsoMessageEvent(accepted.client, EVENT);
    const originalEnvelopeHash = String(accepted.calls[0]?.params?.[4]);
    const crossTenantEvent: PulsoMessageEvent = {
      ...EVENT,
      tenantId: "00000000-0000-4000-8000-000000000209"
    };
    const replay = scriptedDatabase([[], [{ payloadHash: originalEnvelopeHash, result: { jobId: "hidden" } }]]);

    await expect(consumePulsoMessageEvent(replay.client, crossTenantEvent)).resolves.toEqual({ status: "conflict" });
    expect(replay.calls).toHaveLength(2);
  });
});

function scriptedDatabase(results: unknown[][]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  let transactions = 0;
  const client: DatabaseClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      const rows = results.shift() ?? [];
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as never;
    },
    async transaction(work) {
      transactions += 1;
      return work(client);
    },
    async close() {}
  };
  return {
    calls,
    client,
    get transactions() {
      return transactions;
    }
  };
}
