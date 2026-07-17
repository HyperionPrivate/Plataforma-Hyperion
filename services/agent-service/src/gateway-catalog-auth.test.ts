import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const GATEWAY_TOKEN = "test-gateway-to-sofia-token-01";

describe("agent-service gateway catalog auth", () => {
  let app: ServiceHandle["app"];

  beforeAll(async () => {
    delete process.env.DATABASE_URL;
    delete process.env.GATEWAY_TO_SOFIA_TOKEN;
    const handle = await createService({
      serviceName: "agent-service",
      databaseRequired: true,
      registerRoutes
    });
    app = handle.app;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.GATEWAY_TO_SOFIA_TOKEN;
  });

  beforeEach(() => {
    delete process.env.GATEWAY_TO_SOFIA_TOKEN;
  });

  for (const path of ["/v1/products", "/v1/agents"] as const) {
    describe(path, () => {
      it("rejects anonymous reads when the edge credential is missing", async () => {
        const response = await app.inject({ method: "GET", url: path });
        expect(response.statusCode).toBe(503);
      });

      it("rejects reads without a bearer token", async () => {
        process.env.GATEWAY_TO_SOFIA_TOKEN = GATEWAY_TOKEN;
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: { "x-hyperion-caller": "api-gateway" }
        });
        expect(response.statusCode).toBe(401);
      });

      it("rejects reads with a wrong bearer token", async () => {
        process.env.GATEWAY_TO_SOFIA_TOKEN = GATEWAY_TOKEN;
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: {
            authorization: "Bearer wrong-sofia-edge-token-00",
            "x-hyperion-caller": "api-gateway"
          }
        });
        expect(response.statusCode).toBe(401);
      });

      it("rejects a valid token from a non-gateway caller", async () => {
        process.env.GATEWAY_TO_SOFIA_TOKEN = GATEWAY_TOKEN;
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: {
            authorization: `Bearer ${GATEWAY_TOKEN}`,
            "x-hyperion-caller": "pulso-iris-service"
          }
        });
        expect(response.statusCode).toBe(403);
      });

      it("allows the gateway edge", async () => {
        process.env.GATEWAY_TO_SOFIA_TOKEN = GATEWAY_TOKEN;
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: {
            authorization: `Bearer ${GATEWAY_TOKEN}`,
            "x-hyperion-caller": "api-gateway"
          }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().data).toEqual([]);
      });
    });
  }
});
