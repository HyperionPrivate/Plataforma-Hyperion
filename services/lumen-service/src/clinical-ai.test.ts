import { describe, expect, it, vi } from "vitest";
import { DeepSeekClinicalStructurer, OpenAiClinicalTranscriber, ProviderNotConfiguredError } from "./clinical-ai.js";

const CONTENT = {
  reasonForVisit: "Control de presión intraocular",
  history: "Paciente refiere visión estable.",
  visualAcuity: { right: "20/20", left: "20/40" },
  intraocularPressure: { right: "14 mmHg", left: "16 mmHg" },
  biomicroscopy: { right: null, left: null },
  fundus: { right: null, left: "Membrana epirretiniana" },
  assessment: [{ description: "Membrana epirretiniana OI", code: null, confidence: 0.9 }],
  plan: ["Control en cuatro semanas"],
  uncertainties: []
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
    const result = await provider.structure("Paciente en control, PIO catorce OD y dieciseis OI.");

    expect(result.content.intraocularPressure.right).toBe("14 mmHg");
    expect(result.model).toBe("deepseek-test");
  });
});
