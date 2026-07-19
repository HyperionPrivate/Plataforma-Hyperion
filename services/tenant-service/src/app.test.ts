import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const GATEWAY_TOKEN = "test-gateway-to-tenant-token";
const PLATFORM_ADMIN_TOKEN = "test-platform-admin-tenant-token";

describe("tenant-service GET /v1/tenants auth", () => {
  let app: ServiceHandle["app"];

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.GATEWAY_TO_TENANT_TOKEN;
    delete process.env.PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN;
    const handle = await createService({
      serviceName: "tenant-service",
      databaseRequired: true,
      registerRoutes
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.GATEWAY_TO_TENANT_TOKEN;
    delete process.env.PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN;
  });

  it("rejects anonymous reads when the edge credential is missing", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/tenants" });
    expect(response.statusCode).toBe(503);
  });

  it("rejects reads without a bearer token", async () => {
    process.env.GATEWAY_TO_TENANT_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: { "x-hyperion-caller": "api-gateway" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects reads with a wrong bearer token", async () => {
    process.env.GATEWAY_TO_TENANT_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: {
        authorization: "Bearer wrong-tenant-edge-token",
        "x-hyperion-caller": "api-gateway"
      }
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a valid token from a non-gateway caller", async () => {
    process.env.GATEWAY_TO_TENANT_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "x-hyperion-caller": "agent-service"
      }
    });
    expect(response.statusCode).toBe(403);
  });

  it("allows the gateway edge", async () => {
    process.env.GATEWAY_TO_TENANT_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "x-hyperion-caller": "api-gateway"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  it("allows only the dedicated platform-admin edge token for its caller", async () => {
    process.env.PLATFORM_ADMIN_BFF_TO_TENANT_TOKEN = PLATFORM_ADMIN_TOKEN;
    const accepted = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: {
        authorization: `Bearer ${PLATFORM_ADMIN_TOKEN}`,
        "x-hyperion-caller": "platform-admin-bff"
      }
    });
    const crossed = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "x-hyperion-caller": "platform-admin-bff"
      }
    });
    expect(accepted.statusCode).toBe(200);
    expect(crossed.statusCode).toBe(401);
  });
});
