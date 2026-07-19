import Fastify from "fastify";
import { createInternalAuthorizationHeaders } from "@hyperion/service-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAgendaReadinessRoute } from "./agenda-readiness-routes.js";

const TENANT_ID = "20000000-0000-4000-8000-000000000001";
const TOKEN = "integration-to-pulso-test-token";

describe("PULSO agenda readiness owner API", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];

  afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())).then(() => undefined));

  it("accepts only the dedicated Integration workload identity", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const app = buildApp(query);

    const missing = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/agenda/readiness`
    });
    const wrongCaller = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/agenda/readiness`,
      headers: createInternalAuthorizationHeaders("agent-service", TOKEN)
    });

    expect(missing.statusCode).toBe(401);
    expect([401, 403]).toContain(wrongCaller.statusCode);
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects an invalid tenant before querying PULSO data", async () => {
    const query = vi.fn();
    const app = buildApp(query);
    const response = await app.inject({
      method: "GET",
      url: "/internal/v1/tenants/not-a-uuid/pulso-iris/agenda/readiness",
      headers: createInternalAuthorizationHeaders("integration-service", TOKEN)
    });

    expect(response.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("projects readiness from tenant-scoped PULSO-owned configuration", async () => {
    const query = vi.fn(async (sql: string, _params: unknown[]) =>
      sql.includes("insert into pulso_iris.agenda_settings")
        ? { rows: [], rowCount: 1 }
        : {
            rows: [
              {
                mode: "internal",
                status: "active",
                activeProfessionalCount: 2,
                activeAvailabilityRuleCount: 3
              }
            ],
            rowCount: 1
          }
    );
    const app = buildApp(query);
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${TENANT_ID}/pulso-iris/agenda/readiness`,
      headers: createInternalAuthorizationHeaders("integration-service", TOKEN)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      tenantId: TENANT_ID,
      ready: true,
      mode: "internal",
      status: "active",
      activeProfessionalCount: 2,
      activeAvailabilityRuleCount: 3
    });
    expect(response.json().data.checkedAt).toEqual(expect.any(String));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("insert into pulso_iris.agenda_settings");
    expect(query.mock.calls[0]?.[0]).toContain("on conflict (tenant_id) do nothing");
    expect(query.mock.calls[0]?.[1]).toEqual([TENANT_ID]);
    expect(query.mock.calls[1]?.[1]).toEqual([TENANT_ID]);
  });

  function buildApp(query: ReturnType<typeof vi.fn>) {
    const app = Fastify();
    apps.push(app);
    registerAgendaReadinessRoute(
      app,
      {
        db: { query },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
      } as never,
      TOKEN
    );
    return app;
  }
});
