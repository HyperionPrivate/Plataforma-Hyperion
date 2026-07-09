import { describe, expect, it, vi } from "vitest";
import { deferOverdueExternalConfirmations, expireAppointmentHolds } from "./appointment-hold-expiration.js";

describe("appointment hold expiration", () => {
  it("expires holds and emits non-sensitive audit events", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: "00000000-0000-4000-8000-000000000011", tenantId: "00000000-0000-4000-8000-000000000012" }]
    });
    const emitAudit = vi.fn();

    const count = await expireAppointmentHolds({ query } as never, emitAudit);

    expect(count).toBe(1);
    expect(emitAudit).toHaveBeenCalledWith({
      tenantId: "00000000-0000-4000-8000-000000000012",
      actorId: "system",
      eventType: "appointment.hold.expired",
      entityType: "appointment_hold",
      entityId: "00000000-0000-4000-8000-000000000011"
    });
  });
});

describe("deferOverdueExternalConfirmations", () => {
  it("moves only overdue manual confirmations to deferred", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2, rows: [{ id: "a" }, { id: "b" }] });

    await expect(deferOverdueExternalConfirmations({ query } as never)).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("external_sla_due_at <= now()"));
  });
});
