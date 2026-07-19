import { describe, expect, it, vi } from "vitest";
import { PostgresDocumentsOutbox } from "./outbox.js";

describe("PostgresDocumentsOutbox.claim", () => {
  it("reclaims an expired dispatching lease after a worker crash", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const outbox = new PostgresDocumentsOutbox({ query } as never, "replacement-worker");

    await outbox.claim(10);

    const [sql, params] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toMatch(/status = 'pending' and available_at <= now\(\)/i);
    expect(sql).toMatch(/status = 'dispatching' and locked_at < now\(\) - interval '2 minutes'/i);
    expect(sql).toMatch(/for update skip locked/i);
    expect(params).toEqual(["replacement-worker", 10]);
  });
});
