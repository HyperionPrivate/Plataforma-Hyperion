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
const PULSO_TOKEN = "integration-to-pulso-test-token";
const GATEWAY_TOKEN = "gateway-to-integration-test-token-001";
const PULSO_BFF_TOKEN = "pulso-bff-to-integration-test-token";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const PULSO_ASSERTION_KEY = "pulso-operator-assertion-key-0001";
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
const agendaReadiness = {
  tenantId,
  ready: true,
  mode: "internal",
  status: "active",
  activeProfessionalCount: 1,
  activeAvailabilityRuleCount: 1,
  checkedAt: "2026-07-17T12:00:00.000Z"
};

describe("WhatsApp integration facade RBAC", () => {
  const fetchImpl = vi.fn();
  const dbQuery = vi.fn();
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    process.env.INTEGRATION_TO_CHANNEL_TOKEN = CHANNEL_TOKEN;
    process.env.INTEGRATION_TO_SOFIA_TOKEN = SOFIA_TOKEN;
    process.env.INTEGRATION_TO_PULSO_TOKEN = PULSO_TOKEN;
    process.env.PULSO_IRIS_SERVICE_URL = "http://pulso-owner.test";
    process.env.GATEWAY_TO_INTEGRATION_TOKEN = GATEWAY_TOKEN;
    process.env.GATEWAY_OPERATOR_ASSERTION_KEY = ASSERTION_KEY;
    process.env.PULSO_BFF_TO_INTEGRATION_TOKEN = PULSO_BFF_TOKEN;
    process.env.PULSO_OPERATOR_ASSERTION_KEY = PULSO_ASSERTION_KEY;
    fetchImpl.mockReset();
    dbQuery.mockReset();
    dbQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("integration_runtime.tenant_snapshots")) {
        return {
          rows: [{ status: "active", sourceVersion: "1" }],
          rowCount: 1,
          command: "SELECT",
          oid: 0,
          fields: []
        };
      }
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    });
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
    delete process.env.INTEGRATION_TO_PULSO_TOKEN;
    delete process.env.PULSO_IRIS_SERVICE_URL;
    delete process.env.GATEWAY_TO_INTEGRATION_TOKEN;
    delete process.env.GATEWAY_OPERATOR_ASSERTION_KEY;
    delete process.env.PULSO_BFF_TO_INTEGRATION_TOKEN;
    delete process.env.PULSO_OPERATOR_ASSERTION_KEY;
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
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: agendaReadiness }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
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
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      `http://pulso-owner.test/internal/v1/tenants/${tenantId}/pulso-iris/agenda/readiness`
    );
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${PULSO_TOKEN}` });
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(String(dbQuery.mock.calls[0]?.[0])).toContain("integration_runtime.tenant_snapshots");
  });

  it("fails closed with 502 when the PULSO owner API returns an upstream failure", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ...status, state: "ready" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ready: true, workerEnabled: true, workerRunning: true, model: "controlled" } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "owner unavailable" }), {
          status: 502,
          headers: { "content-type": "application/json" }
        })
      );
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/sofia/readiness`,
      headers: gatewayHeaders("coordinator")
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().data).toEqual({ error: "PULSO agenda readiness unavailable" });
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(String(dbQuery.mock.calls[0]?.[0])).toContain("integration_runtime.tenant_snapshots");
  });

  it("fails closed with 502 when the PULSO owner API times out", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ...status, state: "ready" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ready: true, workerEnabled: true, workerRunning: true, model: "controlled" } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockRejectedValueOnce(Object.assign(new Error("PULSO timeout"), { name: "TimeoutError" }));
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/sofia/readiness`,
      headers: gatewayHeaders("coordinator")
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().data).toEqual({ error: "PULSO agenda readiness unavailable" });
    expect(fetchImpl.mock.calls[2]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(String(dbQuery.mock.calls[0]?.[0])).toContain("integration_runtime.tenant_snapshots");
  });

  it("fails closed when the PULSO owner response belongs to another tenant", async () => {
    fetchImpl
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { ...status, state: "ready" } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ready: true, workerEnabled: true, workerRunning: true, model: "controlled" } }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { ...agendaReadiness, tenantId: "00000000-0000-4000-8000-000000000099" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/sofia/readiness`,
      headers: gatewayHeaders("coordinator")
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().data).toEqual({ error: "PULSO agenda readiness unavailable" });
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

  it("accepts the dedicated PULSO BFF identity only with a product-bound assertion", async () => {
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: status }), { status: 200, headers: { "content-type": "application/json" } })
    );
    const bound = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/whatsapp/status`,
      headers: pulsoBffHeaders("coordinator")
    });
    const legacy = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/integrations/whatsapp/status`,
      headers: {
        ...pulsoBffHeaders("coordinator"),
        [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
          {
            operatorId: OPERATOR_ID,
            role: "coordinator",
            tenantId,
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          PULSO_ASSERTION_KEY
        )
      }
    });

    expect(bound.statusCode).toBe(200);
    expect(legacy.statusCode).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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

function pulsoBffHeaders(role: "admin" | "coordinator" | "advisor" | "auditor") {
  return {
    ...createInternalAuthorizationHeaders("pulso-bff", PULSO_BFF_TOKEN),
    "x-operator-id": OPERATOR_ID,
    "x-operator-role": role,
    [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
      {
        operatorId: OPERATOR_ID,
        role,
        tenantId,
        productId: "PULSO_IRIS",
        expiresAtUnix: Math.floor(Date.now() / 1000) + 60
      },
      PULSO_ASSERTION_KEY
    )
  };
}
