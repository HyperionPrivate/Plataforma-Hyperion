import {
  createInternalAuthorizationHeaders,
  createOperatorAssertion,
  createService,
  OPERATOR_ASSERTION_HEADER,
  type ServiceHandle
} from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";
import { hashPassword, readBearerToken, verifyPassword } from "./auth.js";

let app: ServiceHandle["app"];
const GATEWAY_TOKEN = "identity-gateway-test-token-0001";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const gatewayHeaders = createInternalAuthorizationHeaders("api-gateway", GATEWAY_TOKEN);

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.INITIAL_ADMIN_EMAIL;
  delete process.env.INITIAL_ADMIN_PASSWORD;
  process.env.GATEWAY_TO_IDENTITY_TOKEN = GATEWAY_TOKEN;
  process.env.GATEWAY_OPERATOR_ASSERTION_KEY = ASSERTION_KEY;
  const handle = await createService({
    serviceName: "identity-service",
    databaseRequired: true,
    registerRoutes
  });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
  delete process.env.GATEWAY_TO_IDENTITY_TOKEN;
  delete process.env.GATEWAY_OPERATOR_ASSERTION_KEY;
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("clave-segura-123");

    expect(await verifyPassword("clave-segura-123", hash)).toBe(true);
    expect(await verifyPassword("clave-incorrecta", hash)).toBe(false);
  });

  it("produces unique hashes per call (random salt)", async () => {
    const first = await hashPassword("misma-clave");
    const second = await hashPassword("misma-clave");

    expect(first).not.toBe(second);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("clave", "texto-plano")).toBe(false);
  });
});

describe("bearer token parsing", () => {
  it("extracts well-formed bearer tokens and rejects short or missing ones", () => {
    expect(readBearerToken("Bearer abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(readBearerToken("Bearer corto")).toBeUndefined();
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken("Basic abcdefghijklmnopqrstuvwxyz")).toBeUndefined();
  });
});

describe("identity-service routes", () => {
  it("rejects malformed login payloads", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "no-es-email", password: "corta" }
    });

    expect(response.statusCode).toBe(400);
  });

  it("requires a database for login", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "admin@hyperion.local", password: "clave-segura-123" }
    });

    expect(response.statusCode).toBe(503);
  });

  it("requires a session token on /v1/auth/me", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/me" });

    expect(response.statusCode).toBe(401);
  });

  it("requires admin role for operator creation", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: {
        ...gatewayHeaders,
        "x-operator-id": "11111111-1111-4111-8111-111111111111",
        "x-operator-role": "coordinator",
        [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
          {
            operatorId: "11111111-1111-4111-8111-111111111111",
            role: "coordinator",
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          ASSERTION_KEY
        )
      },
      payload: {
        email: "asesor@hyperion.local",
        displayName: "Asesor",
        password: "clave-segura-123",
        role: "advisor",
        tenantIds: []
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("requires admin role for operator listing", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/identity/operators",
      headers: {
        ...gatewayHeaders,
        "x-operator-id": "11111111-1111-4111-8111-111111111111",
        "x-operator-role": "coordinator",
        [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
          {
            operatorId: "11111111-1111-4111-8111-111111111111",
            role: "coordinator",
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          ASSERTION_KEY
        )
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects forged admin role when only the edge token is present", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: { ...gatewayHeaders, "x-operator-role": "admin" },
      payload: {
        email: "asesor@hyperion.local",
        displayName: "Asesor",
        password: "clave-segura-123",
        role: "advisor",
        tenantIds: []
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("requires a database for admin operator creation when assertion is valid", async () => {
    const operatorId = "22222222-2222-4222-8222-222222222222";
    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: {
        ...gatewayHeaders,
        "x-operator-id": operatorId,
        "x-operator-role": "admin",
        [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
          {
            operatorId,
            role: "admin",
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          ASSERTION_KEY
        )
      },
      payload: {
        email: "correo-invalido",
        displayName: "A",
        password: "corta",
        role: "unknown",
        tenantIds: []
      }
    });

    expect(response.statusCode).toBe(503);
  });

  it("does not trust a forged admin header without the gateway identity", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: { "x-operator-role": "admin" },
      payload: {
        email: "asesor@hyperion.local",
        displayName: "Asesor",
        password: "clave-segura-123",
        role: "advisor",
        tenantIds: []
      }
    });

    expect(response.statusCode).toBe(401);
  });
});
