import { describe, expect, it } from "vitest";
import { allowPrivateAccessJwksHttp, readPulsoBffServiceOrigins } from "./runtime-config.js";

describe("PULSO BFF JWKS transport configuration", () => {
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

describe("PULSO BFF upstream configuration", () => {
  const explicitOrigins = {
    ACCESS_SERVICE_URL: "http://identity-service:8081",
    PULSO_IRIS_SERVICE_URL: "http://pulso-iris-service:8088",
    AGENT_SERVICE_URL: "http://agent-service:8083",
    PROMPT_FLOW_SERVICE_URL: "http://prompt-flow-service:8084",
    KNOWLEDGE_SERVICE_URL: "http://knowledge-service:8085",
    INTEGRATION_SERVICE_URL: "http://integration-service:8087",
    WHATSAPP_CHANNEL_SERVICE_URL: "http://whatsapp-channel-service:8089"
  };

  it.each(["local", "development", "test"])("uses only canonical local origins in %s", (deployment) => {
    expect(readPulsoBffServiceOrigins({ HYPERION_ENVIRONMENT: deployment })).toEqual({
      access: "http://localhost:8081",
      core: "http://localhost:8088",
      sofia: "http://localhost:8083",
      "prompt-flow": "http://localhost:8084",
      knowledge: "http://localhost:8085",
      integration: "http://localhost:8087",
      whatsapp: "http://localhost:8089"
    });
  });

  it.each(["ci", "staging", "production", "qa"])("fails closed without every explicit origin in %s", (deployment) => {
    expect(() => readPulsoBffServiceOrigins({ HYPERION_ENVIRONMENT: deployment })).toThrow(
      /ACCESS_SERVICE_URL is required/
    );
    expect(() =>
      readPulsoBffServiceOrigins({
        HYPERION_ENVIRONMENT: deployment,
        ...explicitOrigins,
        INTEGRATION_SERVICE_URL: "   "
      })
    ).toThrow(/INTEGRATION_SERVICE_URL is required/);
  });

  it("normalizes explicit origins and rejects non-origin endpoints", () => {
    expect(readPulsoBffServiceOrigins({ HYPERION_ENVIRONMENT: "production", ...explicitOrigins })).toEqual({
      access: explicitOrigins.ACCESS_SERVICE_URL,
      core: explicitOrigins.PULSO_IRIS_SERVICE_URL,
      sofia: explicitOrigins.AGENT_SERVICE_URL,
      "prompt-flow": explicitOrigins.PROMPT_FLOW_SERVICE_URL,
      knowledge: explicitOrigins.KNOWLEDGE_SERVICE_URL,
      integration: explicitOrigins.INTEGRATION_SERVICE_URL,
      whatsapp: explicitOrigins.WHATSAPP_CHANNEL_SERVICE_URL
    });
    expect(() =>
      readPulsoBffServiceOrigins({
        HYPERION_ENVIRONMENT: "production",
        ...explicitOrigins,
        KNOWLEDGE_SERVICE_URL: "http://user:secret@knowledge-service:8085/v1"
      })
    ).toThrow(/KNOWLEDGE_SERVICE_URL must be/);
  });
});
