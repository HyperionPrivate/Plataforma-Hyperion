import { describe, expect, it } from "vitest";
import { allowPrivateAccessHttp, readAccessServiceOrigin } from "./runtime-config.js";

describe("NOVA BFF Access transport configuration", () => {
  it("keeps private HTTP disabled and fails closed without an Access origin by default", () => {
    expect(allowPrivateAccessHttp({})).toBe(false);
    expect(allowPrivateAccessHttp({ ACCESS_JWKS_ALLOW_PRIVATE_HTTP: "false", HYPERION_ENVIRONMENT: "test" })).toBe(
      false
    );
    expect(() => readAccessServiceOrigin({ HYPERION_ENVIRONMENT: "local" })).toThrow(/ACCESS_SERVICE_URL is required/);
  });

  it.each(["local", "development", "test", "ci"])(
    "permits an allowlisted private HTTP Access origin when explicitly enabled in %s",
    (deployment) => {
      expect(
        readAccessServiceOrigin({
          ACCESS_JWKS_ALLOW_PRIVATE_HTTP: " TRUE ",
          ACCESS_SERVICE_URL: "http://identity-service:18080/",
          HYPERION_ENVIRONMENT: deployment
        })
      ).toBe("http://identity-service:18080");
    }
  );

  it.each(["local", "development", "test", "ci"])(
    "rejects a configured HTTP Access origin without the explicit escape hatch in %s",
    (deployment) => {
      expect(() =>
        readAccessServiceOrigin({
          ACCESS_SERVICE_URL: "http://identity-service:18080",
          HYPERION_ENVIRONMENT: deployment
        })
      ).toThrow(/unless private HTTP is explicitly enabled/);
    }
  );

  it.each(["local", "development", "test"])(
    "uses the loopback fallback only with the explicit private HTTP escape hatch in %s",
    (deployment) => {
      expect(
        readAccessServiceOrigin({
          ACCESS_JWKS_ALLOW_PRIVATE_HTTP: "true",
          HYPERION_ENVIRONMENT: deployment
        })
      ).toBe("http://localhost:8081");
    }
  );

  it.each(["staging", "production"])(
    "rejects the private HTTP escape hatch in %s even when the Access origin uses HTTPS",
    (deployment) => {
      expect(() =>
        readAccessServiceOrigin({
          ACCESS_JWKS_ALLOW_PRIVATE_HTTP: "true",
          ACCESS_SERVICE_URL: "https://access.example.test",
          HYPERION_ENVIRONMENT: deployment
        })
      ).toThrow(/forbidden outside local\/CI/);
    }
  );

  it.each(["staging", "production"])("rejects HTTP Access origins in %s", (deployment) => {
    expect(() =>
      readAccessServiceOrigin({
        ACCESS_SERVICE_URL: "http://identity-service:8081",
        HYPERION_ENVIRONMENT: deployment
      })
    ).toThrow(/must be a credential-free HTTPS origin/);
  });

  it("accepts and normalizes HTTPS Access origins in production", () => {
    expect(
      readAccessServiceOrigin({
        ACCESS_SERVICE_URL: "https://access.example.test:8443/",
        HYPERION_ENVIRONMENT: "production"
      })
    ).toBe("https://access.example.test:8443");
  });

  it("does not permit cleartext public hosts or URL authority and suffix smuggling", () => {
    for (const invalid of [
      "http://access.example.test:8081",
      "https://operator:secret@access.example.test",
      "https://access.example.test/v1/access/token",
      "https://access.example.test/?tenant=other",
      "https://access.example.test/#fragment",
      "ftp://identity-service:8081"
    ]) {
      expect(() =>
        readAccessServiceOrigin({
          ACCESS_JWKS_ALLOW_PRIVATE_HTTP: "true",
          ACCESS_SERVICE_URL: invalid,
          HYPERION_ENVIRONMENT: "test"
        })
      ).toThrow(/ACCESS_SERVICE_URL must be/);
    }
  });
});
