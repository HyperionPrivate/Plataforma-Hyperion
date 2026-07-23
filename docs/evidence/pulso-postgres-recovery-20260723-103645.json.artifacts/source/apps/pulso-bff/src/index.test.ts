import { describe, expect, it } from "vitest";
import { readPulsoBffProcessConfiguration } from "./index.js";

const accessEnvironment = {
  ACCESS_JWKS_URL: "https://access.example.test/.well-known/jwks.json",
  ACCESS_TOKEN_ISSUER: "https://access.example.test",
  ACCESS_TOKEN_AUDIENCE: "pulso-bff"
};

describe("PULSO BFF process configuration", () => {
  it("wires every canonical local provider port", () => {
    const configuration = readPulsoBffProcessConfiguration({
      ...accessEnvironment,
      HYPERION_ENVIRONMENT: "local"
    });
    expect(configuration.accessUrl).toBe("http://localhost:8081");
    expect(configuration.upstreams).toEqual({
      core: "http://localhost:8088",
      sofia: "http://localhost:8083",
      "prompt-flow": "http://localhost:8084",
      knowledge: "http://localhost:8085",
      integration: "http://localhost:8087",
      whatsapp: "http://localhost:8089"
    });
    expect(configuration.port).toBe(8097);
  });

  it("cannot start from implicit upstreams in production", () => {
    expect(() =>
      readPulsoBffProcessConfiguration({ ...accessEnvironment, HYPERION_ENVIRONMENT: "production" })
    ).toThrow(/ACCESS_SERVICE_URL is required/);
  });
});
