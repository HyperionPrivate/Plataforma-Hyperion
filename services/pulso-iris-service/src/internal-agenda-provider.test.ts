import { describe, expect, it, vi } from "vitest";
import { InternalAgendaProvider } from "./internal-agenda-provider.js";

describe("InternalAgendaProvider", () => {
  it.each([
    [
      "cancel",
      (provider: InternalAgendaProvider) =>
        provider.cancel({
          tenantId: "00000000-0000-4000-8000-000000000001",
          appointmentId: "00000000-0000-4000-8000-000000000002",
          actorId: "agent:SOFIA",
          reason: "Solicitud controlada"
        })
    ],
    [
      "reschedule",
      (provider: InternalAgendaProvider) =>
        provider.reschedule({
          tenantId: "00000000-0000-4000-8000-000000000001",
          appointmentId: "00000000-0000-4000-8000-000000000002",
          replacementAppointmentId: "00000000-0000-4000-8000-000000000003",
          actorId: "agent:SOFIA",
          reason: "Solicitud controlada"
        })
    ]
  ])("enforces a future scheduled time in the atomic %s update", async (_operation, execute) => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const provider = new InternalAgendaProvider({ query } as unknown as ConstructorParameters<
      typeof InternalAgendaProvider
    >[0]);

    await expect(execute(provider)).rejects.toMatchObject({ code: "invalid_transition" });
    expect(String(query.mock.calls[0]?.[0])).toContain("scheduled_at > now()");
  });

  it("rejects a new past slot before reserving capacity", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const transaction = vi.fn(async (callback: (db: { query: typeof query }) => Promise<unknown>) =>
      callback({ query })
    );
    const provider = new InternalAgendaProvider({ transaction } as unknown as ConstructorParameters<
      typeof InternalAgendaProvider
    >[0]);

    await expect(
      provider.reserve({
        tenantId: "00000000-0000-4000-8000-000000000001",
        patientId: "00000000-0000-4000-8000-000000000002",
        conversationId: "00000000-0000-4000-8000-000000000003",
        siteId: "00000000-0000-4000-8000-000000000004",
        professionalId: "00000000-0000-4000-8000-000000000005",
        payerId: "00000000-0000-4000-8000-000000000006",
        appointmentTypeId: "00000000-0000-4000-8000-000000000007",
        scheduledAt: "2000-01-01T14:00:00.000Z",
        idempotencyKey: "controlled-past-slot",
        actorId: "agent:SOFIA",
        holdDurationMinutes: 10
      })
    ).rejects.toMatchObject({ code: "slot_unavailable" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("does not verify an active hold after its scheduled time", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ mode: "internal", status: "active" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000008",
            tenantId: "00000000-0000-4000-8000-000000000001",
            siteId: "00000000-0000-4000-8000-000000000004",
            professionalId: "00000000-0000-4000-8000-000000000005",
            payerId: "00000000-0000-4000-8000-000000000006",
            appointmentTypeId: "00000000-0000-4000-8000-000000000007",
            scheduledAt: "2000-01-01T14:00:00.000Z",
            durationMin: 20,
            slotCapacityToken: 1,
            status: "active",
            expiresAt: "2999-01-01T00:00:00.000Z",
            idempotencyKey: "controlled-past-hold",
            createdAt: "2000-01-01T13:50:00.000Z",
            updatedAt: "2000-01-01T13:50:00.000Z"
          }
        ]
      });
    const transaction = vi.fn(async (callback: (db: { query: typeof query }) => Promise<unknown>) =>
      callback({ query })
    );
    const provider = new InternalAgendaProvider({ transaction } as unknown as ConstructorParameters<
      typeof InternalAgendaProvider
    >[0]);

    await expect(
      provider.verify({
        tenantId: "00000000-0000-4000-8000-000000000001",
        holdId: "00000000-0000-4000-8000-000000000008",
        appointmentIdempotencyKey: "controlled-appointment",
        origin: "sofia_wa",
        actorId: "agent:SOFIA"
      })
    ).rejects.toMatchObject({ code: "hold_expired" });
    expect(query).toHaveBeenCalledTimes(4);
  });
});
