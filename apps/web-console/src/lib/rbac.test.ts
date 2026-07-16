import { describe, expect, it } from "vitest";
import { can } from "./rbac.js";

describe("LUMEN RBAC", () => {
  it.each(["admin", "coordinator", "advisor"] as const)("allows %s to review and approve demo records", (role) => {
    expect(can(role, "view:lumen")).toBe(true);
    expect(can(role, "view:nova")).toBe(true);
    expect(can(role, "write:lumen")).toBe(true);
  });

  it("keeps auditors read-only", () => {
    expect(can("auditor", "view:lumen")).toBe(true);
    expect(can("auditor", "write:lumen")).toBe(false);
  });
});
