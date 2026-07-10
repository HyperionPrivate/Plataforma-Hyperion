import { createService } from "@hyperion/service-runtime";
import type { AuthMe } from "@hyperion/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGatewayRoutes } from "./app.js";

const AUTHORIZED_TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const OTHER_TENANT_ID = "3b8e6d4c-2a19-4f87-b6e5-1d0c9b8a7f6e";
const ADMIN_TOKEN = "admin-test-token-1234567890";
const COORDINATOR_TOKEN = "coordinator-test-token-1234567890";
const ADVISOR_TOKEN = "advisor-test-token-1234567890";
const AUDITOR_TOKEN = "auditor-test-token-1234567890";

const isolatedServiceUrls = {
  IDENTITY_SERVICE_URL: "http://127.0.0.1:65511",
  TENANT_SERVICE_URL: "http://127.0.0.1:65512",
  AGENT_SERVICE_URL: "http://127.0.0.1:65513",
  PROMPT_FLOW_SERVICE_URL: "http://127.0.0.1:65514",
  KNOWLEDGE_SERVICE_URL: "http://127.0.0.1:65515",
  AUDIT_SERVICE_URL: "http://127.0.0.1:65516",
  INTEGRATION_SERVICE_URL: "http://127.0.0.1:65517",
  PULSO_IRIS_SERVICE_URL: "http://127.0.0.1:65518",
  WHATSAPP_CHANNEL_SERVICE_URL: "http://127.0.0.1:65519",
  LUMEN_SERVICE_URL: "http://127.0.0.1:65520"
} as const;

