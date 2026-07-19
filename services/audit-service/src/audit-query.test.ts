import { describe, expect, it, vi } from "vitest";
import { listSourceAuditEvents } from "./audit-query.js";

describe("source-scoped Audit queries", () => {
  it("binds tenant, source and entity without exposing another producer's ledger", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          eventType: "appointment.verified",
          actorId: null,
          metadata: {},
          createdAt: new Date("2026-07-18T08:00:00.000Z")
        }
      ]
    });

    const events = await listSourceAuditEvents({ query } as never, {
      tenantId: "22222222-2222-4222-8222-222222222222",
      sourceService: "pulso-iris-service",
      entityType: "appointment",
      entityId: "33333333-3333-4333-8333-333333333333"
    });

    expect(events[0]?.createdAt).toBe("2026-07-18T08:00:00.000Z");
    expect(String(query.mock.calls[0]?.[0])).toContain("join audit_runtime.inbox_events");
    expect(String(query.mock.calls[0]?.[0])).toContain("inbox.source_service = $2");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "pulso-iris-service",
      "appointment",
      "33333333-3333-4333-8333-333333333333"
    ]);
  });
});
