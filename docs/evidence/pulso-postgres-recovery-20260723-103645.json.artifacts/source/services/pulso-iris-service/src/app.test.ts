import {
  OPERATOR_ASSERTION_HEADER,
  createOperatorAssertion,
  createService,
  type ServiceHandle
} from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readDurableOutboxConfiguration, registerRoutes } from "./app.js";

const VALID_TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const OTHER_TENANT_ID = "8e0b2b6f-2d3c-4a5b-8c9d-3e5f7a9b1c2d";
const GATEWAY_TOKEN = "gateway-to-pulso-test-token";
const PULSO_BFF_TOKEN = "pulso-bff-to-core-test-token";
const SOFIA_TO_PULSO_TOKEN = "sofia-to-pulso-test-token";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const PULSO_ASSERTION_KEY = "pulso-operator-assertion-key-0001";
const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";

let app: ServiceHandle["app"];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.GATEWAY_TO_PULSO_TOKEN = GATEWAY_TOKEN;
  process.env.PULSO_BFF_TO_CORE_TOKEN = PULSO_BFF_TOKEN;
  process.env.SOFIA_TO_PULSO_TOKEN = SOFIA_TO_PULSO_TOKEN;
  process.env.GATEWAY_OPERATOR_ASSERTION_KEY = ASSERTION_KEY;
  process.env.PULSO_OPERATOR_ASSERTION_KEY = PULSO_ASSERTION_KEY;
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
  delete process.env.PULSO_BFF_TO_CORE_TOKEN;
  delete process.env.SOFIA_TO_PULSO_TOKEN;
  delete process.env.GATEWAY_OPERATOR_ASSERTION_KEY;
  delete process.env.PULSO_OPERATOR_ASSERTION_KEY;
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
      headers: gatewayHeaders("123")
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 for tenant data when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`,
      headers: gatewayHeaders(VALID_TENANT_ID)
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

    expect(response.statusCode).toBe(403);
  });

  it("rejects forged operator headers even with a valid gateway edge token", async () => {
    const headers = gatewayHeaders(VALID_TENANT_ID, "advisor");
    const forged = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`,
      headers: { ...headers, "x-operator-role": "admin" }
    });
    const signed = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`,
      headers
    });

    expect(forged.statusCode).toBe(403);
    expect(signed.statusCode).toBe(503);
    expect(signed.json().data.error).toContain("DATABASE_URL");
  });

  it("protects decoded tenant routes and binds assertions to the routed tenant", async () => {
    const encodedWithoutHeaders = await app.inject({
      method: "GET",
      url: `/v1/%74enants/${VALID_TENANT_ID}/pulso-iris/overview`
    });
    const wrongTenant = await app.inject({
      method: "GET",
      url: `/v1/tenants/${OTHER_TENANT_ID}/pulso-iris/overview`,
      headers: gatewayHeaders(VALID_TENANT_ID)
    });

    expect(encodedWithoutHeaders.statusCode).toBe(401);
    expect(wrongTenant.statusCode).toBe(403);
  });

  it("accepts the dedicated PULSO BFF identity only with a PULSO_IRIS-bound assertion", async () => {
    const bound = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`,
      headers: pulsoBffHeaders(VALID_TENANT_ID)
    });
    const legacyAssertion = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/overview`,
      headers: {
        ...pulsoBffHeaders(VALID_TENANT_ID),
        [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
          {
            operatorId: OPERATOR_ID,
            role: "coordinator",
            tenantId: VALID_TENANT_ID,
            expiresAtUnix: Math.floor(Date.now() / 1000) + 60
          },
          PULSO_ASSERTION_KEY
        )
      }
    });

    expect(bound.statusCode).toBe(503);
    expect(bound.json().data.error).toContain("DATABASE_URL");
    expect(legacyAssertion.statusCode).toBe(403);
  });

  it("keeps tenant-scoped internal routes on their workload-specific identity gate", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/internal/v1/tenants/${VALID_TENANT_ID}/pulso-message/11111111-1111-4111-8111-111111111112/stream-position`,
      headers: {
        authorization: `Bearer ${SOFIA_TO_PULSO_TOKEN}`,
        "x-hyperion-caller": "agent-service"
      }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().data.error).toContain("DATABASE_URL");
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
      headers: gatewayHeaders("no-uuid")
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns 503 for config writes when the database is not configured", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/config/professionals`,
      headers: gatewayHeaders(VALID_TENANT_ID),
      payload: { name: "Dra. Prueba", professionalType: "optometrist" }
    });

    expect(response.statusCode).toBe(503);
  });

  it("returns 503 for availability rules when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/config/availability-rules`,
      headers: gatewayHeaders(VALID_TENANT_ID)
    });

    expect(response.statusCode).toBe(503);
  });

  it("returns 503 for agenda blocks when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/config/agenda-blocks`,
      headers: gatewayHeaders(VALID_TENANT_ID)
    });

    expect(response.statusCode).toBe(503);
  });

  it("returns 503 for availability slots when the database is not configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${VALID_TENANT_ID}/pulso-iris/availability/slots`,
      headers: gatewayHeaders(VALID_TENANT_ID)
    });

    expect(response.statusCode).toBe(503);
  });
});

function gatewayHeaders(tenantId: string, role = "coordinator") {
  return {
    authorization: `Bearer ${GATEWAY_TOKEN}`,
    "x-hyperion-caller": "api-gateway",
    "x-operator-id": OPERATOR_ID,
    "x-operator-role": role,
    [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
      { operatorId: OPERATOR_ID, role, tenantId, expiresAtUnix: Math.floor(Date.now() / 1000) + 60 },
      ASSERTION_KEY
    )
  };
}

function pulsoBffHeaders(tenantId: string, role = "coordinator") {
  return {
    authorization: `Bearer ${PULSO_BFF_TOKEN}`,
    "x-hyperion-caller": "pulso-bff",
    "x-operator-id": OPERATOR_ID,
    "x-operator-role": role,
    [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
      {
        operatorId: OPERATOR_ID,
        role,
        tenantId,
        productId: "PULSO_IRIS",
        expiresAtUnix: Math.floor(Date.now() / 1000) + 60
      },
      PULSO_ASSERTION_KEY
    )
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
        NODE_ENV: "test",
        HYPERION_ENVIRONMENT: "production",
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
