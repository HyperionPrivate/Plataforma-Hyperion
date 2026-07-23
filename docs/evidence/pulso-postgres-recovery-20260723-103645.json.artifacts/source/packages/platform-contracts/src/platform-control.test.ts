import { platformControlTenantId as aggregatePlatformControlTenantId } from "./index.js";
import { describe, expect, it } from "vitest";
import { platformControlTenantId } from "./platform-control.js";

describe("isolated platform control contract", () => {
  it("stays identical to the aggregate Access contract", () => {
    expect(platformControlTenantId).toBe(aggregatePlatformControlTenantId);
  });
});
