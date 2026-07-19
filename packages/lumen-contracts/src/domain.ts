import { tenantIdSchema } from "@hyperion/platform-contracts";
import { z } from "zod";

const isoDateTime = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().datetime()
);
const isoDateTimeOptional = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : (value ?? undefined)),
  z.string().datetime().optional()
);
const optionalFromNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => value ?? undefined, schema.optional());

export const lumenEncounterStatusSchema = z.enum(["preconsultation", "in_progress", "review", "approved"]);
export const lumenDictationStatusSchema = z.enum(["transcribed", "failed"]);
export const lumenClinicalRecordStatusSchema = z.enum(["draft", "approved"]);
export const lumenTranscriptionSourceSchema = z.enum(["browser_microphone", "authorized_upload"]);
export const lumenProcessingOperationSchema = z.enum(["transcription", "structuring"]);
export const lumenProcessingStatusSchema = z.enum(["processing", "completed", "failed", "cancelled"]);
export const lumenAudioMimeTypeSchema = z.enum([
  "audio/aac",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/wav",
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/x-m4a",
  "audio/x-wav"
]);
export const lumenAudioMaxBytes = 5 * 1024 * 1024;
export const lumenAudioMaxBase64Length = Math.ceil(lumenAudioMaxBytes / 3) * 4;
export const lumenDictationSourceSchema = z.enum([
  "browser_microphone",
  "authorized_upload",
  "manual_entry",
  "synthetic_demo"
]);
export const lumenFieldEvidenceOriginSchema = z.enum(["voice", "voice_reviewed", "manual", "synthetic_demo"]);
export const lumenClinicalFieldSchema = z.enum([
  "reasonForVisit",
  "history",
  "visualAcuity.right",
  "visualAcuity.left",
  "intraocularPressure.right",
  "intraocularPressure.left",
  "biomicroscopy.right",
  "biomicroscopy.left",
  "gonioscopy.right",
  "gonioscopy.left",
  "fundus.right",
  "fundus.left",
  "assessment",
  "plan"
]);

const lumenEyeTextSchema = z.object({ right: z.string().max(2000).nullable(), left: z.string().max(2000).nullable() });
const lumenFieldEvidenceSchema = z.object({
  field: lumenClinicalFieldSchema,
  confidence: z.number().min(0).max(1),
  origin: lumenFieldEvidenceOriginSchema,
  sourceText: z.string().max(2000).nullable()
});

export const lumenClinicalRecordContentSchema = z.object({
  reasonForVisit: z.string().max(4000),
  history: z.string().max(8000),
  visualAcuity: lumenEyeTextSchema,
  intraocularPressure: lumenEyeTextSchema,
  biomicroscopy: lumenEyeTextSchema,
  fundus: lumenEyeTextSchema,
  gonioscopy: lumenEyeTextSchema.default({ right: null, left: null }),
  assessment: z.array(
    z.object({
      description: z.string().min(1).max(2000),
      code: z.string().max(80).nullable(),
      confidence: z.number().min(0).max(1)
    })
  ),
  plan: z.array(z.string().min(1).max(2000)),
  uncertainties: z.array(
    z.object({
      field: z.string().min(1).max(120),
      message: z.string().min(1).max(1000),
      sourceText: z.string().max(2000).nullable()
    })
  ),
  fieldEvidence: z.array(lumenFieldEvidenceSchema).default([])
});

export function retainLumenEvidenceUncertainties(
  content: z.infer<typeof lumenClinicalRecordContentSchema>
): z.infer<typeof lumenClinicalRecordContentSchema> {
  const uncertainFields = new Set(content.uncertainties.map((uncertainty) => uncertainty.field));
  const evidenceUncertainties = content.fieldEvidence
    .filter((evidence) => evidence.confidence < 0.85 && !uncertainFields.has(evidence.field))
    .map((evidence) => ({
      field: evidence.field,
      message: `Confianza ${Math.round(evidence.confidence * 100)} %: requiere confirmación profesional.`,
      sourceText: evidence.sourceText
    }));

  return evidenceUncertainties.length === 0
    ? content
    : { ...content, uncertainties: [...content.uncertainties, ...evidenceUncertainties] };
}

export interface LumenClinicalRequiredFieldBlocker {
  field: z.infer<typeof lumenClinicalFieldSchema>;
  message: string;
}

