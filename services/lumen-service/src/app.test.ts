import {
  OPERATOR_ASSERTION_HEADER,
  createOperatorAssertion,
  createService,
  type ServiceHandle
} from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const TENANT = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const OTHER_TENANT = "8e0b2b6f-2d3c-4a5b-8c9d-3e5f7a9b1c2d";
const GATEWAY_TOKEN = "gateway-to-lumen-test-token";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const LUMEN_BFF_TOKEN = "lumen-bff-to-lumen-test-token";
const LUMEN_ASSERTION_KEY = "lumen-operator-assertion-key-0001";
const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
let app: ServiceHandle["app"];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GATEWAY_TO_LUMEN_TOKEN = GATEWAY_TOKEN;
  process.env.GATEWAY_OPERATOR_ASSERTION_KEY = ASSERTION_KEY;
  process.env.LUMEN_BFF_TO_LUMEN_TOKEN = LUMEN_BFF_TOKEN;
  process.env.LUMEN_OPERATOR_ASSERTION_KEY = LUMEN_ASSERTION_KEY;
  const handle = await createService({ serviceName: "lumen-service", databaseRequired: true, registerRoutes });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
  delete process.env.GATEWAY_TO_LUMEN_TOKEN;
  delete process.env.GATEWAY_OPERATOR_ASSERTION_KEY;
  delete process.env.LUMEN_BFF_TO_LUMEN_TOKEN;
  delete process.env.LUMEN_OPERATOR_ASSERTION_KEY;
});

describe("lumen-service", () => {
  it("exposes catalog and only minimal provider readiness", async () => {
    const catalog = await app.inject({ method: "GET", url: "/v1/lumen/catalog" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().data.product.code).toBe("LUMEN");

    const health = await app.inject({ method: "GET", url: "/v1/lumen/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().data).toEqual({
      service: "lumen-service",
      product: "LUMEN",
      status: "ok",
      providers: {
        transcriptionConfigured: false,
        structuringConfigured: false
      }
    });
    expect(health.body).not.toMatch(/elevenlabs|deepseek|scribe_v2|model|language/i);
  });

  it("rejects invalid tenants and reports a missing database", async () => {
    const unauthenticated = await app.inject({ method: "GET", url: `/v1/tenants/${TENANT}/lumen/worklist` });
    expect(unauthenticated.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/tenants/no-uuid/lumen/worklist",
      headers: gatewayHeaders("no-uuid")
    });
    expect(invalid.statusCode).toBe(400);

    const unavailable = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/lumen/worklist`,
      headers: gatewayHeaders(TENANT)
    });
    expect(unavailable.statusCode).toBe(503);
  });

  it("rejects a non-gateway workload even when it presents the gateway token", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/lumen/worklist`,
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "x-hyperion-caller": "agent-service" }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects forged operator headers even with a valid gateway edge token", async () => {
    const headers = gatewayHeaders(TENANT, "advisor");
    const forged = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/lumen/worklist`,
      headers: { ...headers, "x-operator-id": "22222222-2222-4222-8222-222222222222" }
    });
    const signed = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/lumen/worklist`,
      headers
    });

    expect(forged.statusCode).toBe(403);
    expect(signed.statusCode).toBe(503);
    expect(signed.json().data.error).toContain("DATABASE_URL");
  });

  it("protects decoded tenant routes and binds assertions to the routed tenant", async () => {
    const encodedWithoutHeaders = await app.inject({
      method: "GET",
      url: `/v1/%74enants/${TENANT}/lumen/worklist`
    });
    const wrongTenant = await app.inject({
      method: "GET",
      url: `/v1/tenants/${OTHER_TENANT}/lumen/worklist`,
      headers: gatewayHeaders(TENANT)
    });

    expect(encodedWithoutHeaders.statusCode).toBe(401);
    expect(wrongTenant.statusCode).toBe(403);
  });

  it("accepts the dedicated LUMEN BFF identity only with a LUMEN-bound assertion", async () => {
    const bound = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/lumen/worklist`,
      headers: lumenBffHeaders(TENANT)
    });
    const legacyAssertion = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/lumen/worklist`,
      headers: {
        ...lumenBffHeaders(TENANT),
        [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
          {
            operatorId: OPERATOR_ID,
            role: "advisor",
            tenantId: TENANT,
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          LUMEN_ASSERTION_KEY
        )
      }
    });

    expect(bound.statusCode).toBe(503);
    expect(bound.json().data.error).toContain("DATABASE_URL");
    expect(legacyAssertion.statusCode).toBe(403);
  });
});

function gatewayHeaders(tenantId: string, role = "advisor") {
  return {
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    "x-hyperion-caller": "api-gateway",
    "x-operator-id": OPERATOR_ID,
    "x-operator-role": role,
    [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
      { operatorId: OPERATOR_ID, role, tenantId, expiresAtUnix: Math.floor(Date.now() / 1000) + 60 },
      ASSERTION_KEY
    )
  };
}

function lumenBffHeaders(tenantId: string, role = "advisor") {
  return {
    authorization: `Bearer ${LUMEN_BFF_TOKEN}`,
    "x-hyperion-caller": "lumen-bff",
    "x-operator-id": OPERATOR_ID,
    "x-operator-role": role,
    [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
      {
        operatorId: OPERATOR_ID,
        role,
        tenantId,
        productId: "LUMEN",
        expiresAtUnix: Math.floor(Date.now() / 1000) + 60
      },
      LUMEN_ASSERTION_KEY
    )
  };
}