const previousServiceUrls = Object.fromEntries(
  Object.keys(isolatedServiceUrls).map((name) => [name, process.env[name]])
);

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
  [COORDINATOR_TOKEN]: {
    operator: {
      id: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      email: "coordinador@hyperion.local",
      displayName: "Coordinador",
      role: "coordinator"
    },
    tenantIds: [AUTHORIZED_TENANT_ID]
  },
  [ADVISOR_TOKEN]: {
    operator: {
      id: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d",
      email: "asesor@hyperion.local",
      displayName: "Asesor",
      role: "advisor"
    },
    tenantIds: [AUTHORIZED_TENANT_ID]
  },
  [AUDITOR_TOKEN]: {
    operator: {
      id: "3c4d5e6f-7081-4a8b-9c0d-1e2f3a4b5c6d",
      email: "auditor@hyperion.local",
      displayName: "Auditor",
      role: "auditor"
    },
    tenantIds: [AUTHORIZED_TENANT_ID]
  }
};

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  Object.assign(process.env, isolatedServiceUrls);
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
  for (const [name, value] of Object.entries(previousServiceUrls)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
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
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
    });

    expect(response.statusCode).toBe(403);
  });

  it("lets an operator through to an assigned tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
    });

    // Authorization passed; upstream is not running in tests.
    expect(response.statusCode).toBe(502);
  });

  it("allows coordinator to write configuration", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/sites`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: { name: "Sede de prueba" }
    });

    // Authorization and routing passed; upstream is not running in tests.
    expect(response.statusCode).toBe(502);
  });

  it("allows coordinator to write holidays and payer exclusions", async () => {
    const holiday = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/holidays`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: { holidayDate: "2026-12-25", name: "Navidad" }
    });
    const exclusion = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/payer-exclusions/00000000-0000-4000-8000-000000000001`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: { status: "paused" }
    });

    expect(holiday.statusCode).toBe(502);
    expect(exclusion.statusCode).toBe(502);
  });

  it("forbids advisor from writing configuration", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/sites`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { name: "Sede de prueba" }
    });

    expect(response.statusCode).toBe(403);
  });

  it("forbids advisor from writing holidays and payer exclusions", async () => {
    const holiday = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/holidays`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { holidayDate: "2026-12-25", name: "Navidad" }
    });
    const exclusion = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/payer-exclusions`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: {
        professionalId: "00000000-0000-4000-8000-000000000001",
        payerId: "00000000-0000-4000-8000-000000000002"
      }
    });

    expect(holiday.statusCode).toBe(403);
    expect(exclusion.statusCode).toBe(403);
  });

  it("allows advisor to write operational records", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: {}
    });

    expect(response.statusCode).toBe(502);
  });

  it("reserves appointment verification and state changes for coordinators", async () => {
    const appointmentId = "00000000-0000-4000-8000-000000000010";
    const advisorVerify = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments/${appointmentId}/manual-verify`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { externalReference: "masked-reference", externalSystem: "manual" }
    });
    const advisorPatch = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments/${appointmentId}`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { status: "verified" }
    });
    const coordinatorVerify = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments/${appointmentId}/manual-verify`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: { externalReference: "masked-reference", externalSystem: "manual" }
    });

    expect(advisorVerify.statusCode).toBe(403);
    expect(advisorPatch.statusCode).toBe(403);
    expect(coordinatorVerify.statusCode).toBe(502);
  });

  it("keeps auditor as read-only", async () => {
    const read = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/dashboard/live`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` }
    });
    const write = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` },
      payload: {}
    });
    const holidayWrite = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/holidays`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` },
      payload: { holidayDate: "2026-12-25", name: "Navidad" }
    });
    const holidayRead = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/holidays`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` }
    });

    expect(read.statusCode).toBe(502);
    expect(write.statusCode).toBe(403);
    expect(holidayWrite.statusCode).toBe(403);
    expect(holidayRead.statusCode).toBe(502);
  });

  it("requires admin role for operator management", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: {}
    });
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {}
    });

    expect(forbidden.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(502);
  });

  it("enforces WhatsApp integration RBAC at the gateway", async () => {
    const base = `/v1/tenants/${AUTHORIZED_TENANT_ID}/integrations/whatsapp`;
    const coordinatorStatus = await app.inject({
      method: "GET",
      url: `${base}/status`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
    });
    const advisorStatus = await app.inject({
      method: "GET",
      url: `${base}/status`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` }
    });
    const auditorQr = await app.inject({
      method: "GET",
      url: `${base}/qr`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` }
    });
    const adminQr = await app.inject({
      method: "GET",
      url: `${base}/qr`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    const coordinatorConnect = await app.inject({
      method: "POST",
      url: `${base}/connect`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: {}
    });
    const adminConnect = await app.inject({
      method: "POST",
      url: `${base}/connect`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {}
    });

    expect(coordinatorStatus.statusCode).toBe(502);
    expect(advisorStatus.statusCode).toBe(403);
    expect(auditorQr.statusCode).toBe(403);
    expect(adminQr.statusCode).toBe(502);
    expect(adminQr.headers["cache-control"]).toContain("no-store");
    expect(adminQr.headers.pragma).toBe("no-cache");
    expect(coordinatorConnect.statusCode).toBe(403);
    expect(adminConnect.statusCode).toBe(502);
  });

  it("rejects path traversal in the proxied suffix", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/..%2Fadmin`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(400);
  });

  it("lists tenants through the gateway", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    // Tenant service is not running in tests.
    expect(response.statusCode).toBe(502);
  });

  it("enforces tenant membership and role permissions for LUMEN", async () => {
    const encounterId = "00000000-0000-4000-8000-000000000020";
    const advisorWrite = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/encounters/${encounterId}/start`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: {}
    });
    const auditorRead = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/worklist`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` }
    });
    const auditorWrite = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/encounters/${encounterId}/start`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` },
      payload: {}
    });
    const foreignTenant = await app.inject({
      method: "GET",
      url: `/v1/tenants/${OTHER_TENANT_ID}/lumen/worklist`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
    });

    expect(advisorWrite.statusCode).toBe(502);
    expect(auditorRead.statusCode).toBe(502);
    expect(auditorWrite.statusCode).toBe(403);
    expect(foreignTenant.statusCode).toBe(403);
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
    expect(body.data.services).toHaveLength(11);
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
    expect(body.services).toHaveLength(10);
  }, 15_000);
});
