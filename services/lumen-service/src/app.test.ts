import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const TENANT = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const GATEWAY_TOKEN = "gateway-to-lumen-test-token";
const GATEWAY_HEADERS = {
  authorization: `Bearer ${GATEWAY_TOKEN}`,
  "x-hyperion-caller": "api-gateway"
};
let app: ServiceHandle["app"];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GATEWAY_TO_LUMEN_TOKEN = GATEWAY_TOKEN;
  const handle = await createService({ serviceName: "lumen-service", databaseRequired: true, registerRoutes });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
  delete process.env.GATEWAY_TO_LUMEN_TOKEN;
});

describe("lumen-service", () => {
  it("exposes catalog and provider readiness without secrets", async () => {
    const catalog = await app.inject({ method: "GET", url: "/v1/lumen/catalog" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().data.product.code).toBe("LUMEN");

    const health = await app.inject({ method: "GET", url: "/v1/lumen/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().data.providers).toMatchObject({
      transcriptionConfigured: false,
      transcriptionProvider: "elevenlabs",
      transcriptionModel: "scribe_v2",
      transcriptionLanguage: "spa",
      zeroRetentionRequired: true,
      structuringConfigured: false,
      structuringProvider: "deepseek"
    });
  });

  it("rejects invalid tenants and reports a missing database", async () => {
    const unauthenticated = await app.inject({ method: "GET", url: `/v1/tenants/${TENANT}/lumen/worklist` });
    expect(unauthenticated.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/tenants/no-uuid/lumen/worklist",
      headers: GATEWAY_HEADERS
    });
    expect(invalid.statusCode).toBe(400);

    const unavailable = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/lumen/worklist`,
      headers: GATEWAY_HEADERS
    });
    expect(unavailable.statusCode).toBe(503);
  });

  it("rejects a non-gateway workload even when it presents the gateway token", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT}/lumen/worklist`,
      headers: { authorization: `Bearer ${GATEWAY_TOKEN}`, "x-hyperion-caller": "agent-service" }
    });

    expect(response.statusCode).toBe(403);
  });
});
