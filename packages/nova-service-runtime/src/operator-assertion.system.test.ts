import { describe, expect, it } from "vitest";
import { createProductSystemAssertionHeaders, validateProductSystemAssertionContext } from "./operator-assertion.js";

const SECRET = "nova-system-assertion-secret-0001";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";

describe("product system assertions", () => {
  it("binds the exact producer, tenant and product", () => {
    const headers = createProductSystemAssertionHeaders({
      serviceId: "nova-core-service",
      tenantId: TENANT_ID,
      productId: "NOVA",
      secret: SECRET,
      expiresAtUnix: 2_000_000_000
    });

    expect(
      validateProductSystemAssertionContext(headers, SECRET, TENANT_ID, "NOVA", "nova-core-service", 1_999_999_000)
    ).toBeUndefined();
    expect(
      validateProductSystemAssertionContext(headers, SECRET, TENANT_ID, "NOVA", "liwa-channel-service", 1_999_999_000)
    ).toEqual({ statusCode: 403, message: "Operator assertion mismatch" });
    expect(
      validateProductSystemAssertionContext(
        headers,
        SECRET,
        "22222222-2222-4222-8222-222222222222",
        "NOVA",
        "nova-core-service",
        1_999_999_000
      )
    ).toEqual({ statusCode: 403, message: "Operator assertion mismatch" });
    expect(
      validateProductSystemAssertionContext(headers, SECRET, TENANT_ID, "LUMEN", "nova-core-service", 1_999_999_000)
    ).toEqual({ statusCode: 403, message: "Operator assertion mismatch" });
  });

  it("rejects an unsigned workload context", () => {
    expect(
      validateProductSystemAssertionContext(
        { "x-operator-id": "nova-core-service", "x-operator-role": "system" },
        SECRET,
        TENANT_ID,
        "NOVA",
        "nova-core-service"
      )
    ).toEqual({ statusCode: 403, message: "Operator assertion mismatch" });
  });
});
