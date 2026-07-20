import { describe, expect, it } from "vitest";
import { assertLumenNMinusOneCompatEnabled } from "./lumen-n-minus-one-compatibility.js";

describe("LUMEN N-1 compatibility bridge gate", () => {
  it("is fail-closed unless LUMEN_N1_COMPAT_ENABLED=true", () => {
    expect(() => assertLumenNMinusOneCompatEnabled({})).toThrow(/fail-closed/);
    expect(() => assertLumenNMinusOneCompatEnabled({ LUMEN_N1_COMPAT_ENABLED: "false" })).toThrow(/fail-closed/);
    expect(() => assertLumenNMinusOneCompatEnabled({ LUMEN_N1_COMPAT_ENABLED: "true" })).not.toThrow();
  });
});
