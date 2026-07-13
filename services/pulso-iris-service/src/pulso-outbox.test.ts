import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it } from "vitest";
import { PostgresPulsoOutbox } from "./pulso-outbox.js";

describe("PostgresPulsoOutbox", () => {
  it("maps claimed rows to the SOFIA inbox contract", async () => {
    const db = fakeDatabase([
      {
        id: "00000000-0000-4000-8000-000000000301",
        tenantId: "00000000-0000-4000-8000-000000000302",
        eventType: "pulso.message.received.v1",
        eventVersion: 1,
        occurredAt: new Date("2026-07-13T12:00:00.000Z"),
        payload: { messageId: "00000000-0000-4000-8000-000000000303" }
      }
    ]);
    const store = new PostgresPulsoOutbox(db.client, "pulso-worker", "http://agent.local/");

    await expect(store.claim(5)).resolves.toEqual([
      expect.objectContaining({
        type: "pulso.message.received.v1",
        destination: "http://agent.local/internal/v1/events/pulso-message-received"
      })
    ]);
    expect(db.calls[0]?.sql).toContain("for update skip locked");
  });

  it("uses the worker lease when completing or failing", async () => {
    const db = fakeDatabase([]);
    const store = new PostgresPulsoOutbox(db.client, "pulso-worker", "http://agent.local");
    await store.complete("00000000-0000-4000-8000-000000000301");
    await store.fail("00000000-0000-4000-8000-000000000302", "HTTP 503");
    expect(db.calls[0]?.params).toEqual(["00000000-0000-4000-8000-000000000301", "pulso-worker"]);
    expect(db.calls[1]?.params).toEqual(["00000000-0000-4000-8000-000000000302", "pulso-worker", "http_503"]);
  });
});

function fakeDatabase(rows: unknown[]) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const client: DatabaseClient = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] } as never;
    },
    async transaction(work) {
      return work(client);
    },
    async close() {}
  };
  return { calls, client };
}
