import {
  lumenClinicalRecordContentSchema,
  retainLumenEvidenceUncertainties,
  type LumenClinicalField,
  type LumenClinicalRecordContent,
  type LumenFieldEvidenceOrigin
} from "@hyperion/lumen-contracts";
import { createHash } from "node:crypto";
import { z } from "zod";

export class ProviderNotConfiguredError extends Error {
  constructor(provider: string) {
    super(`${provider} is not configured`);
    this.name = "ProviderNotConfiguredError";
  }
}

export class ProviderRequestError extends Error {
  constructor(provider: string, detail?: string) {
    super(`${provider} request failed${detail ? `: ${detail}` : ""}`);
    this.name = "ProviderRequestError";
  }
}

export interface ClinicalStructureResult {
  content: LumenClinicalRecordContent;
  provider: string;
  model: string;
  requestIdHash?: string | null;
  traceIdHash?: string | null;
}

export interface ClinicalStructurer {
  readonly name: string;
  readonly model: string;
  isConfigured(): boolean;
  structure(
    transcript: string,
    evidenceOrigin?: LumenFieldEvidenceOrigin,
    signal?: AbortSignal
  ): Promise<ClinicalStructureResult>;
}

export interface ClinicalEvidenceIssue {
  field: LumenClinicalField;
  reason: "missing" | "not_literal" | "low_confidence";
}

export const LUMEN_CLINICAL_FIELDS = [
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
] as const satisfies readonly LumenClinicalField[];

export function normalizeStructuredClinicalContent(
  content: LumenClinicalRecordContent,
  transcript: string,
  evidenceOrigin: LumenFieldEvidenceOrigin
): LumenClinicalRecordContent {
  const forcedEvidence = content.fieldEvidence.map((evidence) => ({ ...evidence, origin: evidenceOrigin }));
  const literalEvidence = forcedEvidence.filter(
    (evidence) => evidence.sourceText !== null && isLiteralTranscriptExcerpt(transcript, evidence.sourceText)
  );
  const normalized: LumenClinicalRecordContent = {
    ...content,
    uncertainties: [...content.uncertainties],
    fieldEvidence: literalEvidence
  };
  const uncertainFields = new Set(normalized.uncertainties.map((uncertainty) => uncertainty.field));

  for (const issue of clinicalEvidenceIssues(normalized, transcript, evidenceOrigin, false)) {
    if (issue.reason === "low_confidence") continue;
    if (uncertainFields.has(issue.field)) continue;
    normalized.uncertainties.push({
      field: issue.field,
      message:
        issue.reason === "missing"
          ? "El campo estructurado no tiene evidencia literal del transcript; requiere revisión profesional."
          : "La evidencia reportada no coincide literalmente con el transcript; requiere corrección profesional.",
      sourceText: null
    });
    uncertainFields.add(issue.field);
  }

  return retainLumenEvidenceUncertainties(normalized);
}

export function clinicalEvidenceIssues(
  content: LumenClinicalRecordContent,
  transcript: string,
  evidenceOrigin: LumenFieldEvidenceOrigin,
  allowHumanReviewEvidence = true
): ClinicalEvidenceIssue[] {
  const issues: ClinicalEvidenceIssue[] = [];
  for (const field of LUMEN_CLINICAL_FIELDS) {
    if (!lumenClinicalFieldHasValue(content, field)) continue;
    const candidates = content.fieldEvidence.filter((evidence) => evidence.field === field);
    if (candidates.length === 0) {
      issues.push({ field, reason: "missing" });
      continue;
    }
    const grounded = candidates.filter((evidence) => {
      if (
        allowHumanReviewEvidence &&
        evidence.origin === "manual" &&
        evidence.confidence === 1 &&
        evidence.sourceText === null
      ) {
        return true;
      }
      return (
        evidence.origin === evidenceOrigin &&
        evidence.sourceText !== null &&
        isLiteralTranscriptExcerpt(transcript, evidence.sourceText)
      );
    });
    if (grounded.length === 0) {
      issues.push({ field, reason: "not_literal" });
    } else if (!grounded.some((evidence) => evidence.confidence >= 0.85)) {
      issues.push({ field, reason: "low_confidence" });
    }
  }
  return issues;
}

export function changedLumenClinicalFields(
  previous: LumenClinicalRecordContent,
  next: LumenClinicalRecordContent
): LumenClinicalField[] {
  return LUMEN_CLINICAL_FIELDS.filter(
    (field) =>
      JSON.stringify(lumenClinicalFieldValue(previous, field)) !== JSON.stringify(lumenClinicalFieldValue(next, field))
  );
}

function lumenClinicalFieldHasValue(content: LumenClinicalRecordContent, field: LumenClinicalField): boolean {
  const value = lumenClinicalFieldValue(content, field);
  if (typeof value === "string") return Boolean(value.trim());
  return Array.isArray(value) && value.length > 0;
}

function lumenClinicalFieldValue(content: LumenClinicalRecordContent, field: LumenClinicalField): unknown {
  if (field === "reasonForVisit" || field === "history" || field === "assessment" || field === "plan") {
    return content[field];
  }
  const [section, eye] = field.split(".") as [
    "visualAcuity" | "intraocularPressure" | "biomicroscopy" | "gonioscopy" | "fundus",
    "right" | "left"
  ];
  return content[section][eye];
}

