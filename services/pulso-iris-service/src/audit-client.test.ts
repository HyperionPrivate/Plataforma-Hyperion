import { describe, expect, it, vi } from "vitest";
import { createAuditClient, PULSO_AUDIT_EVENTS, readOperatorId } from "./audit-client.js";

describe("audit-client", () => {
  it("exposes the exact PULSO event catalog", () => {
    expect([...PULSO_AUDIT_EVENTS]).toEqual([
      "appointment.registered",
      "appointment.verified",
      "appointment.rescheduled",
      "appointment.cancelled",
      "handoff.assigned",
      "config.updated"
    ]);
  });

  it("reads operator id from gateway headers", () => {
    expect(readOperatorId({ "x-operator-id": "op-1" })).toBe("op-1");
    expect(readOperatorId({})).toBeUndefined();
  });

  it("emits fire-and-forget events with source metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const emit = createAuditClient({
      auditServiceUrl: "http://audit.local",
      internalServiceToken: "secret",
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    emit({
      tenantId: "00000000-0000-4000-8000-000000000001",
      actorId: "op-1",
      eventType: "appointment.registered",
      entityType: "appointment",
      entityId: "00000000-0000-4000-8000-000000000002"
    });

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://audit.local/v1/audit/events");
    expect(init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(String(init.body)).metadata.source).toBe("pulso-iris-service");
  });

  it("skips emission when token or url is missing", () => {
    const fetchImpl = vi.fn();
    const warn = vi.fn();
    const emit = createAuditClient({
      logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    emit({
      eventType: "config.updated",
      entityType: "holiday"
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});
