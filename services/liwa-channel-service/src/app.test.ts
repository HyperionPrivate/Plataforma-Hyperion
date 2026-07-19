import Fastify from "fastify";
import {
  OPERATOR_ASSERTION_HEADER,
  createInternalAuthorizationHeaders,
  createOperatorAssertion,
  createProductSystemAssertionHeaders
} from "@hyperion/nova-service-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./app.js";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_TOKEN = "gateway-to-liwa-test-token-00001";
const NOVA_BFF_TOKEN = "nova-bff-to-liwa-test-token-0001";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const NOVA_ASSERTION_KEY = "nova-operator-assertion-key-0001";
const NOVA_TO_LIWA_TOKEN = "nova-to-liwa-test-token-0000001";

describe("LIWA product operator assertion", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.stubEnv("HYPERION_ENVIRONMENT", "local");
    vi.stubEnv("GATEWAY_TO_LIWA_TOKEN", GATEWAY_TOKEN);
    vi.stubEnv("NOVA_BFF_TO_LIWA_TOKEN", NOVA_BFF_TOKEN);
    vi.stubEnv("GATEWAY_OPERATOR_ASSERTION_KEY", ASSERTION_KEY);
    vi.stubEnv("NOVA_OPERATOR_ASSERTION_KEY", NOVA_ASSERTION_KEY);
    vi.stubEnv("NOVA_TO_LIWA_TOKEN", NOVA_TO_LIWA_TOKEN);
    vi.stubEnv("LIWA_API_TOKEN", "");
    vi.stubEnv("LIWA_ACCESS_TOKEN", "");
    vi.stubEnv("LIWA_TO_NOVA_TOKEN", "");
    app = Fastify();
    await registerRoutes(app, context());
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("rejects an edge token unless operator, tenant and NOVA product are signed together", async () => {
    const edgeOnly = await requestWith({});
    const wrongTenant = await requestWith({ tenantId: OTHER_TENANT_ID, productId: "NOVA" });
    const wrongProduct = await requestWith({ tenantId: TENANT_ID, productId: "OTHER" });
    const valid = await requestWith({ tenantId: TENANT_ID, productId: "NOVA" });

    expect(edgeOnly.statusCode).toBe(403);
    expect(wrongTenant.statusCode).toBe(403);
    expect(wrongProduct.statusCode).toBe(403);
    expect(valid.statusCode).toBe(400);
    expect(valid.json().data.error).toBe("Invalid send payload");
  });

  it("keeps nova-bff and the N-1 gateway credentials distinct", async () => {
    const wrongToken = await requestWith(
      { tenantId: TENANT_ID, productId: "NOVA" },
      { caller: "nova-bff", token: GATEWAY_TOKEN, assertionKey: NOVA_ASSERTION_KEY }
    );
    const wrongCaller = await requestWith(
      { tenantId: TENANT_ID, productId: "NOVA" },
      { caller: "untrusted-edge", token: NOVA_BFF_TOKEN, assertionKey: NOVA_ASSERTION_KEY }
    );
    const legacyGateway = await requestWith(
      { tenantId: TENANT_ID, productId: "NOVA" },
      { caller: "api-gateway", token: GATEWAY_TOKEN, assertionKey: ASSERTION_KEY }
    );

    expect(wrongToken.statusCode).toBe(401);
    expect(wrongCaller.statusCode).toBe(403);
    expect(legacyGateway.statusCode).toBe(400);
  });

  it("rejects internal NOVA events without a signed workload context", async () => {
    const payload = {
      id: "44444444-4444-4444-8444-444444444444",
      type: "unsupported.event",
      version: 1,
      occurredAt: new Date().toISOString(),
      tenantId: TENANT_ID,
      payload: {}
    };
    const workload = createInternalAuthorizationHeaders("nova-core-service", NOVA_TO_LIWA_TOKEN);
    const unsigned = await app.inject({
      method: "POST",
      url: "/v1/liwa/internal/events",
      headers: workload,
      payload
    });
    const valid = await app.inject({
      method: "POST",
      url: "/v1/liwa/internal/events",
      headers: {
        ...workload,
        ...createProductSystemAssertionHeaders({
          serviceId: "nova-core-service",
          tenantId: TENANT_ID,
          productId: "NOVA",
          secret: NOVA_ASSERTION_KEY
        })
      },
      payload
    });

    expect(unsigned.statusCode).toBe(403);
    expect(valid.statusCode).toBe(400);
    expect(valid.json().data.error).toBe("Unsupported event type");
  });

  async function requestWith(
    claims: { tenantId?: string; productId?: string },
    edge = { caller: "nova-bff", token: NOVA_BFF_TOKEN, assertionKey: NOVA_ASSERTION_KEY }
  ) {
    return app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/liwa/send`,
      headers: edgeHeaders(claims, edge),
      payload: {}
    });
  }
});

function edgeHeaders(
  claims: { tenantId?: string; productId?: string },
  edge: { caller: string; token: string; assertionKey: string }
) {
  return {
    ...createInternalAuthorizationHeaders(edge.caller, edge.token),
    "x-operator-id": OPERATOR_ID,
    "x-operator-role": "advisor",
    ...(claims.tenantId
      ? {
          [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
            {
              operatorId: OPERATOR_ID,
              role: "advisor",
              tenantId: claims.tenantId,
              ...(claims.productId ? { productId: claims.productId } : {}),
              expiresAtUnix: Math.floor(Date.now() / 1000) + 60
            },
            edge.assertionKey
          )
        }
      : {})
  };
}

function context() {
  return {
    config: {},
    db: { query: vi.fn(), transaction: vi.fn(), close: vi.fn() },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  } as never;
}
