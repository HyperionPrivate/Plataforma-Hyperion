import type { LumenWorklistEntry } from "@hyperion/lumen-contracts";
import { describe, expect, it } from "vitest";
import { clinicalFacilitiesFromWorklist } from "./context.js";

function row(siteId: string, siteName: string, encounterId: string): LumenWorklistEntry {
  return {
    encounterId,
    tenantId: "00000000-0000-4000-8000-000000000001",
    patientId: "00000000-0000-4000-8000-000000000002",
    siteId,
    patientDisplayName: "Paciente sintético",
    patientAge: 42,
    professionalName: "Profesional demo",
    siteName,
    scheduledAt: "2026-07-11T14:00:00.000Z",
    status: "preconsultation",
    isDemo: true,
    payer: null,
    documentMasked: null,
    visitReason: null,
    subspecialty: null
  };
}

describe("clinical facility context", () => {
  it("derives a de-duplicated clinical catalog from the LUMEN worklist", () => {
    const first = "00000000-0000-4000-8000-000000000010";
    const second = "00000000-0000-4000-8000-000000000020";
    expect(
      clinicalFacilitiesFromWorklist([
        row(second, "Sede norte", "00000000-0000-4000-8000-000000000101"),
        row(first, "Sede central", "00000000-0000-4000-8000-000000000102"),
        row(first, "Sede central", "00000000-0000-4000-8000-000000000103")
      ])
    ).toEqual([
      { id: first, name: "Sede central" },
      { id: second, name: "Sede norte" }
    ]);
  });
});
