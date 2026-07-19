import type { LumenPreconsultationSummary } from "@hyperion/lumen-contracts";
import { describe, expect, it } from "vitest";
import {
  lumenAlertSource,
  lumenSummarySourceById,
  lumenTrendDomain,
  lumenTrendTargetLabel
} from "./lumen-preconsultation.js";

const summary: LumenPreconsultationSummary = {
  summaryText: "Resumen sintético",
  activeDiagnoses: [],
  medications: [],
  alerts: ["Alerta A", "Alerta B"],
  alertSourceIds: ["source-b", "source-a"],
  trends: [
    {
      label: "PIO OD",
      unit: "mmHg",
      points: [{ recordedAt: "2026-01-01", value: 16 }],
      targetMin: 12,
      targetMax: 18
    },
    {
      label: "PIO OI",
      unit: "mmHg",
      points: [{ recordedAt: "2026-01-01", value: 22 }],
      targetMax: 19
    }
  ],
  sourceCount: 2,
  sources: [
    { id: "source-a", type: "encounter", label: "Control A", recordedAt: "2026-01-01T12:00:00.000Z" },
    { id: "source-b", type: "diagnostic_exam", label: "Examen B", recordedAt: "2026-01-02T12:00:00.000Z" }
  ],
  recentExams: [],
  timeline: []
};

describe("LUMEN preconsultation provenance", () => {
  it("resolves alerts by their explicit source ids, never by array position", () => {
    expect(lumenAlertSource(summary, 0)?.id).toBe("source-b");
    expect(lumenAlertSource(summary, 1)?.id).toBe("source-a");
    expect(lumenAlertSource(summary, 2)).toBeUndefined();
    expect(lumenSummarySourceById(summary, "missing")).toBeUndefined();
  });

  it("includes both eyes and optional targets in the chart domain", () => {
    expect(lumenTrendDomain(summary.trends)).toEqual({ min: 10, max: 24 });
    expect(lumenTrendTargetLabel(summary.trends[0]!)).toBe("12–18 mmHg");
    expect(lumenTrendTargetLabel(summary.trends[1]!)).toBe("≤ 19 mmHg");
  });
});
