import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const VALID_TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";

let app: ServiceHandle["app"];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  const handle = await createService({
    serviceName: "pulso-iris-service",
    databaseRequired: true,
    registerRoutes
  });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
});

describe("pulso-iris-service routes", () => {
  it("exposes the product health with SOFIA as agent", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/pulso-iris/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.product).toBe("PULSO_IRIS");
    expect(body.data.agent).toBe("SOFIA");
  });

  it("serves the PULSO IRIS catalog", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/pulso-iris/catalog" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.product.name).toBe("PULSO IRIS");
    expect(body.data.modules.length).toBeGreaterThan(0);
  });

  it("rejects tenant ids that are not UUIDs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/123/pulso-iris/conversations"
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 for tenant data when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().data.error).toContain("DATABASE_URL");
  });

  it("reports readiness as down without a database", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("down");
  });

  it("validates the tenant on config routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/no-uuid/pulso-iris/config/sites"
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 for config writes when the database is not configured", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/config/professionals`,
      payload: { name: "Dra. Prueba", professionalType: "optometrist" }
    });

    expect(response.statusCode).toBe(503);
  });
});
