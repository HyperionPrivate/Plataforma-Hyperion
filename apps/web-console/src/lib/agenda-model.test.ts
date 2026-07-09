import { describe, expect, it } from "vitest";
import { normalizeImportPreview, normalizeQueueResponse, queueStatusLabel, queueViewFor } from "./agenda-model.js";

describe("agenda model", () => {
  it("clasifica la cola sin mezclar confirmacion de asistencia y verificacion externa", () => {
    const base = { id: "a", scheduledAt: null, createdAt: new Date(0).toISOString() };
    expect(queueViewFor({ ...base, status: "pending_external_confirmation" })).toBe("pending");
    expect(queueViewFor({ ...base, status: "verified" })).toBe("verified");
    expect(queueViewFor({ ...base, status: "confirmed" })).toBe("verified");
    expect(queueViewFor({ ...base, status: "cancelled" })).toBe("closed");
    expect(queueViewFor({ ...base, status: "failed", errorCode: "configuration" })).toBe("errors");
  });

  it("normaliza respuestas planas de cola", () => {
    const items = [{ id: "a", status: "verified", scheduledAt: null, createdAt: new Date(0).toISOString() }];
    expect(normalizeQueueResponse(items).items).toEqual([{ ...items[0], recordType: "appointment" }]);
    expect(queueStatusLabel("pending_external_confirmation")).toBe("Pendiente de confirmacion externa");
  });

  it("integra citas, reservas y errores del envelope operativo", () => {
    const queue = normalizeQueueResponse({
      appointments: [
        {
          id: "a",
          status: "verified",
          scheduledAt: null,
          createdAt: new Date(0).toISOString(),
          externalSlaDueAt: new Date(2).toISOString()
        }
      ],
      holds: [
        { id: "h", status: "active", scheduledAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString() }
      ],
      configurationErrors: ["Sin horarios"]
    });
    expect(queue.items.map((item) => item.recordType)).toEqual(["appointment", "hold", "configuration_error"]);
    expect(queueViewFor(queue.items[1]!)).toBe("holds");
    expect(queueViewFor(queue.items[2]!)).toBe("errors");
    expect(queue.items[0]?.externalConfirmationDueAt).toBe(new Date(2).toISOString());
    expect(queue.items[2]?.errorMessage).toBe("Sin horarios");
  });

  it("normaliza una vista previa separada por filas aceptadas y rechazadas", () => {
    const preview = normalizeImportPreview({
      acceptedRows: [{ rowNumber: 2, values: { name: "Profesional" } }],
      rejectedRows: [{ rowNumber: 3, error: "Campo requerido" }]
    });
    expect(preview.accepted).toBe(1);
    expect(preview.rejected).toBe(1);
    expect(preview.rows[1]?.reason).toBe("Campo requerido");
  });

  it("normaliza el contrato de preview CSV del servicio", () => {
    const preview = normalizeImportPreview({
      accepted: [{ row: 2, data: { name: "Profesional" } }],
      rejected: [{ row: 3, reason: "Campo requerido" }],
      summary: { total: 2, accepted: 1, rejected: 1 }
    });
    expect(preview.accepted).toBe(1);
    expect(preview.rejected).toBe(1);
    expect(preview.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
  });
});
