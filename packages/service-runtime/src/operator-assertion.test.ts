import { describe, expect, it } from "vitest";
import { createOperatorAssertion, verifyOperatorAssertion } from "./operator-assertion.js";

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
