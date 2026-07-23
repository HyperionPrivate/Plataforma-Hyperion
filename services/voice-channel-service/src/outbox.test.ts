import { describe, expect, it, vi } from "vitest";
import { PostgresVoiceOutbox } from "./outbox.js";

describe("PostgresVoiceOutbox.fail", () => {
  it("inserts into voice.outbox_dlq when the event reaches the failed threshold", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const outbox = new PostgresVoiceOutbox({ query } as never, "voice-worker");

    await outbox.fail("22222222-2222-4222-8222-222222222222", "webhook_delivery_failed");

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toMatch(/insert into voice\.outbox_dlq/i);
    expect(sql).toMatch(/attempt_count >= 8/i);
    expect(params).toEqual(["22222222-2222-4222-8222-222222222222", "voice-worker", "webhook_delivery_failed", false]);
  });
});

describe("PostgresVoiceOutbox.claim", () => {
  it("reclaims an expired dispatching lease after a worker crash", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const outbox = new PostgresVoiceOutbox({ query } as never, "replacement-worker");

    await outbox.claim(10);

    const [sql, params] = query.mock.calls[0]! as unknown as [string, unknown[]];
    expect(sql).toMatch(/status = 'pending' and available_at <= now\(\)/i);
    expect(sql).toMatch(/status = 'dispatching' and locked_at < now\(\) - interval '2 minutes'/i);
    expect(sql).toMatch(/for update skip locked/i);
    expect(params).toEqual(["replacement-worker", 10]);
  });
});
