import { describe, expect, it } from "vitest";
import { readAnalyticsCoverageNotice } from "../src/pages/NovaPage.js";

describe("NOVA agency analytics coverage messaging", () => {
  it("makes the forward-only cutover explicit", () => {
    expect(
      readAnalyticsCoverageNotice({
        status: "complete_since_cutover",
        coverageFrom: "2026-07-23",
        appliedAt: "2026-07-22T19:00:00.000Z"
      })
    ).toContain("completo desde 2026-07-23");
  });

  it("does not present a mismatched series as empty or complete", () => {
    expect(
      readAnalyticsCoverageNotice({
        status: "partial",
        coverageFrom: "2026-07-23",
        mismatchedRows: 1
      })
    ).toContain("backfill verificado");
  });
});