export function lumenClinicalRequiredFieldBlockers(
  content: z.infer<typeof lumenClinicalRecordContentSchema>
): LumenClinicalRequiredFieldBlocker[] {
  const blockers: LumenClinicalRequiredFieldBlocker[] = [];
  const requireText = (field: LumenClinicalRequiredFieldBlocker["field"], value: string | null, message: string) => {
    if (!value?.trim()) blockers.push({ field, message });
  };

  requireText("reasonForVisit", content.reasonForVisit, "Motivo de consulta obligatorio");
  requireText("history", content.history, "Evolución e historia obligatorias");
  requireText("visualAcuity.right", content.visualAcuity.right, "Agudeza visual OD obligatoria");
  requireText("visualAcuity.left", content.visualAcuity.left, "Agudeza visual OI obligatoria");
  requireText("intraocularPressure.right", content.intraocularPressure.right, "Presión intraocular OD obligatoria");
  requireText("intraocularPressure.left", content.intraocularPressure.left, "Presión intraocular OI obligatoria");
  requireText("biomicroscopy.right", content.biomicroscopy.right, "Biomicroscopía OD obligatoria");
  requireText("biomicroscopy.left", content.biomicroscopy.left, "Biomicroscopía OI obligatoria");
  requireText("gonioscopy.right", content.gonioscopy.right, "Gonioscopía OD obligatoria");
  requireText("gonioscopy.left", content.gonioscopy.left, "Gonioscopía OI obligatoria");
  requireText("fundus.right", content.fundus.right, "Fondo de ojo OD obligatorio");
  requireText("fundus.left", content.fundus.left, "Fondo de ojo OI obligatorio");
  if (content.assessment.length === 0) {
    blockers.push({ field: "assessment", message: "Impresión clínica obligatoria" });
  }
  if (content.plan.length === 0) blockers.push({ field: "plan", message: "Plan clínico obligatorio" });
  return blockers;
}

export const lumenPreconsultationSourceSchema = z.object({
  id: z.string().min(1).max(120),
  type: z.enum(["encounter", "diagnostic_exam", "procedure", "medication", "appointment", "other"]),
  label: z.string().min(1).max(500),
  recordedAt: isoDateTime,
  detail: optionalFromNull(z.string().min(1).max(1000))
});
export const lumenRecentExamSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(240),
  recordedAt: isoDateTime,
  detail: z.string().min(1).max(2000),
  status: z.enum(["available", "pending_review", "reviewed"]),
  sourceId: optionalFromNull(z.string().min(1).max(120))
});
export const lumenTimelineEventSchema = z.object({
  id: z.string().min(1).max(120),
  recordedAt: isoDateTime,
  kind: z.enum(["encounter", "procedure", "diagnostic_exam", "medication", "alert"]),
  title: z.string().min(1).max(500),
  detail: optionalFromNull(z.string().min(1).max(1000)),
  sourceId: optionalFromNull(z.string().min(1).max(120))
});
export const lumenPreconsultationSummarySchema = z.object({
  summaryText: z.string().min(1).max(8000),
  activeDiagnoses: z.array(z.string().min(1).max(500)),
  medications: z.array(z.string().min(1).max(500)),
  alerts: z.array(z.string().min(1).max(1000)),
  alertSourceIds: z.array(z.string().min(1).max(120)).default([]),
  trends: z.array(
    z.object({
      label: z.string().min(1).max(160),
      unit: z.string().max(40),
      points: z.array(z.object({ recordedAt: z.string(), value: z.number() })),
      targetMin: z.number().nullable().optional(),
      targetMax: z.number().nullable().optional()
    })
  ),
  sourceCount: z.number().int().nonnegative(),
  sources: z.array(lumenPreconsultationSourceSchema).default([]),
  recentExams: z.array(lumenRecentExamSchema).default([]),
  timeline: z.array(lumenTimelineEventSchema).default([])
});

