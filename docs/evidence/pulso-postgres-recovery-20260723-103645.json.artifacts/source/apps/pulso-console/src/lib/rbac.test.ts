import { describe, expect, it } from "vitest";
import { can } from "./rbac.js";

describe("PULSO RBAC", () => {
  it("allows an advisor to operate but not configure", () => {
    expect(can("advisor", "view:operation")).toBe(true);
    expect(can("advisor", "write:config")).toBe(false);
  });
  it("keeps auditors read-only", () => {
    expect(can("auditor", "view:agenda")).toBe(true);
    expect(can("auditor", "write:operation")).toBe(false);
  });
});
