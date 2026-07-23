import type { DatabaseClient } from "@hyperion/database";
import { describe, expect, it, vi } from "vitest";
import { PostgresLumenOutbox } from "./lumen-outbox.js";

describe("PostgresLumenOutbox", () => {
  it("claims a bounded batch and maps it to the internal audit destination", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [
        {
          id: "c1d91672-5d10-4bdc-a887-a07645a28e90",
          tenantId: "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c",
          eventType: "lumen.audit.event.record.v1",
          eventVersion: 1,
          occurredAt: new Date("2026-07-13T15:00:00.000Z"),
          payload: { eventType: "lumen.encounter.started" }
        }
      ]
    });
    const outbox = new PostgresLumenOutbox(database(query), "lumen-worker", "http://audit:8086/");

    await expect(outbox.claim(999)).resolves.toEqual([
      expect.objectContaining({
        id: "c1d91672-5d10-4bdc-a887-a07645a28e90",
        destination: "http://audit:8086/internal/v1/events",
        occurredAt: "2026-07-13T15:00:00.000Z"
      })
    ]);
    expect(query.mock.calls[0]![0]).toContain("update lumen.outbox_events");
    expect(query.mock.calls[0]![1]).toEqual(["lumen-worker", 20]);
  });

  it("completes only its lease and sanitizes retry errors", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const outbox = new PostgresLumenOutbox(database(query), "lumen-worker", "http://audit:8086");

    await outbox.complete("c1d91672-5d10-4bdc-a887-a07645a28e90");
    await outbox.fail("c1d91672-5d10-4bdc-a887-a07645a28e90", "HTTP 500\r\nprivate");

    expect(query.mock.calls[0]![1]).toEqual(["c1d91672-5d10-4bdc-a887-a07645a28e90", "lumen-worker"]);
    expect(query.mock.calls[1]![1]).toEqual([
      "c1d91672-5d10-4bdc-a887-a07645a28e90",
      "lumen-worker",
      "http_500__private",
      false
    ]);
  });
});

function database(query: ReturnType<typeof vi.fn>): DatabaseClient {
  return { query } as unknown as DatabaseClient;
}
