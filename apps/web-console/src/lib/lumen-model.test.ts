import { describe, expect, it } from "vitest";
import { ApiError } from "./api.js";
import { lumenErrorMessage } from "./lumen-model.js";

describe("LUMEN UI errors", () => {
  it("translates provider readiness failures", () => {
    expect(lumenErrorMessage(new ApiError(503, "Clinical transcription provider is not configured"))).toContain(
      "transcripción clínica"
    );
    expect(lumenErrorMessage(new ApiError(503, "Clinical structuring provider is not configured"))).toContain(
      "estructuración clínica"
    );
  });

  it("does not expose provider diagnostics as user-facing English", () => {
    expect(lumenErrorMessage(new Error("OpenAI STT request failed: status 429"))).toBe(
      "El proveedor de transcripción no respondió. Intenta nuevamente con un audio corto."
    );
    expect(lumenErrorMessage(new Error("DeepSeek request failed: status 500"))).toBe(
      "El proveedor de estructuración no respondió. Conserva el transcript e intenta nuevamente."
    );
  });
});
