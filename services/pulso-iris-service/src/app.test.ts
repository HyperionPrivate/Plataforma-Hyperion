import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDurableOutboxConfiguration, registerRoutes } from "./app.js";

const VALID_TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const GATEWAY_TOKEN = "gateway-to-pulso-test-token";

let app: ServiceHandle["app"];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GATEWAY_TO_PULSO_TOKEN = GATEWAY_TOKEN;
  const handle = await createService({
    serviceName: "pulso-iris-service",
    databaseRequired: true,
    registerRoutes
  });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
  delete process.env.GATEWAY_TO_PULSO_TOKEN;
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
      url: "/v1/tenants/123/pulso-iris/conversations",
      headers: gatewayHeaders()
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 for tenant data when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`,
      headers: gatewayHeaders()
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().data.error).toContain("DATABASE_URL");
  });

  it("rejects a valid edge token asserted by the wrong workload", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`,
      headers: {
        authorization: `Bearer ${GATEWAY_TOKEN}`,
        "x-hyperion-caller": "agent-service"
      }
    });

    expect(response.statusCode).toBe(401);
  });

  it("reports readiness as down without a database", async () => {
    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("down");
  });

  it("validates the tenant on config routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/no-uuid/pulso-iris/config/sites",
      headers: gatewayHeaders()
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 for config writes when the database is not configured", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/config/professionals`,
      headers: gatewayHeaders(),
      payload: { name: "Dra. Prueba", professionalType: "optometrist" }
    });

    expect(response.statusCode).toBe(503);
  });

  it("returns 503 for availability rules when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/config/availability-rules`,
      headers: gatewayHeaders()
    });

    expect(response.statusCode).toBe(503);
  });

  it("returns 503 for agenda blocks when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/config/agenda-blocks`,
      headers: gatewayHeaders()
    });

    expect(response.statusCode).toBe(503);
  });

  it("returns 503 for availability slots when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/availability/slots`,
      headers: gatewayHeaders()
    });

    expect(response.statusCode).toBe(503);
  });
});

function gatewayHeaders() {
  return {
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    "x-hyperion-caller": "api-gateway"
  };
}

describe("pulso-iris durable outbox configuration", () => {
  const natsTestSecret = "nats-test-secret-with-24-characters";
  it("keeps HTTP as the default and honors both disable switches", () => {
    expect(readDurableOutboxConfiguration({})).toEqual({ transport: "http", enabled: true });
    expect(readDurableOutboxConfiguration({ DURABLE_HTTP_OUTBOX_ENABLED: "false" })).toEqual({
      transport: "http",
      enabled: false
    });
    expect(readDurableOutboxConfiguration({ DURABLE_OUTBOX_ENABLED: "false" })).toEqual({
      transport: "http",
      enabled: false
    });
  });

  it("requires explicit credential-separated JetStream configuration", () => {
    expect(
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_AUTH_TOKEN: natsTestSecret
      })
    ).toEqual({
      transport: "jetstream",
      enabled: true,
      natsUrl: "nats://nats:4222",
      authentication: { authToken: natsTestSecret }
    });
    expect(() =>
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://user:password@nats:4222",
        NATS_AUTH_TOKEN: natsTestSecret
      })
    ).toThrow("must not contain credentials");
    expect(() =>
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222"
      })
    ).toThrow("NATS authentication is required");
  });

  it("requires a per-service username identity in production", () => {
    expect(() =>
      readDurableOutboxConfiguration({
        NODE_ENV: "production",
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: "nats://nats:4222",
        NATS_AUTH_TOKEN: natsTestSecret
      })
    ).toThrow("token authentication is not allowed");
  });

  it("rejects unknown transports", () => {
    expect(() => readDurableOutboxConfiguration({ DURABLE_EVENT_TRANSPORT: "unknown" })).toThrow(
      "DURABLE_EVENT_TRANSPORT must be either http or jetstream"
    );
  });

  it.each([
    "https://nats:4222",
    "nats://nats:4222/",
    "nats://nats:4222/path",
    "nats://nats:4222?token=unsafe",
    "nats://nats:4222#fragment"
  ])("rejects a non-NATS or component-bearing broker URL %s", (natsUrl) => {
    expect(() =>
      readDurableOutboxConfiguration({
        DURABLE_EVENT_TRANSPORT: "jetstream",
        NATS_URL: natsUrl,
        NATS_AUTH_TOKEN: natsTestSecret
      })
    ).toThrow("NATS_URL");
  });
});
