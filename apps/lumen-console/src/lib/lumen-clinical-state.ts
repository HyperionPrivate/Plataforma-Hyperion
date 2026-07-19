import type { LumenClinicalRecordContent } from "@hyperion/lumen-contracts";

export const LUMEN_CLINICAL_SECTION_KEYS = [
  "reasonForVisit",
  "history",
  "visualAcuity",
  "intraocularPressure",
  "biomicroscopy",
  "gonioscopy",
  "fundus",
  "assessment",
  "plan"
] as const;

export type LumenClinicalSectionKey = (typeof LUMEN_CLINICAL_SECTION_KEYS)[number];

function requiredFieldBlockers(content: LumenClinicalRecordContent): string[] {
  const blockers: string[] = [];
  const requireText = (value: string | null, message: string) => {
    if (!value?.trim()) blockers.push(message);
  };

  requireText(content.reasonForVisit, "Motivo de consulta obligatorio");
  requireText(content.history, "Evolución e historia obligatorias");
  requireText(content.visualAcuity.right, "Agudeza visual OD obligatoria");
  requireText(content.visualAcuity.left, "Agudeza visual OI obligatoria");
  requireText(content.intraocularPressure.right, "Presión intraocular OD obligatoria");
  requireText(content.intraocularPressure.left, "Presión intraocular OI obligatoria");
  requireText(content.biomicroscopy.right, "Biomicroscopía OD obligatoria");
  requireText(content.biomicroscopy.left, "Biomicroscopía OI obligatoria");
  requireText(content.gonioscopy.right, "Gonioscopía OD obligatoria");
  requireText(content.gonioscopy.left, "Gonioscopía OI obligatoria");
  requireText(content.fundus.right, "Fondo de ojo OD obligatorio");
  requireText(content.fundus.left, "Fondo de ojo OI obligatorio");
  if (content.assessment.length === 0) blockers.push("Impresión clínica obligatoria");
  if (content.plan.length === 0) blockers.push("Plan clínico obligatorio");
  return blockers;
}

export function lumenApprovalBlockers(content: LumenClinicalRecordContent): string[] {
  const blockers = requiredFieldBlockers(content);
  if (content.assessment.some((entry) => !entry.description.trim())) blockers.push("Impresión clínica incompleta");
  if (content.uncertainties.length > 0) blockers.push(`${content.uncertainties.length} dato(s) por confirmar`);
  return blockers;
}

export function lumenSectionHasValue(content: LumenClinicalRecordContent, field: LumenClinicalSectionKey): boolean {
  if (field === "reasonForVisit" || field === "history") return Boolean(content[field].trim());
  if (field === "assessment") return content.assessment.some((entry) => Boolean(entry.description.trim()));
  if (field === "plan") return content.plan.length > 0;
  return Boolean(content[field].right?.trim() && content[field].left?.trim());
}

export function lumenReviewedSectionCount(content: LumenClinicalRecordContent): number {
  return LUMEN_CLINICAL_SECTION_KEYS.filter(
    (key) =>
      lumenSectionHasValue(content, key) &&
      !content.uncertainties.some((uncertainty) => uncertainty.field === key || uncertainty.field.startsWith(`${key}.`))
  ).length;
}

export function lumenRecordInteractionState(
  status: "draft" | "approved" | undefined,
  content: LumenClinicalRecordContent | undefined,
  canWrite: boolean
): "empty" | "read_only" | "approved" | "blocked_review" | "ready_for_approval" {
  if (!status || !content) return "empty";
  if (status === "approved") return "approved";
  if (!canWrite) return "read_only";
  return lumenApprovalBlockers(content).length > 0 ? "blocked_review" : "ready_for_approval";
}