function isLiteralTranscriptExcerpt(transcript: string, sourceText: string): boolean {
  const normalizedTranscript = normalizeClinicalText(transcript);
  const normalizedSource = normalizeClinicalText(sourceText);
  return normalizedSource.length > 0 && normalizedTranscript.includes(normalizedSource);
}

function normalizeClinicalText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const deepSeekResponseSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                function: z.object({ name: z.string(), arguments: z.string() })
              })
            )
            .optional()
        })
      })
    )
    .min(1)
});

export class DeepSeekClinicalStructurer implements ClinicalStructurer {
  readonly name = "deepseek";
  readonly model: string;
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey?: string; model?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY?.trim();
    this.model = options.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
    this.baseUrl = (options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async structure(
    transcript: string,
    evidenceOrigin: LumenFieldEvidenceOrigin = "voice",
    signal?: AbortSignal
  ): Promise<ClinicalStructureResult> {
    if (!this.apiKey) throw new ProviderNotConfiguredError("DeepSeek");

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: `Eres un estructurador documental de oftalmologia. Usa solamente el transcript. No diagnostiques, no prescribas y no completes datos ausentes. Conserva lateralidad OD/OI/AO. Un dato ausente debe ser null o lista vacia. Cada fieldEvidence debe citar texto literal del transcript y usar exactamente origin=${evidenceOrigin}. No inventes precision ni confianza alta: usa una confianza conservadora basada solo en la claridad del texto y su mapeo al campo. Toda evidencia con confianza menor a 0.85 debe conservarse tambien en uncertainties para confirmacion profesional. Devuelve exclusivamente la llamada de herramienta solicitada.`
            },
            { role: "user", content: transcript }
          ],
          tools: [clinicalRecordTool],
          tool_choice: { type: "function", function: { name: "structure_lumen_record" } },
          thinking: { type: "disabled" },
          stream: false
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)
      });
    } catch (error) {
      throw new ProviderRequestError("DeepSeek", sanitizeProviderError(error));
    }

    if (!response.ok) throw new ProviderRequestError("DeepSeek", `status ${response.status}`);
    const payload = deepSeekResponseSchema.parse(await response.json());
    const message = payload.choices[0]!.message;
    const raw = message.tool_calls?.find((call) => call.function.name === "structure_lumen_record")?.function.arguments;
    const candidate = raw ?? extractJson(message.content ?? "");
    if (!candidate) throw new ProviderRequestError("DeepSeek", "structured output missing");

    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      throw new ProviderRequestError("DeepSeek", "structured output is not JSON");
    }

    const parsed = lumenClinicalRecordContentSchema.safeParse(json);
    if (!parsed.success) throw new ProviderRequestError("DeepSeek", "structured output failed validation");
    const content = normalizeStructuredClinicalContent(parsed.data, transcript, evidenceOrigin);
    return {
      content,
      provider: this.name,
      model: payload.model ?? this.model,
      requestIdHash: hashOpaqueIdentifier(response.headers.get("x-request-id") ?? response.headers.get("request-id")),
      traceIdHash: hashOpaqueIdentifier(response.headers.get("x-trace-id"))
    };
  }
}

const nullableEyeText = {
  type: "object",
  additionalProperties: false,
  properties: { right: { type: ["string", "null"] }, left: { type: ["string", "null"] } },
  required: ["right", "left"]
};

const clinicalRecordTool = {
  type: "function",
  function: {
    name: "structure_lumen_record",
    description: "Estructura un dictado oftalmologico sin inferir datos ausentes.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasonForVisit: { type: "string" },
        history: { type: "string" },
        visualAcuity: nullableEyeText,
        intraocularPressure: nullableEyeText,
        biomicroscopy: nullableEyeText,
        fundus: nullableEyeText,
        gonioscopy: nullableEyeText,
        assessment: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              description: { type: "string" },
              code: { type: ["string", "null"] },
              confidence: { type: "number", minimum: 0, maximum: 1 }
            },
            required: ["description", "code", "confidence"]
          }
        },
        plan: { type: "array", items: { type: "string" } },
        uncertainties: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              field: { type: "string" },
              message: { type: "string" },
              sourceText: { type: ["string", "null"] }
            },
            required: ["field", "message", "sourceText"]
          }
        },
        fieldEvidence: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              field: {
                type: "string",
                enum: [
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
                ]
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              origin: { type: "string", enum: ["voice", "voice_reviewed", "manual", "synthetic_demo"] },
              sourceText: { type: ["string", "null"] }
            },
            required: ["field", "confidence", "origin", "sourceText"]
          }
        }
      },
      required: [
        "reasonForVisit",
        "history",
        "visualAcuity",
        "intraocularPressure",
        "biomicroscopy",
        "fundus",
        "gonioscopy",
        "assessment",
        "plan",
        "uncertainties",
        "fieldEvidence"
      ]
    }
  }
};

function extractJson(text: string): string | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  return match?.[0];
}

function sanitizeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 160);
}

function hashOpaqueIdentifier(value: string | null): string | null {
  const identifier = value?.trim();
  return identifier ? createHash("sha256").update(identifier).digest("hex") : null;
}
