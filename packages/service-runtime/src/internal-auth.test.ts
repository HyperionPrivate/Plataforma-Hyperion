import { describe, expect, it } from "vitest";
import {
  createInternalAuthorizationHeaders,
  readInternalCaller,
  readInternalCredential,
  validateInternalAuthorization
} from "./internal-auth.js";

describe("internal workload authentication", () => {
  it("binds a credential to the asserted caller", () => {
    const headers = createInternalAuthorizationHeaders("whatsapp-channel-service", "channel-edge-token");

    expect(
      validateInternalAuthorization(headers, {
        "whatsapp-channel-service": "channel-edge-token",
        "agent-service": "different-edge-token"
      })
    ).toBeUndefined();
  });

  it("does not let one configured workload impersonate another", () => {
    const headers = createInternalAuthorizationHeaders("agent-service", "channel-edge-token");

    expect(
      validateInternalAuthorization(headers, {
        "whatsapp-channel-service": "channel-edge-token",
        "agent-service": "different-edge-token"
      })
    ).toEqual({ statusCode: 401, message: "Unauthorized internal caller" });
  });

  it("fails closed when the receiver has no workload credentials", () => {
    expect(
      validateInternalAuthorization({ authorization: "Bearer any", "x-hyperion-caller": "agent-service" }, {})
    ).toEqual({ statusCode: 503, message: "Internal workload credentials are not configured" });
  });

  it("rejects ambiguous caller headers", () => {
    expect(
      validateInternalAuthorization(
        {
          authorization: "Bearer agent-token",
          "x-hyperion-caller": ["agent-service", "whatsapp-channel-service"]
        },
        { "agent-service": "agent-token" }
      )
    ).toEqual({ statusCode: 401, message: "Unauthorized internal caller" });
    expect(readInternalCaller({ "x-hyperion-caller": ["agent-service", "audit-service"] })).toBeUndefined();
  });

  it("enforces production-strength, header-safe credentials", () => {
    expect(() => readInternalCredential({ NODE_ENV: "production", EDGE_TOKEN: "short" }, "EDGE_TOKEN")).toThrow(
      /at least 24/
    );
    expect(() =>
      readInternalCredential({ NODE_ENV: "production", EDGE_TOKEN: "unsafe token with whitespace 123" }, "EDGE_TOKEN")
    ).toThrow(/whitespace/);
    expect(
      readInternalCredential({ NODE_ENV: "production", EDGE_TOKEN: "Valid-edge-token-safe-0001" }, "EDGE_TOKEN")
    ).toBe("Valid-edge-token-safe-0001");
  });
});
