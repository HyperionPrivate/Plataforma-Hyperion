import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAnalyticsRoutes } from "./analytics-routes.js";

const tenantId = "00000000-0000-4000-8000-000000000001";
const conversationId = "00000000-0000-4000-8000-000000000002";
const patientId = "00000000-0000-4000-8000-000000000003";

describe("conversation analytics projections", () => {
  const query = vi.fn();
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    query.mockReset();
    app = Fastify();
    await registerAnalyticsRoutes(app, {
      config: {
        serviceName: "pulso-iris-service",
        environment: "test",
        host: "127.0.0.1",
        port: 8088,
        serviceVersion: "test",
        corsAllowedOrigins: []
      },
      db: {
        query,
        transaction: vi.fn(),
        close: vi.fn()
      } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("uses only the latest appointment projection so a reschedule cannot duplicate the inbox row", async () => {
    query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("pulso_iris.tenant_snapshots")) {
        return { rows: [{ status: "active", sourceVersion: "1" }] };
      }
      return {
        rows: [
          {
            id: conversationId,
            channel: "whatsapp",
            status: "active",
            startedAt: "2026-07-09T12:00:00.000Z",
            updatedAt: "2026-07-09T12:00:00.000Z"
          }
        ]
      };
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/conversations/inbox`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    const sql = String(query.mock.calls.find((call) => String(call[0]).includes("left join lateral"))?.[0]);
    expect(sql).toContain("left join lateral");
    expect(sql).toContain("order by appointment.created_at desc");
    expect(sql).toContain("limit 1");
  });

  it("binds dashboard analytics to the tenant agenda timezone", async () => {
    query.mockImplementation(async (sqlValue: unknown, params?: unknown[]) => {
      const sql = String(sqlValue);
      if (sql.includes("pulso_iris.tenant_snapshots")) {
        return { rows: [{ status: "active", sourceVersion: "1" }] };
      }
      if (sql.includes("from pulso_iris.agenda_settings") && sql.includes("timezone")) {
        return { rows: [{ timezone: "America/New_York" }] };
      }
      return {
        rows: [
          {
            interactionsActive: 0,
            whatsappToday: 0,
            voiceToday: 0,
            whatsappYesterday: 0,
            voiceYesterday: 0,
            resolvedToday: 0,
            handoffToday: 0,
            abandonedToday: 0,
            appointmentsTodayBySofia: 0,
            handoffsOpen: 0
          }
        ]
      };
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/dashboard/live`
    });

    expect(response.statusCode).toBe(200);
    const timezoneLookup = query.mock.calls.find(
      ([sql]) => String(sql).includes("from pulso_iris.agenda_settings") && String(sql).includes("timezone")
    );
    expect(timezoneLookup?.[1]).toEqual([tenantId, "America/Bogota"]);
    expect(
      query.mock.calls.some(
        ([sql, params]) => String(sql).includes("timezone($2, started_at)") && params?.[1] === "America/New_York"
      )
    ).toBe(true);
  });

  it("projects the masked WhatsApp identity without selecting the full phone", async () => {
    query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue);
      if (sql.includes("pulso_iris.tenant_snapshots")) {
        return { rows: [{ status: "active", sourceVersion: "1" }] };
      }
      if (sql.includes("from pulso_iris.conversations c") && sql.includes("c.id = $2")) {
        return { rows: [{ id: conversationId, patientId, channel: "whatsapp", status: "active" }] };
      }
      if (sql.includes("from pulso_iris.administrative_patients") && sql.includes("id = $2")) {
        return { rows: [{ id: patientId, fullName: null, phoneMasked: "****1234", status: "active" }] };
      }
      return { rows: [] };
    });

    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/pulso-iris/conversations/${conversationId}/timeline`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.patient).toMatchObject({ phoneMasked: "****1234" });
    expect(response.json().data.patient).not.toHaveProperty("phone");
    const patientSql = query.mock.calls.map((call) => String(call[0])).find((sql) => sql.includes("phone_masked"));
    expect(patientSql).toContain('phone_masked as "phoneMasked"');
    expect(patientSql).not.toMatch(/[,\s]phone[,\s]/);
  });
});
