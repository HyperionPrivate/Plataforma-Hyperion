import { describe, expect, it, vi } from "vitest";
import {
  createAuditClient,
  enqueuePulsoAuditEvent,
  PULSO_AUDIT_EVENTS,
  PULSO_AUDIT_EVENT_TYPE,
  readOperatorId
} from "./audit-client.js";

describe("audit-client", () => {
  it("exposes the exact PULSO event catalog", () => {
    expect([...PULSO_AUDIT_EVENTS]).toEqual([
      "agenda.settings.updated",
      "agenda.configuration.imported",
      "appointment.hold.created",
      "appointment.hold.expired",
      "appointment.pending_external_confirmation",
      "appointment.manually_verified",
      "appointment.external_rejected",
      "appointment.registered",
      "appointment.verified",
      "appointment.rescheduled",
      "appointment.cancelled",
      "channel.message.received",
      "channel.message.sent",
      "agent.execution.completed",
      "agent.tool.executed",
      "agent.response.created",
      "handoff.assigned",
      "config.updated"
    ]);
  });

  it("reads operator id from gateway headers", () => {
    expect(readOperatorId({ "x-operator-id": "op-1" })).toBe("op-1");
    expect(readOperatorId({})).toBeUndefined();
  });

  it("rejects an unscoped executor instead of falling back to an autocommit pool", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const emit = createAuditClient({
      logger: { warn: vi.fn() }
    });

    await expect(
      emit(
        {
          tenantId: "00000000-0000-4000-8000-000000000001",
          actorId: "op-1",
          eventType: "appointment.registered",
          entityType: "appointment",
          entityId: "00000000-0000-4000-8000-000000000002"
        },
        { query } as never
      )
    ).rejects.toThrow("active database transaction");
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts an explicit transaction executor", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "audit-id" }], rowCount: 1 });
    await enqueuePulsoAuditEvent({ query } as never, {
      tenantId: "00000000-0000-4000-8000-000000000001",
      eventType: "appointment.cancelled",
      entityType: "appointment",
      entityId: "00000000-0000-4000-8000-000000000003"
    });
    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("insert into pulso_iris.outbox_events");
    expect(sql).toContain("on conflict (tenant_id, dedupe_key)");
    expect(sql).toContain("returning id");
    expect(params[0]).toBe("00000000-0000-4000-8000-000000000001");
    expect(params[1]).toBe(PULSO_AUDIT_EVENT_TYPE);
    expect(params[2]).toBe("appointment");
    expect(params[3]).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(params[3]).not.toBe("00000000-0000-4000-8000-000000000003");
    expect(sql).toContain("id, tenant_id");
    expect(JSON.parse(String(params[5]))).toMatchObject({
      entityId: "00000000-0000-4000-8000-000000000003",
      metadata: { source: "pulso-iris-service" }
    });
  });

  it("does not let correlation metadata deduplicate separate audit facts", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "audit-id" }], rowCount: 1 });
    const input = {
      tenantId: "00000000-0000-4000-8000-000000000001",
      eventType: "config.updated" as const,
      entityType: "configuration",
      entityId: "00000000-0000-4000-8000-000000000004",
      metadata: { requestId: "client-reused-request-id", auditDedupeSuffix: "client-reused-request-id" }
    };

    await enqueuePulsoAuditEvent({ query } as never, input);
    await enqueuePulsoAuditEvent({ query } as never, input);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[1]?.[4]).not.toBe(query.mock.calls[1]?.[1]?.[4]);
    expect(JSON.parse(String(query.mock.calls[0]?.[1]?.[5])).metadata).toEqual({
      source: "pulso-iris-service",
      requestId: "client-reused-request-id"
    });
  });

  it("accepts an exact replay for an explicit business idempotency key", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ matches: true }], rowCount: 1 });

    await expect(
      enqueuePulsoAuditEvent({ query } as never, {
        tenantId: "00000000-0000-4000-8000-000000000001",
        eventType: "config.updated",
        entityType: "configuration",
        entityId: "00000000-0000-4000-8000-000000000005",
        idempotencyKey: "configuration-revision-1",
        metadata: { revision: 1 }
      })
    ).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("payload = $5::jsonb");
  });

  it("rejects divergent reuse of an explicit business idempotency key", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ matches: false }], rowCount: 1 });

    await expect(
      enqueuePulsoAuditEvent({ query } as never, {
        tenantId: "00000000-0000-4000-8000-000000000001",
        eventType: "config.updated",
        entityType: "configuration",
        entityId: "00000000-0000-4000-8000-000000000006",
        idempotencyKey: "configuration-revision-1",
        metadata: { revision: 2 }
      })
    ).rejects.toThrow("idempotency key was reused for a different event");
  });
});
