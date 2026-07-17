import Fastify from "fastify";
import {
  OPERATOR_ASSERTION_HEADER,
  createInternalAuthorizationHeaders,
  createOperatorAssertion
} from "@hyperion/service-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./app.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const CHANNEL_TOKEN = "integration-to-channel-test-token";
const SOFIA_TOKEN = "integration-to-sofia-test-token";
const GATEWAY_TOKEN = "gateway-to-integration-test-token-001";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const status = {
  tenantId,
  providerMode: "whatsapp_web_test",
  state: "qr_pending",
  phoneMasked: null,
  lastActivityAt: null,
  lastError: null,
  qrExpiresAt: "2026-07-09T21:00:00.000Z",
  sessionRestorable: false
};

describe("WhatsApp integration facade RBAC", () => {
  const fetchImpl = vi.fn();
  const dbQuery = vi.fn();
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    process.env.INTEGRATION_TO_CHANNEL_TOKEN = CHANNEL_TOKEN;
    process.env.INTEGRATION_TO_SOFIA_TOKEN = SOFIA_TOKEN;
    process.env.GATEWAY_TO_INTEGRATION_TOKEN = GATEWAY_TOKEN;
    process.env.GATEWAY_OPERATOR_ASSERTION_KEY = ASSERTION_KEY;
    fetchImpl.mockReset();
    dbQuery.mockReset();
    dbQuery.mockResolvedValue({ rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] });
    vi.stubGlobal("fetch", fetchImpl);
    app = Fastify();
    await registerRoutes(app, {
      config: {
        serviceName: "integration-service",
        environment: "test",
        host: "127.0.0.1",
        port: 8087,
        serviceVersion: "test",
        corsAllowedOrigins: []
      },
      db: {
        query: dbQuery,
        transaction: vi.fn(),
        close: vi.fn()
      } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
    });
  });

  afterEach(async () => {
    delete process.env.INTEGRATION_TO_CHANNEL_TOKEN;
    delete process.env.INTEGRATION_TO_SOFIA_TOKEN;
    delete process.env.GATEWAY_TO_INTEGRATION_TOKEN;
    delete process.env.GATEWAY_OPERATOR_ASSERTION_KEY;
    vi.unstubAllGlobals();
    await app.close();
  });

  it("allows coordinator status but blocks channel mutation", async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: status }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const read = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/whatsapp/status`,
      headers: gatewayHeaders("coordinator")
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({ providerMode: "whatsapp_web_test", state: "qr_pending" });

    const mutate = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/whatsapp/connect`,
      headers: gatewayHeaders("coordinator"),
      payload: {}
    });
    expect(mutate.statusCode).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not expose status or QR to auditor", async () => {
    for (const path of ["status", "qr"]) {
      const response = await app.inject({
        method: "GET",
        url: `/v1/tenants/${tenantId}/integrations/whatsapp/${path}`,
        headers: gatewayHeaders("auditor")
      });
      expect(response.statusCode).toBe(403);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("projects only the public QR contract for admin", async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            tenantId,
            providerMode: "whatsapp_web_test",
            state: "qr_pending",
            qrDataUrl: "data:image/png;base64,QUJDRA==",
            qrExpiresAt: "2026-07-09T21:00:00.000Z",
            sessionMaterial: "must-not-leak"
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/whatsapp/qr`,
      headers: gatewayHeaders("admin")
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("sessionMaterial");
    expect(response.body).not.toContain("must-not-leak");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${CHANNEL_TOKEN}`,
      "x-hyperion-caller": "integration-service"
    });
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers.pragma).toBe("no-cache");
  });

  it("does not report message readiness when the SOFIA worker is disabled", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ...status, state: "ready" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ready: true, workerEnabled: false, workerRunning: false, model: "controlled" } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    dbQuery
      .mockResolvedValueOnce({
        rows: [{ mode: "internal", status: "active", professionalCount: 1, ruleCount: 1 }]
      })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });

    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/sofia/readiness`,
      headers: gatewayHeaders("coordinator")
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: "degraded",
      canReceiveMessages: false,
      canBookAppointments: false
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${CHANNEL_TOKEN}` });
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${SOFIA_TOKEN}` });
    const promptQuery = String(dbQuery.mock.calls[1]?.[0]);
    expect(promptQuery).toContain("sofia_whatsapp_internal_v5");
    expect(promptQuery).toContain("016-sofia-search-constraints.sql");
    expect(promptQuery).toContain("order by f.version desc, f.updated_at desc");
  });

  it("does not trust operator headers without the gateway workload identity", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/whatsapp/connect`,
      headers: { "x-operator-role": "admin" },
      payload: {}
    });

    expect(response.statusCode).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects forged roles even when the gateway edge token is valid", async () => {
    const signedAdvisor = gatewayHeaders("advisor");
    const forged = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/whatsapp/connect`,
      headers: { ...signedAdvisor, "x-operator-role": "admin" },
      payload: {}
    });

    expect(forged.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a signed admin context before listing non-tenant integrations", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "integration-1" }] });
    const edgeOnly = await app.inject({
      method: "GET",
      url: "/v1/integrations",
      headers: {
        ...createInternalAuthorizationHeaders("api-gateway", GATEWAY_TOKEN),
        "x-operator-id": OPERATOR_ID,
        "x-operator-role": "admin"
      }
    });
    const signedAdmin = await app.inject({
      method: "GET",
      url: "/v1/integrations",
      headers: gatewayHeaders("admin", null)
    });

    expect(edgeOnly.statusCode).toBe(403);
    expect(signedAdmin.statusCode).toBe(200);
    expect(signedAdmin.json().data).toEqual([{ id: "integration-1" }]);
  });
});

function gatewayHeaders(role: "admin" | "coordinator" | "advisor" | "auditor", tenantScope: string | null = tenantId) {
  return {
    ...createInternalAuthorizationHeaders("api-gateway", GATEWAY_TOKEN),
    "x-operator-id": OPERATOR_ID,
    "x-operator-role": role,
    [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
      {
        operatorId: OPERATOR_ID,
        role,
        ...(tenantScope ? { tenantId: tenantScope } : {}),
        expiresAtUnix: Math.floor(Date.now() / 1000) + 60
      },
      ASSERTION_KEY
    )
  };
}
