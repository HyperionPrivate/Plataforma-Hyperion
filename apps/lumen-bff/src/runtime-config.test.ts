import { describe, expect, it } from "vitest";
import { allowPrivateAccessJwksHttp, readLumenBffServiceOrigins } from "./runtime-config.js";

describe("LUMEN BFF JWKS transport configuration", () => {
  it("keeps private HTTP disabled by default", () => {
    expect(allowPrivateAccessJwksHttp({})).toBe(false);
    expect(allowPrivateAccessJwksHttp({ ACCESS_JWKS_ALLOW_PRIVATE_HTTP: "false", NODE_ENV: "test" })).toBe(false);
  });

  it.each(["local", "development", "test", "ci"])("permits the explicit escape hatch in %s", (deployment) => {
    expect(
      allowPrivateAccessJwksHttp({ ACCESS_JWKS_ALLOW_PRIVATE_HTTP: " TRUE ", HYPERION_ENVIRONMENT: deployment })
    ).toBe(true);
  });

  it.each(["staging", "production"])("fails closed when the escape hatch is enabled in %s", (deployment) => {
    expect(() =>
      allowPrivateAccessJwksHttp({ ACCESS_JWKS_ALLOW_PRIVATE_HTTP: "true", HYPERION_ENVIRONMENT: deployment })
    ).toThrow(/forbidden/);
  });
});

describe("LUMEN BFF upstream configuration", () => {
  it.each(["local", "development", "test"])("uses only canonical local origins in %s", (deployment) => {
    expect(readLumenBffServiceOrigins({ HYPERION_ENVIRONMENT: deployment })).toEqual({
      access: "http://localhost:8081",
      lumen: "http://localhost:8090"
    });
  });

  it.each(["ci", "staging", "production", "qa"])("fails closed without explicit origins in %s", (deployment) => {
    expect(() => readLumenBffServiceOrigins({ HYPERION_ENVIRONMENT: deployment })).toThrow(
      /ACCESS_SERVICE_URL is required/
    );
    expect(() =>
      readLumenBffServiceOrigins({
        HYPERION_ENVIRONMENT: deployment,
        ACCESS_SERVICE_URL: "http://identity-service:8081"
      })
    ).toThrow(/LUMEN_SERVICE_URL is required/);
  });

  it("normalizes explicit origins and rejects authority smuggling or URL suffixes", () => {
    expect(
      readLumenBffServiceOrigins({
        HYPERION_ENVIRONMENT: "production",
        ACCESS_SERVICE_URL: "https://access.example.test:8443/",
        LUMEN_SERVICE_URL: "http://lumen-service:8090"
      })
    ).toEqual({ access: "https://access.example.test:8443", lumen: "http://lumen-service:8090" });

    for (const invalid of [
      "ftp://lumen-service:8090",
      "http://operator:secret@lumen-service:8090",
      "http://lumen-service:8090/internal",
      "http://lumen-service:8090/?tenant=other",
      "http://lumen-service:8090/#fragment"
    ]) {
      expect(() =>
        readLumenBffServiceOrigins({
          HYPERION_ENVIRONMENT: "production",
          ACCESS_SERVICE_URL: "http://identity-service:8081",
          LUMEN_SERVICE_URL: invalid
        })
      ).toThrow(/LUMEN_SERVICE_URL must be/);
    }
  });
});
