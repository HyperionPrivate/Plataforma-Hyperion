import { generateKeyPairSync } from "node:crypto";
import { platformControlTenantId } from "@hyperion/platform-contracts";
import { createOperatorAssertion as createPlatformOperatorAssertion } from "@hyperion/platform-contracts/operator-assertion";
import {
  createInternalAuthorizationHeaders,
  createOperatorAssertion,
  createService,
  OPERATOR_ASSERTION_HEADER,
  type ServiceHandle
} from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readOptionalGatewayAssertionKey, registerRoutes } from "./app.js";
import { AccessTokenService } from "./access-token.js";
import { hashPassword, readBearerToken, verifyPassword } from "./auth.js";

let app: ServiceHandle["app"];
const GATEWAY_TOKEN = "identity-gateway-test-token-0001";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const NOVA_BFF_TOKEN = "nova-bff-to-access-test-token-001";
const LUMEN_BFF_TOKEN = "lumen-bff-to-access-test-token-01";
const PULSO_BFF_TOKEN = "pulso-bff-to-access-test-token-01";
const PLATFORM_ADMIN_ACCESS_TOKEN = "platform-admin-to-access-token-0001";
const PLATFORM_ADMIN_IDENTITY_TOKEN = "platform-admin-to-identity-token-01";
const PLATFORM_ADMIN_ASSERTION_KEY = "platform-admin-assertion-key-0001";
const gatewayHeaders = createInternalAuthorizationHeaders("api-gateway", GATEWAY_TOKEN);
const signingPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingKeyPem = signingPair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.INITIAL_ADMIN_EMAIL;
  delete process.env.INITIAL_ADMIN_PASSWORD;
  process.env.GATEWAY_TO_IDENTITY_TOKEN = GATEWAY_TOKEN;
  process.env.GATEWAY_OPERATOR_ASSERTION_KEY = ASSERTION_KEY;
  process.env.NOVA_BFF_TO_ACCESS_TOKEN = NOVA_BFF_TOKEN;
  process.env.LUMEN_BFF_TO_ACCESS_TOKEN = LUMEN_BFF_TOKEN;
  process.env.PULSO_BFF_TO_ACCESS_TOKEN = PULSO_BFF_TOKEN;
  process.env.PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN = PLATFORM_ADMIN_ACCESS_TOKEN;
  process.env.PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN = PLATFORM_ADMIN_IDENTITY_TOKEN;
  process.env.PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY = PLATFORM_ADMIN_ASSERTION_KEY;
  process.env.ACCESS_TOKEN_PRIVATE_KEY_PEM = signingKeyPem;
  process.env.ACCESS_TOKEN_ISSUER = "https://access.example.test";
  process.env.ACCESS_TOKEN_AUDIENCES = "nova-bff,lumen-bff,pulso-bff,platform-admin-bff";
  process.env.ACCESS_TOKEN_KEY_ID = "access-test-current";
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
  delete process.env.NOVA_BFF_TO_ACCESS_TOKEN;
  delete process.env.LUMEN_BFF_TO_ACCESS_TOKEN;
  delete process.env.PULSO_BFF_TO_ACCESS_TOKEN;
  delete process.env.PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN;
  delete process.env.PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN;
  delete process.env.PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY;
  delete process.env.ACCESS_TOKEN_PRIVATE_KEY_PEM;
  delete process.env.ACCESS_TOKEN_ISSUER;
  delete process.env.ACCESS_TOKEN_AUDIENCES;
  delete process.env.ACCESS_TOKEN_KEY_ID;
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

describe("legacy gateway compatibility", () => {
  it("does not make a gateway-wide assertion key a platform startup dependency", () => {
    expect(readOptionalGatewayAssertionKey({ HYPERION_ENVIRONMENT: "production" })).toBeUndefined();
    expect(
      readOptionalGatewayAssertionKey({
        HYPERION_ENVIRONMENT: "production",
        GATEWAY_OPERATOR_ASSERTION_KEY: ASSERTION_KEY
      })
    ).toBe(ASSERTION_KEY);
    expect(() =>
      readOptionalGatewayAssertionKey({
        HYPERION_ENVIRONMENT: "production",
        GATEWAY_OPERATOR_ASSERTION_KEY: "too-short"
      })
    ).toThrow("at least 24 safe characters");
  });
});

