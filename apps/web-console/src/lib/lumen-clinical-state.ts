import { lumenClinicalRequiredFieldBlockers, type LumenClinicalRecordContent } from "@hyperion/contracts";

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

export function lumenApprovalBlockers(content: LumenClinicalRecordContent): string[] {
  const blockers = lumenClinicalRequiredFieldBlockers(content).map((blocker) => blocker.message);
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
