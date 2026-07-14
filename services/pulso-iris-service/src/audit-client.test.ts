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

  it("enqueues durable audit events into the PULSO outbox", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const emit = createAuditClient({
      db: { query } as never,
      logger: { warn: vi.fn() }
    });

    await emit({
      tenantId: "00000000-0000-4000-8000-000000000001",
      actorId: "op-1",
      eventType: "appointment.registered",
      entityType: "appointment",
      entityId: "00000000-0000-4000-8000-000000000002"
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("insert into pulso_iris.outbox_events");
    expect(sql).toContain("on conflict (tenant_id, dedupe_key)");
    expect(params[0]).toBe("00000000-0000-4000-8000-000000000001");
    expect(params[1]).toBe(PULSO_AUDIT_EVENT_TYPE);
    expect(params[2]).toBe("appointment");
    expect(params[3]).toBe("00000000-0000-4000-8000-000000000002");
    expect(JSON.parse(String(params[5])).metadata.source).toBe("pulso-iris-service");
  });

  it("skips emission when the database client is missing", async () => {
    const warn = vi.fn();
    const emit = createAuditClient({ logger: { warn } });

    await emit({
      eventType: "config.updated",
      entityType: "holiday",
      tenantId: "00000000-0000-4000-8000-000000000001"
    });

    expect(warn).toHaveBeenCalledOnce();
  });

  it("accepts an explicit transaction executor", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await enqueuePulsoAuditEvent({ query } as never, {
      tenantId: "00000000-0000-4000-8000-000000000001",
      eventType: "appointment.cancelled",
      entityType: "appointment",
      entityId: "00000000-0000-4000-8000-000000000003"
    });
    expect(query).toHaveBeenCalledOnce();
  });
});
