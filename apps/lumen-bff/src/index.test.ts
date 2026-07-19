import { describe, expect, it } from "vitest";
import { readLumenBffProcessConfiguration } from "./index.js";

const accessEnvironment = {
  ACCESS_JWKS_URL: "https://access.example.test/.well-known/jwks.json",
  ACCESS_TOKEN_ISSUER: "https://access.example.test",
  ACCESS_TOKEN_AUDIENCE: "lumen-bff"
};

describe("LUMEN BFF process configuration", () => {
  it("wires the canonical LUMEN port in local development", () => {
    const configuration = readLumenBffProcessConfiguration({
      ...accessEnvironment,
      HYPERION_ENVIRONMENT: "local"
    });
    expect(configuration.accessUrl).toBe("http://localhost:8081");
    expect(configuration.upstream).toBe("http://localhost:8090");
    expect(configuration.port).toBe(8096);
  });

  it("cannot start from implicit upstreams in CI", () => {
    expect(() => readLumenBffProcessConfiguration({ ...accessEnvironment, HYPERION_ENVIRONMENT: "ci" })).toThrow(
      /ACCESS_SERVICE_URL is required/
    );
  });
});
