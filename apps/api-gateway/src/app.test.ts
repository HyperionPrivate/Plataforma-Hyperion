import { createService } from "@hyperion/service-runtime";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const VALID_TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  const handle = await createService({
    serviceName: "api-gateway",
    databaseRequired: false,
    publicApi: true,
    registerRoutes
  });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
});

describe("api-gateway routes", () => {
  it("serves the platform catalog with all services", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/platform/catalog" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.services).toHaveLength(9);
    expect(body.meta.generatedAt).toBeTruthy();
  });

  it("rejects tenant ids that are not UUIDs before proxying", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/not-a-uuid/pulso-iris/overview"
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().data.error).toContain("UUID");
  });

  it("blocks path traversal attempts in the tenant segment", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/abc%2F..%2F..%2Fpulso-iris%2Fcatalog/pulso-iris/overview"
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns an enveloped 502 when the upstream service is unavailable", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`,
      headers: { "x-request-id": "corr-gateway-502" }
    });

    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.data.error).toBeTruthy();
    expect(body.meta.requestId).toBe("corr-gateway-502");
  });

  it("reports platform health as down when no downstream responds", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/platform/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("down");
    expect(body.services).toHaveLength(8);
  }, 15_000);
});
