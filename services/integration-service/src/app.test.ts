import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./app.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
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
        corsAllowedOrigins: [],
        internalServiceToken: "internal-controlled-token"
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
      headers: { "x-operator-role": "coordinator" }
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toMatchObject({ providerMode: "whatsapp_web_test", state: "qr_pending" });

    const mutate = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/integrations/whatsapp/connect`,
      headers: { "x-operator-role": "coordinator" },
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
        headers: { "x-operator-role": "auditor" }
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
      headers: { "x-operator-role": "admin" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("sessionMaterial");
    expect(response.body).not.toContain("must-not-leak");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: "Bearer internal-controlled-token" });
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
      headers: { "x-operator-role": "coordinator" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: "degraded",
      canReceiveMessages: false,
      canBookAppointments: false
    });
    const promptQuery = String(dbQuery.mock.calls[1]?.[0]);
    expect(promptQuery).toContain("sofia_whatsapp_internal_v4");
    expect(promptQuery).toContain("015-sofia-fresh-availability.sql");
    expect(promptQuery).toContain("order by f.version desc, f.updated_at desc");
  });
});
