import { describe, expect, it } from "vitest";
import {
  OPERATOR_ASSERTION_HEADER,
  createOperatorAssertion,
  readOperatorAssertionKey,
  validateOperatorAssertionContext,
  validateProductOperatorAssertionContext,
  verifyOperatorAssertion
} from "./operator-assertion.js";

describe("operator assertion", () => {
  const secret = "gateway-operator-assertion-key-01";

  it("round-trips claims within the expiry window", () => {
    const assertion = createOperatorAssertion(
      { operatorId: "11111111-1111-4111-8111-111111111111", role: "admin", expiresAtUnix: 2_000_000_000 },
      secret
    );
    expect(verifyOperatorAssertion(assertion, secret, 1_999_999_000)).toEqual({
      operatorId: "11111111-1111-4111-8111-111111111111",
      role: "admin",
      expiresAtUnix: 2_000_000_000
    });
  });

  it("binds tenant-scoped assertions to the exact forwarded context", () => {
    const tenantId = "22222222-2222-4222-8222-222222222222";
    const operatorId = "11111111-1111-4111-8111-111111111111";
    const assertion = createOperatorAssertion(
      { operatorId, role: "admin", tenantId, expiresAtUnix: 2_000_000_000 },
      secret
    );
    const headers = {
      [OPERATOR_ASSERTION_HEADER]: assertion,
      "x-operator-id": operatorId,
      "x-operator-role": "admin"
    };

    expect(validateOperatorAssertionContext(headers, secret, tenantId, 1_999_999_000)).toBeUndefined();
    expect(
      validateOperatorAssertionContext({ ...headers, "x-operator-role": "advisor" }, secret, tenantId, 1_999_999_000)
    ).toEqual({
      statusCode: 403,
      message: "Operator assertion mismatch"
    });
    expect(
      validateOperatorAssertionContext(headers, secret, "33333333-3333-4333-8333-333333333333", 1_999_999_000)
    ).toEqual({ statusCode: 403, message: "Operator assertion mismatch" });
    expect(validateOperatorAssertionContext(headers, secret, tenantId, 2_000_000_001)).toEqual({
      statusCode: 403,
      message: "Operator assertion mismatch"
    });
  });

  it("binds a product-scoped assertion to operator, tenant and product", () => {
    const tenantId = "22222222-2222-4222-8222-222222222222";
    const operatorId = "11111111-1111-4111-8111-111111111111";
    const assertion = createOperatorAssertion(
      { operatorId, role: "advisor", tenantId, productId: "NOVA", expiresAtUnix: 2_000_000_000 },
      secret
    );
    const headers = {
      [OPERATOR_ASSERTION_HEADER]: assertion,
      "x-operator-id": operatorId,
      "x-operator-role": "advisor"
    };

    expect(verifyOperatorAssertion(assertion, secret, 1_999_999_000)).toEqual({
      operatorId,
      role: "advisor",
      tenantId,
      productId: "NOVA",
      expiresAtUnix: 2_000_000_000
    });
    expect(validateProductOperatorAssertionContext(headers, secret, tenantId, "NOVA", 1_999_999_000)).toBeUndefined();
    expect(validateProductOperatorAssertionContext(headers, secret, tenantId, "LUMEN", 1_999_999_000)).toEqual({
      statusCode: 403,
      message: "Operator assertion mismatch"
    });

    const tenantOnly = createOperatorAssertion(
      { operatorId, role: "advisor", tenantId, expiresAtUnix: 2_000_000_000 },
      secret
    );
    expect(
      validateProductOperatorAssertionContext(
        { ...headers, [OPERATOR_ASSERTION_HEADER]: tenantOnly },
        secret,
        tenantId,
        "NOVA",
        1_999_999_000
      )
    ).toEqual({ statusCode: 403, message: "Operator assertion mismatch" });
  });

  it("fails closed when a product service has no assertion key", () => {
    expect(
      validateProductOperatorAssertionContext(
        {
          "x-operator-id": "operator-1",
          "x-operator-role": "admin"
        },
        undefined,
        "22222222-2222-4222-8222-222222222222",
        "NOVA",
        1_999_999_000
      )
    ).toEqual({ statusCode: 403, message: "Operator assertion mismatch" });
  });

  it("requires an assertion key only in restricted deployment environments", () => {
    expect(readOperatorAssertionKey({ HYPERION_ENVIRONMENT: "local" })).toBeUndefined();
    expect(readOperatorAssertionKey({ HYPERION_ENVIRONMENT: "ci" })).toBeUndefined();
    expect(() => readOperatorAssertionKey({ HYPERION_ENVIRONMENT: "staging" })).toThrow(
      "GATEWAY_OPERATOR_ASSERTION_KEY is required"
    );
    expect(
      readOperatorAssertionKey({
        HYPERION_ENVIRONMENT: "production",
        GATEWAY_OPERATOR_ASSERTION_KEY: secret
      })
    ).toBe(secret);
  });

  it("rejects forged roles and expired assertions", () => {
    const assertion = createOperatorAssertion(
      { operatorId: "11111111-1111-4111-8111-111111111111", role: "admin", expiresAtUnix: 2_000_000_000 },
      secret
    );
    const forged = assertion.replace("|admin|", "|advisor|");
    expect(verifyOperatorAssertion(forged, secret, 1_999_999_000)).toBeUndefined();
    expect(verifyOperatorAssertion(assertion, secret, 2_000_000_001)).toBeUndefined();
    expect(verifyOperatorAssertion(assertion, "different-operator-assertion-key")).toBeUndefined();
  });
});
