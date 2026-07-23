import { describe, expect, it } from "vitest";
import { createOperatorAssertion, OPERATOR_ASSERTION_HEADER } from "./operator-assertion.js";

describe("platform-owned operator assertion encoder", () => {
  it("keeps the existing tenant-scoped HMAC wire format", () => {
    const assertion = createOperatorAssertion(
      {
        operatorId: "22222222-2222-4222-8222-222222222222",
        role: "platform-manager",
        tenantId: "00000000-0000-4000-8000-000000000001",
        expiresAtUnix: 2_000_000_000
      },
      "platform-admin-assertion-key-0001"
    );

    expect(OPERATOR_ASSERTION_HEADER).toBe("x-hyperion-operator-assertion");
    expect(assertion.split("|").slice(0, -1)).toEqual([
      "22222222-2222-4222-8222-222222222222",
      "platform-manager",
      "00000000-0000-4000-8000-000000000001",
      "2000000000"
    ]);
    expect(assertion.split("|").at(-1)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });
});
