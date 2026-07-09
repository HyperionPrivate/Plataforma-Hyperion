import { createService } from "@hyperion/service-runtime";
import type { AuthMe } from "@hyperion/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayRoutes } from "./app.js";

const AUTHORIZED_TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const OTHER_TENANT_ID = "3b8e6d4c-2a19-4f87-b6e5-1d0c9b8a7f6e";
const ADMIN_TOKEN = "admin-test-token-1234567890";
const OPERATOR_TOKEN = "operator-test-token-1234567890";

const sessions: Record<string, AuthMe> = {
  [ADMIN_TOKEN]: {
    operator: {
      id: "9c8b7a6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d",
      email: "admin@hyperion.local",
      displayName: "Admin",
      role: "admin"
    },
    tenantIds: []
  },
  [OPERATOR_TOKEN]: {
    operator: {
      id: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      email: "operador@hyperion.local",
      displayName: "Operador",
      role: "operator"
    },
    tenantIds: [AUTHORIZED_TENANT_ID]
  }
};

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  const handle = await createService({
    serviceName: "api-gateway",
    databaseRequired: false,
    publicApi: true,
    registerRoutes: createGatewayRoutes({
      resolveSession: async (token) => sessions[token]
    })
  });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
});

describe("api-gateway authentication", () => {
  it("rejects business routes without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/platform/catalog" });

    expect(response.statusCode).toBe(401);
  });

  it("rejects business routes with an unknown token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/platform/catalog",
      headers: { authorization: "Bearer unknown-token-1234567890" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("keeps the login route public (proxied upstream)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "admin@hyperion.local", password: "supersecret" }
    });

    expect(response.statusCode).toBe(502);
  });

  it("forbids tenants the operator is not assigned to", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${OTHER_TENANT_ID}/pulso-iris/overview`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
    });

    expect(response.statusCode).toBe(403);
  });

  it("lets an operator through to an assigned tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
    });

    // Authorization passed; upstream is not running in tests.
    expect(response.statusCode).toBe(502);
  });
});

describe("api-gateway routes", () => {
  it("serves the platform catalog with all services", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/platform/catalog",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.services).toHaveLength(9);
    expect(body.meta.generatedAt).toBeTruthy();
  });

  it("rejects tenant ids that are not UUIDs before proxying", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/not-a-uuid/pulso-iris/overview",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().data.error).toContain("UUID");
  });

  it("blocks path traversal attempts in the tenant segment", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/abc%2F..%2F..%2Fpulso-iris%2Fcatalog/pulso-iris/overview",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns an enveloped 502 when the upstream service is unavailable", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "x-request-id": "corr-gateway-502"
      }
    });

    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.data.error).toBeTruthy();
    expect(body.meta.requestId).toBe("corr-gateway-502");
  });

  it("reports platform health as down when no downstream responds", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/platform/health",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("down");
    expect(body.services).toHaveLength(8);
  }, 15_000);
});
