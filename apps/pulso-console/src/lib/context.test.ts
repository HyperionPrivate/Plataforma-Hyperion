import { describe, expect, it } from "vitest";
import { tenantPath } from "./context.js";

describe("tenantPath", () => {
  it("encodes the tenant as a single URL path segment", () => {
    expect(tenantPath("tenant/../../foreign?admin=true", "conversations")).toBe(
      "/v1/tenants/tenant%2F..%2F..%2Fforeign%3Fadmin%3Dtrue/pulso-iris/conversations"
    );
  });
});
