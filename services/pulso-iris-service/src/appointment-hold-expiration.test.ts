import { describe, expect, it, vi } from "vitest";
import { deferOverdueExternalConfirmations, expireAppointmentHolds } from "./appointment-hold-expiration.js";

describe("appointment hold expiration", () => {
  it("expires holds and emits non-sensitive audit events", async () => {
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: "00000000-0000-4000-8000-000000000011", tenantId: "00000000-0000-4000-8000-000000000012" }]
    });
    const tx = { query };
    const transaction = vi.fn(async (work: (executor: typeof tx) => Promise<unknown>) => work(tx));
    const emitAudit = vi.fn();

    const count = await expireAppointmentHolds({ transaction } as never, emitAudit);

    expect(count).toBe(1);
    expect(emitAudit).toHaveBeenCalledWith(
      {
        tenantId: "00000000-0000-4000-8000-000000000012",
        actorId: "system",
        eventType: "appointment.hold.expired",
        entityType: "appointment_hold",
        entityId: "00000000-0000-4000-8000-000000000011"
      },
      tx
    );
  });

  it("rolls the expiration back when its audit event cannot be persisted", async () => {
    let status: "active" | "expired" = "active";
    const tx = {
      query: vi.fn(async () => {
        status = "expired";
        return {
          rowCount: 1,
          rows: [{ id: "00000000-0000-4000-8000-000000000013", tenantId: "00000000-0000-4000-8000-000000000014" }]
        };
      })
    };
    const transaction = vi.fn(async (work: (executor: typeof tx) => Promise<unknown>) => {
      const initialStatus = status;
      try {
        return await work(tx);
      } catch (error) {
        status = initialStatus;
        throw error;
      }
    });
    const emitAudit = vi.fn(async (_input: unknown, _executor: unknown) => {
      throw new Error("audit unavailable");
    });

    await expect(expireAppointmentHolds({ transaction } as never, emitAudit)).rejects.toThrow("audit unavailable");
    expect(status).toBe("active");
    expect(emitAudit.mock.calls[0]?.[1]).toBe(tx);
  });
});

describe("deferOverdueExternalConfirmations", () => {
  it("moves only overdue manual confirmations to deferred", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2, rows: [{ id: "a" }, { id: "b" }] });

    await expect(deferOverdueExternalConfirmations({ query } as never)).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("external_sla_due_at <= now()"));
  });
});
