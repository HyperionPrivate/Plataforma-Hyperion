import { describe, expect, it, vi } from "vitest";
import { PostgresNovaOutbox } from "./outbox.js";

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
    expect(params).toEqual(["11111111-1111-4111-8111-111111111111", "worker-test", "dialer_timeout_"]);
  });
});
