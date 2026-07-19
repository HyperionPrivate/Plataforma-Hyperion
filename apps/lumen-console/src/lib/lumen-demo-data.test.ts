import { describe, expect, it } from "vitest";
import {
  filterLumenLabs,
  LUMEN_LABS,
  lumenLabCaptureError,
  lumenInvoiceStatusLabel,
  lumenLabStatusLabel,
  type LumenInvoiceStatus,
  type LumenLabStatus
} from "./lumen-demo-data.js";

describe("LUMEN guided demo data", () => {
  it("filters the laboratory worklist by status and normalized search", () => {
    expect(filterLumenLabs(LUMEN_LABS, "review", "").map((item) => item.id)).toEqual(["lab-hba1c"]);
    expect(filterLumenLabs(LUMEN_LABS, "all", "maría").map((item) => item.id)).toEqual(["lab-hba1c"]);
    expect(filterLumenLabs(LUMEN_LABS, "all", "topografía").map((item) => item.id)).toEqual(["lab-topography"]);
  });

  it("uses explicit operational labels for every status", () => {
    const labStatuses: LumenLabStatus[] = ["pending", "review", "processing", "validated"];
    const invoiceStatuses: LumenInvoiceStatus[] = ["validated", "processing", "retained"];
    expect(labStatuses.map(lumenLabStatusLabel)).toEqual([
      "Por validar",
      "Requiere revisión",
      "Procesando",
      "Validado"
    ]);
    expect(invoiceStatuses.map(lumenInvoiceStatusLabel)).toEqual(["Validada", "En proceso", "RIPS retenido"]);
  });

  it("keeps local laboratory capture bounded and offline", () => {
    expect(lumenLabCaptureError("image/jpeg", 2048)).toBeUndefined();
    expect(lumenLabCaptureError("application/pdf", 8 * 1024 * 1024)).toBeUndefined();
    expect(lumenLabCaptureError("text/plain", 20)).toBe("Usa una imagen o un PDF.");
    expect(lumenLabCaptureError("image/png", 0)).toContain("1 byte");
    expect(lumenLabCaptureError("image/png", 8 * 1024 * 1024 + 1)).toContain("8 MiB");
  });
});
