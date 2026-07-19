import Fastify from "fastify";
import {
  OPERATOR_ASSERTION_HEADER,
  createInternalAuthorizationHeaders,
  createOperatorAssertion
} from "@hyperion/nova-service-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerRoutes } from "./app.js";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_TENANT_ID = "33333333-3333-4333-8333-333333333333";
const OPERATOR_ID = "11111111-1111-4111-8111-111111111111";
const GATEWAY_TOKEN = "gateway-to-documents-test-token-01";
const NOVA_BFF_TOKEN = "nova-bff-to-documents-test-token-1";
const ASSERTION_KEY = "gateway-operator-assertion-key-01";
const NOVA_ASSERTION_KEY = "nova-operator-assertion-key-0001";

describe("documents product operator assertion", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.stubEnv("HYPERION_ENVIRONMENT", "local");
    vi.stubEnv("GATEWAY_TO_DOCUMENTS_TOKEN", GATEWAY_TOKEN);
    vi.stubEnv("NOVA_BFF_TO_DOCUMENTS_TOKEN", NOVA_BFF_TOKEN);
    vi.stubEnv("GATEWAY_OPERATOR_ASSERTION_KEY", ASSERTION_KEY);
    vi.stubEnv("NOVA_OPERATOR_ASSERTION_KEY", NOVA_ASSERTION_KEY);
    vi.stubEnv("DOCUMENTS_S3_BUCKET", "");
    vi.stubEnv("DOCUMENTS_TO_NOVA_TOKEN", "");
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
    expect(valid.json().data.error).toBe("Invalid upload payload");
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

  it("fails startup when an asynchronous provider edge lacks the signing key", async () => {
    vi.stubEnv("NOVA_OPERATOR_ASSERTION_KEY", "");
    vi.stubEnv("DOCUMENTS_TO_NOVA_TOKEN", "documents-to-nova-test-token-001");
    const isolated = Fastify();
    await expect(registerRoutes(isolated, context())).rejects.toThrow(
      "NOVA_OPERATOR_ASSERTION_KEY is required for NOVA BFF and provider event edges"
    );
    await isolated.close();
  });

  async function requestWith(
    claims: { tenantId?: string; productId?: string },
    edge = { caller: "nova-bff", token: NOVA_BFF_TOKEN, assertionKey: NOVA_ASSERTION_KEY }
  ) {
    return app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/documents/upload`,
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
