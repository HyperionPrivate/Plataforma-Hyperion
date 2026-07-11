import type { LumenClinicalRecordContent } from "@hyperion/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  clinicalEvidenceIssues,
  DeepSeekClinicalStructurer,
  normalizeStructuredClinicalContent,
  OpenAiClinicalTranscriber,
  ProviderNotConfiguredError
} from "./clinical-ai.js";

const TRANSCRIPT =
  "Control de presión intraocular. Paciente refiere visión estable. Agudeza visual OD 20/20 y OI 20/40. " +
  "PIO 14 mmHg OD y 16 mmHg OI. Fondo de ojo OI con membrana epirretiniana. " +
  "Impresión: membrana epirretiniana OI. Control en cuatro semanas.";

const CONTENT: LumenClinicalRecordContent = {
  reasonForVisit: "Control de presión intraocular",
  history: "Paciente refiere visión estable.",
  visualAcuity: { right: "20/20", left: "20/40" },
  intraocularPressure: { right: "14 mmHg", left: "16 mmHg" },
  biomicroscopy: { right: null, left: null },
  fundus: { right: null, left: "Membrana epirretiniana" },
  gonioscopy: { right: null, left: null },
  assessment: [{ description: "Membrana epirretiniana OI", code: null, confidence: 0.9 }],
  plan: ["Control en cuatro semanas"],
  uncertainties: [],
  fieldEvidence: [
    { field: "reasonForVisit", confidence: 0.98, origin: "voice", sourceText: "Control de presión intraocular" },
    { field: "history", confidence: 0.96, origin: "voice", sourceText: "Paciente refiere visión estable" },
    { field: "visualAcuity.right", confidence: 0.98, origin: "voice", sourceText: "OD 20/20" },
    { field: "visualAcuity.left", confidence: 0.98, origin: "voice", sourceText: "OI 20/40" },
    { field: "intraocularPressure.right", confidence: 0.98, origin: "voice", sourceText: "PIO 14 mmHg OD" },
    { field: "intraocularPressure.left", confidence: 0.98, origin: "voice", sourceText: "16 mmHg OI" },
    { field: "fundus.left", confidence: 0.92, origin: "voice", sourceText: "membrana epirretiniana" },
    {
      field: "assessment",
      confidence: 0.9,
      origin: "voice",
      sourceText: "Impresión: membrana epirretiniana OI"
    },
    { field: "plan", confidence: 0.93, origin: "voice", sourceText: "Control en cuatro semanas" }
  ]
};

describe("LUMEN clinical providers", () => {
  it("transcribes short audio through the configured provider", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ text: "PIO catorce en ojo derecho" }), { status: 200 })
    );
    const provider = new OpenAiClinicalTranscriber({ apiKey: "test-key", fetchImpl: fetchImpl as typeof fetch });
    const result = await provider.transcribe(Buffer.from("audio").toString("base64"), "audio/webm");

    expect(result.transcript).toContain("PIO");
    expect(result.provider).toBe("openai");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails explicitly when STT is not configured", async () => {
    const provider = new OpenAiClinicalTranscriber({ apiKey: "" });
    await expect(provider.transcribe(Buffer.from("audio").toString("base64"), "audio/webm")).rejects.toBeInstanceOf(
      ProviderNotConfiguredError
    );
  });

  it("validates DeepSeek structured output against the clinical contract", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-test",
            choices: [
              {
                message: {
                  tool_calls: [{ function: { name: "structure_lumen_record", arguments: JSON.stringify(CONTENT) } }]
                }
              }
            ]
          }),
          { status: 200 }
        )
    );
    const provider = new DeepSeekClinicalStructurer({ apiKey: "test-key", fetchImpl: fetchImpl as typeof fetch });
    const result = await provider.structure(TRANSCRIPT);

    expect(result.content.intraocularPressure.right).toBe("14 mmHg");
    expect(result.content.uncertainties).toEqual([]);
    expect(result.model).toBe("deepseek-test");
  });

  it("keeps low-confidence evidence pending and pins its real manual origin", async () => {
    const content = {
      ...CONTENT,
      gonioscopy: { right: null, left: "Ángulo abierto; grado por confirmar" },
      uncertainties: [],
      fieldEvidence: [
        ...CONTENT.fieldEvidence,
        {
          field: "gonioscopy.left",
          confidence: 0.72,
          origin: "voice",
          sourceText: "ángulo abierto grado..."
        }
      ]
    };
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "deepseek-test",
            choices: [
              {
                message: {
                  tool_calls: [{ function: { name: "structure_lumen_record", arguments: JSON.stringify(content) } }]
                }
              }
            ]
          }),
          { status: 200 }
        )
    );
    const provider = new DeepSeekClinicalStructurer({ apiKey: "test-key", fetchImpl: fetchImpl as typeof fetch });

    const result = await provider.structure(`${TRANSCRIPT} Gonioscopía: ángulo abierto grado por confirmar.`, "manual");

    expect(result.content.fieldEvidence.every((evidence) => evidence.origin === "manual")).toBe(true);
    expect(result.content.uncertainties).toEqual([
      expect.objectContaining({ field: "gonioscopy.left", sourceText: "ángulo abierto grado..." })
    ]);
  });

  it("blocks populated AI fields whose evidence is absent or not literal", () => {
    const forged: LumenClinicalRecordContent = {
      ...CONTENT,
      fieldEvidence: CONTENT.fieldEvidence
        .filter((evidence) => evidence.field !== "plan")
        .map((evidence) =>
          evidence.field === "intraocularPressure.left"
            ? { ...evidence, sourceText: "PIO treinta y dos en ojo izquierdo" }
            : evidence
        )
    };

    const normalized = normalizeStructuredClinicalContent(forged, TRANSCRIPT, "synthetic_demo");

    expect(normalized.fieldEvidence.every((evidence) => evidence.origin === "synthetic_demo")).toBe(true);
    expect(normalized.fieldEvidence.some((evidence) => evidence.field === "intraocularPressure.left")).toBe(false);
    expect(normalized.uncertainties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "intraocularPressure.left" }),
        expect.objectContaining({ field: "plan" })
      ])
    );
  });

  it("accepts only server-owned manual evidence as a human override", () => {
    const withoutPlanEvidence: LumenClinicalRecordContent = {
      ...CONTENT,
      fieldEvidence: CONTENT.fieldEvidence.filter((evidence) => evidence.field !== "plan")
    };
    expect(clinicalEvidenceIssues(withoutPlanEvidence, TRANSCRIPT, "voice")).toContainEqual({
      field: "plan",
      reason: "missing"
    });

    const reviewed: LumenClinicalRecordContent = {
      ...withoutPlanEvidence,
      fieldEvidence: [
        ...withoutPlanEvidence.fieldEvidence,
        { field: "plan", confidence: 1, origin: "manual", sourceText: null }
      ]
    };
    expect(clinicalEvidenceIssues(reviewed, TRANSCRIPT, "voice")).toEqual([]);
  });
});
