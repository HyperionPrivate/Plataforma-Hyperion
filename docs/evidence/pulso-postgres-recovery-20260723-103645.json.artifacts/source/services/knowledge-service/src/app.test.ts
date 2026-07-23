import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const GATEWAY_TOKEN = "test-gateway-to-knowledge-tok";

describe("knowledge-service GET /v1/knowledge-sources auth", () => {
  let app: ServiceHandle["app"];

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.GATEWAY_TO_KNOWLEDGE_TOKEN;
    const handle = await createService({
      serviceName: "knowledge-service",
      databaseRequired: true,
      registerRoutes
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.GATEWAY_TO_KNOWLEDGE_TOKEN;
  });

  it("rejects anonymous reads when the edge credential is missing", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/knowledge-sources" });
    expect(response.statusCode).toBe(503);
  });

  it("rejects reads without a bearer token", async () => {
    process.env.GATEWAY_TO_KNOWLEDGE_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/knowledge-sources",
      headers: { "x-hyperion-caller": "api-gateway" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects reads with a wrong bearer token", async () => {
    process.env.GATEWAY_TO_KNOWLEDGE_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/knowledge-sources",
      headers: {
        authorization: "Bearer wrong-knowledge-edge-token",
        "x-hyperion-caller": "api-gateway"
      }
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a valid token from a non-gateway caller", async () => {
    process.env.GATEWAY_TO_KNOWLEDGE_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/knowledge-sources",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "x-hyperion-caller": "audit-service"
      }
    });
    expect(response.statusCode).toBe(403);
  });

  it("allows the gateway edge", async () => {
    process.env.GATEWAY_TO_KNOWLEDGE_TOKEN = GATEWAY_TOKEN;
    const response = await app.inject({
      method: "GET",
      url: "/v1/knowledge-sources",
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "x-hyperion-caller": "api-gateway"
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });
});
