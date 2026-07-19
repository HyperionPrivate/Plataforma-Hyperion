import { accessPrincipalSchema } from "@hyperion/platform-contracts";
import { describe, expect, it } from "vitest";
import {
  findLumenGrant,
  lumenCapabilityForMethod,
  lumenCellComponentSchema,
  lumenClinicalRecordContentSchema,
  lumenClinicalRequiredFieldBlockers,
  lumenConsoleRequestHeaderValue,
  lumenGrantAllows,
  lumenProductId,
  lumenStructureInputSchema,
  lumenTranscriptionInputSchema,
  retainLumenEvidenceUncertainties
} from "./index.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";

describe("LUMEN provider-owned edge contracts v1", () => {
  it("accepts only a tenant-scoped LUMEN grant with known roles and capabilities", () => {
    const principal = accessPrincipalSchema.parse({
      operator: {
        id: "22222222-2222-4222-8222-222222222222",
        email: "clinician@example.test",
        displayName: "Clinical Operator",
        role: "advisor"
      },
      grants: [
        {
          tenantId: TENANT_ID,
          productId: lumenProductId,
          roles: ["advisor"],
          capabilities: ["lumen:read", "lumen:write"],
          active: true
        }
      ]
    });

    const grant = findLumenGrant(principal, TENANT_ID);
    expect(grant?.productId).toBe("LUMEN");
    expect(grant && lumenGrantAllows(grant, "lumen:write")).toBe(true);
  });

  it("defines one closed component namespace and method-derived capabilities", () => {
    expect(lumenCellComponentSchema.options).toEqual(["lumen"]);
    expect(lumenConsoleRequestHeaderValue).toBe("lumen-console");
    expect(lumenCapabilityForMethod("HEAD")).toBe("lumen:read");
    expect(lumenCapabilityForMethod("POST")).toBe("lumen:write");
  });

  it("owns the bounded audio and structuring inputs used by the LUMEN service", () => {
    const idempotencyKey = "33333333-3333-4333-8333-333333333333";
    expect(
      lumenTranscriptionInputSchema.safeParse({
        audioBase64: Buffer.from("clinically relevant audio").toString("base64"),
        mimeType: "audio/wav",
        source: "browser_microphone",
        durationSeconds: 30,
        idempotencyKey
      }).success
    ).toBe(true);
    expect(
      lumenTranscriptionInputSchema.safeParse({
        audioBase64: Buffer.from("clinically relevant audio").toString("base64"),
        mimeType: "audio/wav",
        source: "synthetic_demo",
        durationSeconds: 30,
        idempotencyKey
      }).success
    ).toBe(false);
    expect(
      lumenStructureInputSchema.safeParse({
        transcript: "Hallazgo clínico válido y revisable.",
        idempotencyKey
      }).success
    ).toBe(true);
    expect(lumenStructureInputSchema.safeParse({ transcript: "Hallazgo\u0000 inválido", idempotencyKey }).success).toBe(
      false
    );
  });

  it("keeps evidence uncertainty and approval blockers in the provider contract", () => {
    const content = lumenClinicalRecordContentSchema.parse({
      reasonForVisit: "Control",
      history: "",
      visualAcuity: { right: "20/20", left: "20/20" },
      intraocularPressure: { right: "14", left: "15" },
      biomicroscopy: { right: "Normal", left: "Normal" },
      fundus: { right: "Normal", left: "Normal" },
      gonioscopy: { right: "Abierto", left: "Abierto" },
      assessment: [],
      plan: [],
      uncertainties: [],
      fieldEvidence: [{ field: "fundus.left", confidence: 0.7, origin: "voice", sourceText: "hallazgo dudoso" }]
    });

    const retained = retainLumenEvidenceUncertainties(content);
    expect(retained.uncertainties).toHaveLength(1);
    expect(lumenClinicalRequiredFieldBlockers(retained).map((entry) => entry.field)).toEqual([
      "history",
      "assessment",
      "plan"
    ]);
  });
});
