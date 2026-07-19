import { describe, expect, it } from "vitest";
import { requireDemoTenantId } from "./demo-tenant-context.js";

describe("demo tenant context", () => {
  it("requires an explicit opaque tenant identity", () => {
    expect(() => requireDemoTenantId({}, "PULSO_DEMO_TENANT_ID")).toThrow("tenant selection by slug is forbidden");
    expect(() => requireDemoTenantId({ PULSO_DEMO_TENANT_ID: "cedco" }, "PULSO_DEMO_TENANT_ID")).toThrow(
      "must be an explicit tenant UUID"
    );
  });

  it("normalizes a valid UUID without resolving a customer slug", () => {
    expect(
      requireDemoTenantId({ LUMEN_DEMO_TENANT_ID: " 8D9578E8-2D28-4AD4-B587-05802D24AE80 " }, "LUMEN_DEMO_TENANT_ID")
    ).toBe("8d9578e8-2d28-4ad4-b587-05802d24ae80");
  });
});
