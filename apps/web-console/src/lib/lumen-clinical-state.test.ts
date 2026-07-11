import type { LumenClinicalRecordContent } from "@hyperion/contracts";
import { describe, expect, it } from "vitest";
import {
  lumenApprovalBlockers,
  lumenRecordInteractionState,
  lumenReviewedSectionCount
} from "./lumen-clinical-state.js";

const content: LumenClinicalRecordContent = {
  reasonForVisit: "Control de glaucoma",
  history: "Paciente sintética en seguimiento.",
  visualAcuity: { right: "20/30 cc", left: "20/40 cc" },
  intraocularPressure: { right: "16 mmHg", left: "24 mmHg" },
  biomicroscopy: { right: "Sin hallazgos nuevos", left: "Sin hallazgos nuevos" },
  gonioscopy: { right: "Shaffer III", left: "Shaffer II por confirmar" },
  fundus: { right: "C/D 0.6", left: "C/D 0.8" },
  assessment: [{ description: "Glaucoma primario de ángulo abierto AO", code: "H40.11", confidence: 0.93 }],
  plan: ["Validar conducta con el profesional"],
  uncertainties: [
    {
      field: "gonioscopy.left",
      message: "Confirmar cuadrante superior",
      sourceText: "ángulo dos, confirmar"
    }
  ],
  fieldEvidence: [{ field: "gonioscopy.left", confidence: 0.72, origin: "synthetic_demo", sourceText: "ángulo dos" }]
};

describe("LUMEN clinical UI states", () => {
  it("blocks human approval while uncertainties remain", () => {
    expect(lumenApprovalBlockers(content)).toEqual(["1 dato(s) por confirmar"]);
    expect(lumenRecordInteractionState("draft", content, true)).toBe("blocked_review");
  });

  it("keeps low-confidence evidence after explicit confirmation without re-blocking", () => {
    const confirmed = { ...content, uncertainties: [] };
    expect(confirmed.fieldEvidence[0]?.confidence).toBe(0.72);
    expect(lumenApprovalBlockers(confirmed)).toEqual([]);
    expect(lumenRecordInteractionState("draft", confirmed, true)).toBe("ready_for_approval");
  });

  it("distinguishes read-only, approved and empty states", () => {
    expect(lumenRecordInteractionState("draft", { ...content, uncertainties: [] }, false)).toBe("read_only");
    expect(lumenRecordInteractionState("approved", content, true)).toBe("approved");
    expect(lumenRecordInteractionState(undefined, undefined, true)).toBe("empty");
  });

  it("counts only populated sections without unresolved review", () => {
    expect(lumenReviewedSectionCount(content)).toBe(8);
    expect(lumenReviewedSectionCount({ ...content, uncertainties: [] })).toBe(9);
  });

  it("uses the same required-field blockers as the approval API", () => {
    const incomplete = { ...content, biomicroscopy: { right: null, left: null }, uncertainties: [] };
    expect(lumenApprovalBlockers(incomplete)).toEqual([
      "Biomicroscopía OD obligatoria",
      "Biomicroscopía OI obligatoria"
    ]);
    expect(lumenRecordInteractionState("draft", incomplete, true)).toBe("blocked_review");
    expect(lumenReviewedSectionCount({ ...content, biomicroscopy: { right: "Normal", left: null } })).toBe(7);
  });
});
