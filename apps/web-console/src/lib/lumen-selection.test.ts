import type { LumenWorklistEntry } from "@hyperion/contracts";
import { describe, expect, it } from "vitest";
import { isCurrentLumenEncounter, lumenWorklistForSite, resolveLumenEncounterSelection } from "./lumen-selection.js";

function entry(encounterId: string, siteId: string): LumenWorklistEntry {
  return {
    encounterId,
    tenantId: "00000000-0000-4000-8000-000000000001",
    patientId: "00000000-0000-4000-8000-000000000002",
    siteId,
    patientDisplayName: "Paciente sintético",
    patientAge: 42,
    professionalName: "Profesional demo",
    siteName: "Sede demo",
    scheduledAt: "2026-07-11T14:00:00.000Z",
    status: "preconsultation",
    isDemo: true,
    payer: null,
    documentMasked: null,
    visitReason: null,
    subspecialty: null
  };
}

describe("LUMEN encounter selection", () => {
  const siteA = "00000000-0000-4000-8000-000000000010";
  const siteB = "00000000-0000-4000-8000-000000000020";
  const rows = [
    entry("00000000-0000-4000-8000-000000000101", siteA),
    entry("00000000-0000-4000-8000-000000000102", siteB)
  ];

  it("filters by the site identifier rather than the display name", () => {
    expect(lumenWorklistForSite(rows, siteB).map((item) => item.encounterId)).toEqual([
      "00000000-0000-4000-8000-000000000102"
    ]);
    expect(lumenWorklistForSite(rows, "all")).toHaveLength(2);
  });

  it("honours a valid URL encounter and falls back within the visible site", () => {
    const visible = lumenWorklistForSite(rows, siteA);
    expect(resolveLumenEncounterSelection(visible, rows[0]?.encounterId)).toBe(rows[0]?.encounterId);
    expect(resolveLumenEncounterSelection(visible, rows[1]?.encounterId)).toBe(rows[0]?.encounterId);
    expect(resolveLumenEncounterSelection([], rows[0]?.encounterId)).toBeUndefined();
  });

  it("prevents an async result from being applied to another encounter", () => {
    expect(isCurrentLumenEncounter(rows[0]!.encounterId, rows[0]!.encounterId)).toBe(true);
    expect(isCurrentLumenEncounter(rows[0]!.encounterId, rows[1]!.encounterId)).toBe(false);
  });
});