export const lumenWorklistEntrySchema = z.object({
  encounterId: z.string().uuid(),
  tenantId: tenantIdSchema,
  patientId: z.string().uuid(),
  siteId: z.string().uuid(),
  patientDisplayName: z.string().min(1),
  patientAge: z.number().int().nonnegative().nullable(),
  professionalName: z.string().min(1),
  siteName: z.string().min(1),
  scheduledAt: isoDateTime,
  status: lumenEncounterStatusSchema,
  isDemo: z.boolean(),
  payer: z.string().min(1).max(240).nullable().default(null),
  documentMasked: z.string().min(1).max(80).nullable().default(null),
  visitReason: z.string().min(1).max(1000).nullable().default(null),
  subspecialty: z.string().min(1).max(240).nullable().default(null)
});
export const lumenDictationSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  encounterId: z.string().uuid(),
  status: lumenDictationStatusSchema,
  transcript: z.string(),
  mimeType: z.string(),
  source: lumenDictationSourceSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  durationSeconds: z.number().int().min(1).max(90).nullable(),
  providerTranscript: z.string().max(20_000).nullable().default(null),
  reviewedAt: z
    .preprocess((value) => (value instanceof Date ? value.toISOString() : value), z.string().datetime().nullable())
    .default(null),
  reviewedBy: z.string().uuid().nullable().default(null),
  processingAttemptId: z.string().uuid().nullable().default(null),
  createdAt: isoDateTime
});
export const lumenClinicalRecordSchema = z.object({
  id: z.string().uuid(),
  tenantId: tenantIdSchema,
  encounterId: z.string().uuid(),
  dictationId: z.string().uuid().nullable(),
  status: lumenClinicalRecordStatusSchema,
  schemaVersion: z.string().min(1),
  content: lumenClinicalRecordContentSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  approvedBy: z.string().uuid().nullable(),
  approvedAt: isoDateTimeOptional,
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});
export const lumenEncounterDetailSchema = z.object({
  encounter: lumenWorklistEntrySchema,
  preconsultation: lumenPreconsultationSummarySchema.nullable(),
  dictations: z.array(lumenDictationSchema),
  clinicalRecord: lumenClinicalRecordSchema.nullable()
});

const lumenAudioBase64Schema = z
  .string()
  .min(20)
  .max(lumenAudioMaxBase64Length)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  .refine((value) => value.length % 4 === 0, "audioBase64 must use canonical base64 padding")
  .refine((value) => {
    const paddingBytes = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    return (value.length / 4) * 3 - paddingBytes <= lumenAudioMaxBytes;
  }, "audioBase64 exceeds the 5 MiB decoded limit");

export const lumenTranscriptionInputSchema = z.object({
  audioBase64: lumenAudioBase64Schema,
  mimeType: lumenAudioMimeTypeSchema,
  source: lumenTranscriptionSourceSchema,
  durationSeconds: z.number().int().min(1).max(90),
  idempotencyKey: z.string().uuid()
});

export const lumenStructureInputSchema = z.object({
  transcript: z
    .string()
    .trim()
    .min(10)
    .max(20_000)
    .refine(
      (value) =>
        !Array.from(value).some((character) => {
          const codePoint = character.codePointAt(0)!;
          return (
            codePoint <= 8 ||
            codePoint === 11 ||
            codePoint === 12 ||
            (codePoint >= 14 && codePoint <= 31) ||
            codePoint === 127
          );
        }),
      "transcript contains unsupported control characters"
    ),
  dictationId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid()
});

export const lumenClinicalRecordPatchSchema = z.object({
  content: lumenClinicalRecordContentSchema
});

export type LumenEncounterStatus = z.infer<typeof lumenEncounterStatusSchema>;
export type LumenTranscriptionSource = z.infer<typeof lumenTranscriptionSourceSchema>;
export type LumenAudioMimeType = z.infer<typeof lumenAudioMimeTypeSchema>;
export type LumenProcessingOperation = z.infer<typeof lumenProcessingOperationSchema>;
export type LumenProcessingStatus = z.infer<typeof lumenProcessingStatusSchema>;
export type LumenDictationSource = z.infer<typeof lumenDictationSourceSchema>;
export type LumenFieldEvidenceOrigin = z.infer<typeof lumenFieldEvidenceOriginSchema>;
export type LumenClinicalField = z.infer<typeof lumenClinicalFieldSchema>;
export type LumenClinicalRecordContent = z.infer<typeof lumenClinicalRecordContentSchema>;
export type LumenPreconsultationSource = z.infer<typeof lumenPreconsultationSourceSchema>;
export type LumenRecentExam = z.infer<typeof lumenRecentExamSchema>;
export type LumenTimelineEvent = z.infer<typeof lumenTimelineEventSchema>;
export type LumenPreconsultationSummary = z.infer<typeof lumenPreconsultationSummarySchema>;
export type LumenWorklistEntry = z.infer<typeof lumenWorklistEntrySchema>;
export type LumenDictation = z.infer<typeof lumenDictationSchema>;
export type LumenClinicalRecord = z.infer<typeof lumenClinicalRecordSchema>;
export type LumenEncounterDetail = z.infer<typeof lumenEncounterDetailSchema>;
