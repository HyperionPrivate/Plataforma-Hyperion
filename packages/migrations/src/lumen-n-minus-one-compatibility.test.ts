import { describe, expect, it } from "vitest";
import { assertLumenNMinusOneCompatEnabled } from "./lumen-n-minus-one-compatibility.js";

describe("LUMEN N-1 compatibility bridge gate", () => {
  it("is permanently retired outside vitest rehearsals (DEBT-025)", () => {
    expect(() => assertLumenNMinusOneCompatEnabled({})).toThrow(/permanently retired/);
    expect(() => assertLumenNMinusOneCompatEnabled({ LUMEN_N1_COMPAT_ENABLED: "true" })).toThrow(/permanently retired/);
    expect(() =>
      assertLumenNMinusOneCompatEnabled({
        VITEST: "true",
        HYPERION_LUMEN_N1_TEST_REHEARSAL: "1"
      })
    ).not.toThrow();
  });
});
