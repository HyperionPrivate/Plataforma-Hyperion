import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const TEST_TOKEN = "test-sofia-to-audit-token";
const GATEWAY_TOKEN = "test-gateway-to-audit-token";
const CALLER = "agent-service";

describe("audit-service without internal token configured", () => {
  let app: ServiceHandle["app"];

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.CHANNEL_TO_AUDIT_TOKEN;
    delete process.env.PULSO_TO_AUDIT_TOKEN;
    delete process.env.SOFIA_TO_AUDIT_TOKEN;
    const handle = await createService({
      serviceName: "audit-service",
      databaseRequired: true,
      registerRoutes
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it("refuses event writes when workload credentials are missing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/audit/events",
      payload: { eventType: "test.event", entityType: "test" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().data.error).toContain("credentials are not configured");
  });
});

describe("audit-service with internal token configured", () => {
  let app: ServiceHandle["app"];

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    process.env.SOFIA_TO_AUDIT_TOKEN = TEST_TOKEN;
    const handle = await createService({
      serviceName: "audit-service",
      databaseRequired: true,
      registerRoutes
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.SOFIA_TO_AUDIT_TOKEN;
    delete process.env.GATEWAY_TO_AUDIT_TOKEN;
  });

  it("rejects writes without a bearer token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/audit/events",
      payload: { eventType: "test.event", entityType: "test" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects writes with a wrong bearer token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/audit/events",
      headers: { authorization: "Bearer wrong-token", "x-hyperion-caller": CALLER },
      payload: { eventType: "test.event", entityType: "test" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("accepts the token but requires a database for writes", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/audit/events",
      headers: { authorization: `Bearer ${TEST_TOKEN}`, "x-hyperion-caller": CALLER },
      payload: { eventType: "test.event", entityType: "test" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().data.error).toContain("DATABASE_URL");
  });

  it("rejects a valid edge token when a different workload claims it", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/audit/events",
      headers: { authorization: `Bearer ${TEST_TOKEN}`, "x-hyperion-caller": "pulso-iris-service" },
      payload: { eventType: "test.event", entityType: "test" }
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects anonymous GET /v1/audit/events", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/audit/events" });

    expect(response.statusCode).toBe(503);
  });

  it("rejects GET /v1/audit/events without a bearer token", async () => {
    process.env.GATEWAY_TO_AUDIT_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: { "x-hyperion-caller": "api-gateway" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects GET /v1/audit/events with a wrong bearer token", async () => {
    process.env.GATEWAY_TO_AUDIT_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: {
        authorization: "Bearer wrong-gateway-token-value",
        "x-hyperion-caller": "api-gateway"
      }
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects GET /v1/audit/events for a non-gateway caller", async () => {
    process.env.GATEWAY_TO_AUDIT_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "x-hyperion-caller": "agent-service"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("allows GET /v1/audit/events for the gateway edge", async () => {
    process.env.GATEWAY_TO_AUDIT_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/audit/events",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "x-hyperion-caller": "api-gateway"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });
});