describe("identity-service routes", () => {
  it("publishes a public JWKS without private RSA parameters", async () => {
    const response = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    const body = response.json<{ keys: Array<Record<string, unknown>> }>();

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("stale-if-error");
    expect(body.keys[0]).toMatchObject({ kid: "access-test-current", alg: "RS256", use: "sig" });
    expect(body.keys[0]).not.toHaveProperty("d");
  });

  it("resolves a valid JWT on /v1/auth/me without a database", async () => {
    const tokens = new AccessTokenService({
      issuer: "https://access.example.test",
      audience: "nova-bff",
      keyId: "access-test-current",
      privateKey: signingPair.privateKey,
      now: () => Date.now()
    });
    const token = tokens.issue({
      operator: {
        id: "22222222-2222-4222-8222-222222222222",
        email: "operator@example.com",
        displayName: "Operator",
        role: "advisor"
      },
      grants: [
        {
          tenantId: "11111111-1111-4111-8111-111111111111",
          productId: "NOVA",
          roles: ["asesor"],
          capabilities: ["nova:read"]
        }
      ]
    }).token;
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.grants[0].productId).toBe("NOVA");
  });

  it("protects the BFF token endpoint with its own workload credential", async () => {
    const unauthenticated = await app.inject({
      method: "POST",
      url: "/v1/access/token",
      payload: { email: "admin@hyperion.local", password: "clave-segura-123" }
    });
    const authenticated = await app.inject({
      method: "POST",
      url: "/v1/access/token",
      headers: createInternalAuthorizationHeaders("nova-bff", NOVA_BFF_TOKEN),
      payload: { email: "admin@hyperion.local", password: "clave-segura-123" }
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(authenticated.statusCode).toBe(503);
  });

  it("does not let one product BFF reuse another product's Access credential", async () => {
    const crossed = await app.inject({
      method: "POST",
      url: "/v1/access/token",
      headers: createInternalAuthorizationHeaders("lumen-bff", NOVA_BFF_TOKEN),
      payload: { email: "admin@hyperion.local", password: "clave-segura-123" }
    });
    const own = await app.inject({
      method: "POST",
      url: "/v1/access/token",
      headers: createInternalAuthorizationHeaders("lumen-bff", LUMEN_BFF_TOKEN),
      payload: { email: "admin@hyperion.local", password: "clave-segura-123" }
    });

    expect(crossed.statusCode).toBe(401);
    expect(own.statusCode).toBe(503);
  });

  it("isolates the platform administration Access credential from product credentials", async () => {
    const crossed = await app.inject({
      method: "POST",
      url: "/v1/access/token",
      headers: createInternalAuthorizationHeaders("platform-admin-bff", NOVA_BFF_TOKEN),
      payload: { email: "admin@hyperion.local", password: "clave-segura-123" }
    });
    const own = await app.inject({
      method: "POST",
      url: "/v1/access/token",
      headers: createInternalAuthorizationHeaders("platform-admin-bff", PLATFORM_ADMIN_ACCESS_TOKEN),
      payload: { email: "admin@hyperion.local", password: "clave-segura-123" }
    });

    expect(crossed.statusCode).toBe(401);
    expect(own.statusCode).toBe(503);
  });

  it("accepts only an attested platform-manager context from platform-admin-bff", async () => {
    const operatorId = "22222222-2222-4222-8222-222222222222";
    const headers = {
      ...createInternalAuthorizationHeaders("platform-admin-bff", PLATFORM_ADMIN_IDENTITY_TOKEN),
      "x-operator-id": operatorId,
      "x-operator-role": "platform-manager",
      [OPERATOR_ASSERTION_HEADER]: createPlatformOperatorAssertion(
        {
          operatorId,
          role: "platform-manager",
          tenantId: platformControlTenantId,
          expiresAtUnix: Math.floor(Date.now() / 1000) + 60
        },
        PLATFORM_ADMIN_ASSERTION_KEY
      )
    };
    const accepted = await app.inject({ method: "GET", url: "/v1/identity/operators", headers });
    const grantsWithoutDatabase = await app.inject({ method: "GET", url: "/v1/access/grants", headers });
    const forged = await app.inject({
      method: "GET",
      url: "/v1/identity/operators",
      headers: { ...headers, "x-hyperion-operator-assertion": `${headers[OPERATOR_ASSERTION_HEADER]}x` }
    });

    expect(accepted.statusCode).toBe(200);
    expect(grantsWithoutDatabase.statusCode).toBe(503);
    expect(forged.statusCode).toBe(403);
  });

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

  it("rejects a tenant-bound assertion on the tenantless operator-management context", async () => {
    const operatorId = "22222222-2222-4222-8222-222222222222";
    const response = await app.inject({
      method: "GET",
      url: "/v1/identity/operators",
      headers: {
        ...gatewayHeaders,
        "x-operator-id": operatorId,
        "x-operator-role": "admin",
        [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
          {
            operatorId,
            role: "admin",
            tenantId: "33333333-3333-4333-8333-333333333333",
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          ASSERTION_KEY
        )
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects ambiguous repeated operator headers", async () => {
    const operatorId = "22222222-2222-4222-8222-222222222222";
    const response = await app.inject({
      method: "GET",
      url: "/v1/identity/operators",
      headers: {
        ...gatewayHeaders,
        "x-operator-id": [operatorId, operatorId],
        "x-operator-role": ["admin", "admin"],
        [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
          {
            operatorId,
            role: "admin",
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          ASSERTION_KEY
        )
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
