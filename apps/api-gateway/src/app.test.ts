import { OPERATOR_ASSERTION_HEADER, createService, verifyOperatorAssertion } from "@hyperion/service-runtime";
import type { AccessMe, ProductGrant } from "@hyperion/platform-contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGatewayRoutes } from "./app.js";

const AUTHORIZED_TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const OTHER_TENANT_ID = "3b8e6d4c-2a19-4f87-b6e5-1d0c9b8a7f6e";
const ADMIN_TOKEN = "admin-test-token-1234567890";
const COORDINATOR_TOKEN = "coordinator-test-token-1234567890";
const ADVISOR_TOKEN = "advisor-test-token-1234567890";
const AUDITOR_TOKEN = "auditor-test-token-1234567890";
const NO_GRANT_ADMIN_TOKEN = "no-grant-admin-test-token-1234567890";
const NO_GRANT_ADVISOR_TOKEN = "no-grant-advisor-test-token-1234567890";
const NOVA_ONLY_ADMIN_TOKEN = "nova-only-admin-test-token-1234567890";
const INACTIVE_NOVA_ADMIN_TOKEN = "inactive-nova-admin-test-token-1234567890";
const PULSO_READ_ONLY_ADMIN_TOKEN = "pulso-read-only-admin-token-1234567890";
const GATEWAY_TO_IDENTITY_TOKEN = "gateway-to-identity-test-token-001";
const GATEWAY_TO_INTEGRATION_TOKEN = "gateway-to-integration-test-token-02";
const GATEWAY_TO_PULSO_TOKEN = "gateway-to-pulso-test-token-0001";
const GATEWAY_TO_LUMEN_TOKEN = "gateway-to-lumen-test-token-0002";
const GATEWAY_TO_NOVA_TOKEN = "gateway-to-nova-test-token-000004";
const GATEWAY_TO_VOICE_TOKEN = "gateway-to-voice-test-token-00003";
const GATEWAY_TO_TENANT_TOKEN = "gateway-to-tenant-test-token-00016";
const OPERATOR_ASSERTION_KEY = "gateway-operator-assertion-key-01";

const isolatedServiceUrls = {
  IDENTITY_SERVICE_URL: "http://127.0.0.1:65511",
  TENANT_SERVICE_URL: "http://127.0.0.1:65512",
  AGENT_SERVICE_URL: "http://127.0.0.1:65513",
  PROMPT_FLOW_SERVICE_URL: "http://127.0.0.1:65514",
  KNOWLEDGE_SERVICE_URL: "http://127.0.0.1:65515",
  AUDIT_SERVICE_URL: "http://127.0.0.1:65516",
  INTEGRATION_SERVICE_URL: "http://127.0.0.1:65517",
  PULSO_IRIS_SERVICE_URL: "http://127.0.0.1:65518",
  WHATSAPP_CHANNEL_SERVICE_URL: "http://127.0.0.1:65519",
  LUMEN_SERVICE_URL: "http://127.0.0.1:65520",
  NOVA_CORE_SERVICE_URL: "http://127.0.0.1:65521",
  VOICE_CHANNEL_SERVICE_URL: "http://127.0.0.1:65522",
  LIWA_CHANNEL_SERVICE_URL: "http://127.0.0.1:65523",
  DOCUMENTS_SERVICE_URL: "http://127.0.0.1:65524"
} as const;

const previousServiceUrls = Object.fromEntries(
  Object.keys(isolatedServiceUrls).map((name) => [name, process.env[name]])
);
const previousOperatorAssertionKey = process.env.GATEWAY_OPERATOR_ASSERTION_KEY;

function productGrant(
  productId: "NOVA" | "LUMEN" | "PULSO_IRIS",
  roles: string[],
  capabilities: string[],
  active = true
): ProductGrant {
  return { tenantId: AUTHORIZED_TENANT_ID, productId, roles, capabilities, active };
}

const sessions: Record<string, AccessMe> = {
  [ADMIN_TOKEN]: {
    operator: {
      id: "9c8b7a6d-5e4f-4a3b-8c9d-0e1f2a3b4c5d",
      email: "admin@hyperion.local",
      displayName: "Admin",
      role: "admin"
    },
    tenantIds: [AUTHORIZED_TENANT_ID],
    grants: [
      productGrant("NOVA", ["admin"], ["nova:admin"]),
      productGrant("LUMEN", ["admin"], ["lumen:admin"]),
      productGrant("PULSO_IRIS", ["admin"], ["pulso:admin"])
    ]
  },
  [COORDINATOR_TOKEN]: {
    operator: {
      id: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      email: "coordinador@hyperion.local",
      displayName: "Coordinador",
      role: "coordinator"
    },
    tenantIds: [AUTHORIZED_TENANT_ID],
    grants: [
      productGrant("NOVA", ["supervisor"], ["nova:read", "nova:write"]),
      productGrant("LUMEN", ["coordinator"], ["lumen:read", "lumen:write"]),
      productGrant("PULSO_IRIS", ["coordinator"], ["pulso:read", "pulso:write"])
    ]
  },
  [ADVISOR_TOKEN]: {
    operator: {
      id: "2b3c4d5e-6f70-4a8b-9c0d-1e2f3a4b5c6d",
      email: "asesor@hyperion.local",
      displayName: "Asesor",
      role: "advisor"
    },
    tenantIds: [AUTHORIZED_TENANT_ID],
    grants: [
      productGrant("NOVA", ["asesor"], ["nova:read", "nova:write"]),
      productGrant("LUMEN", ["advisor"], ["lumen:read", "lumen:write"]),
      productGrant("PULSO_IRIS", ["advisor"], ["pulso:read", "pulso:write"])
    ]
  },
  [AUDITOR_TOKEN]: {
    operator: {
      id: "3c4d5e6f-7081-4a8b-9c0d-1e2f3a4b5c6d",
      email: "auditor@hyperion.local",
      displayName: "Auditor",
      role: "auditor"
    },
    tenantIds: [AUTHORIZED_TENANT_ID],
    grants: [
      productGrant("NOVA", ["asesor"], ["nova:read"]),
      productGrant("LUMEN", ["auditor"], ["lumen:read"]),
      productGrant("PULSO_IRIS", ["auditor"], ["pulso:read"])
    ]
  },
  [NO_GRANT_ADMIN_TOKEN]: {
    operator: {
      id: "4d5e6f70-8192-4a8b-9c0d-1e2f3a4b5c6d",
      email: "admin-no-grant@hyperion.local",
      displayName: "Admin without grant",
      role: "admin"
    },
    tenantIds: [],
    grants: []
  },
  [NO_GRANT_ADVISOR_TOKEN]: {
    operator: {
      id: "5e6f7081-92a3-4a8b-9c0d-1e2f3a4b5c6d",
      email: "advisor-no-grant@hyperion.local",
      displayName: "Advisor without grant",
      role: "advisor"
    },
    tenantIds: [],
    grants: []
  },
  [NOVA_ONLY_ADMIN_TOKEN]: {
    operator: {
      id: "6f708192-a3b4-4a8b-9c0d-1e2f3a4b5c6d",
      email: "nova-only-admin@hyperion.local",
      displayName: "NOVA-only admin",
      role: "admin"
    },
    tenantIds: [AUTHORIZED_TENANT_ID],
    grants: [productGrant("NOVA", ["admin"], ["nova:admin"])]
  },
  [INACTIVE_NOVA_ADMIN_TOKEN]: {
    operator: {
      id: "8192a3b4-c5d6-4a8b-9c0d-1e2f3a4b5c6d",
      email: "inactive-nova-admin@hyperion.local",
      displayName: "Inactive NOVA admin",
      role: "admin"
    },
    tenantIds: [],
    grants: [productGrant("NOVA", ["admin"], ["nova:admin"], false)]
  },
  [PULSO_READ_ONLY_ADMIN_TOKEN]: {
    operator: {
      id: "708192a3-b4c5-4a8b-9c0d-1e2f3a4b5c6d",
      email: "pulso-read-only-admin@hyperion.local",
      displayName: "PULSO read-only admin",
      role: "admin"
    },
    tenantIds: [AUTHORIZED_TENANT_ID],
    grants: [productGrant("PULSO_IRIS", ["admin"], ["pulso:read"])]
  }
};

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  Object.assign(process.env, isolatedServiceUrls);
  process.env.GATEWAY_OPERATOR_ASSERTION_KEY = OPERATOR_ASSERTION_KEY;
  const handle = await createService({
    serviceName: "api-gateway",
    databaseRequired: false,
    publicApi: true,
    registerRoutes: createGatewayRoutes({
      resolveSession: async (token) => sessions[token],
      gatewayCredentials: {
        identity: GATEWAY_TO_IDENTITY_TOKEN,
        integration: GATEWAY_TO_INTEGRATION_TOKEN,
        pulsoIris: GATEWAY_TO_PULSO_TOKEN,
        lumen: GATEWAY_TO_LUMEN_TOKEN,
        nova: GATEWAY_TO_NOVA_TOKEN,
        voice: GATEWAY_TO_VOICE_TOKEN,
        tenant: GATEWAY_TO_TENANT_TOKEN
      }
    })
  });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
  for (const [name, value] of Object.entries(previousServiceUrls)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  if (previousOperatorAssertionKey === undefined) {
    delete process.env.GATEWAY_OPERATOR_ASSERTION_KEY;
  } else {
    process.env.GATEWAY_OPERATOR_ASSERTION_KEY = previousOperatorAssertionKey;
  }
});

describe("api-gateway authentication", () => {
  it("rejects business routes without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/platform/catalog" });

    expect(response.statusCode).toBe(401);
  });

  it("rejects unauthenticated LUMEN payloads before parsing their body", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/encounters/00000000-0000-4000-8000-000000000001/transcriptions/audio`,
      headers: { "content-type": "application/json" },
      payload: "{".repeat(1024)
    });

    expect(response.statusCode).toBe(401);
  });

  it("rejects business routes with an unknown token", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/platform/catalog",
      headers: { authorization: "Bearer unknown-token-1234567890" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("keeps the login route public (proxied upstream)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "admin@hyperion.local", password: "supersecret" }
    });

    expect(response.statusCode).toBe(502);
  });

  it("preserves grants returned for an opaque N-1 session token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/me")) {
        return Response.json({ data: sessions[COORDINATOR_TOKEN] });
      }
      if (url.includes(`/v1/tenants/${AUTHORIZED_TENANT_ID}/nova/campaigns`)) {
        return Response.json({ data: { authorized: true } });
      }
      throw new Error(`Unexpected upstream request: ${url}`);
    });
    let opaqueApp: FastifyInstance | undefined;
    try {
      const handle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes({
          gatewayCredentials: { nova: GATEWAY_TO_NOVA_TOKEN }
        })
      });
      opaqueApp = handle.app;

      const response = await opaqueApp.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/nova/campaigns`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });

      expect(COORDINATOR_TOKEN.split(".")).toHaveLength(1);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.authorized).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await opaqueApp?.close();
      fetchMock.mockRestore();
    }
  });

  it("forbids tenants the operator is not assigned to", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${OTHER_TENANT_ID}/pulso-iris/overview`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
    });

    expect(response.statusCode).toBe(403);
  });

  it("lets an operator through to an assigned tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
    });

    // Authorization passed; upstream is not running in tests.
    expect(response.statusCode).toBe(502);
  });

  it.each([
    ["admin", NO_GRANT_ADMIN_TOKEN],
    ["advisor", NO_GRANT_ADVISOR_TOKEN]
  ])("rejects a %s platform role without an exact product grant", async (_role, token) => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data.error).toContain("PULSO_IRIS grant required");
  });

  it("does not let an admin use a tenant A grant against tenant B", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${OTHER_TENANT_ID}/nova/campaigns`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().data.error).toContain("NOVA grant required for this tenant");
  });

  it("requires the exact product and method capability even for a platform admin", async () => {
    const wrongProduct = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/worklist`,
      headers: { authorization: `Bearer ${NOVA_ONLY_ADMIN_TOKEN}` }
    });
    const missingWrite = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments`,
      headers: { authorization: `Bearer ${PULSO_READ_ONLY_ADMIN_TOKEN}` },
      payload: {}
    });

    expect(wrongProduct.statusCode).toBe(403);
    expect(wrongProduct.json().data.error).toContain("LUMEN grant required");
    expect(missingWrite.statusCode).toBe(403);
    expect(missingWrite.json().data.error).toContain("pulso:write capability required");
  });

  it("proxies a tenant request only after its exact active grant and read capability pass", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { allowed: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.allowed).toBe(true);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        `${isolatedServiceUrls.PULSO_IRIS_SERVICE_URL}/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`
      );
      expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("requires a product grant but never proxies legacy product discovery directly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const withoutGrant = await app.inject({
        method: "GET",
        url: "/v1/nova/health",
        headers: { authorization: `Bearer ${NO_GRANT_ADMIN_TOKEN}` }
      });
      const wrongProduct = await app.inject({
        method: "GET",
        url: "/v1/lumen/catalog",
        headers: { authorization: `Bearer ${NOVA_ONLY_ADMIN_TOKEN}` }
      });
      const inactiveGrant = await app.inject({
        method: "GET",
        url: "/v1/nova/catalog",
        headers: { authorization: `Bearer ${INACTIVE_NOVA_ADMIN_TOKEN}` }
      });
      const activeGrant = await app.inject({
        method: "GET",
        url: "/v1/nova/health",
        headers: { authorization: `Bearer ${NOVA_ONLY_ADMIN_TOKEN}` }
      });

      expect(withoutGrant.statusCode).toBe(403);
      expect(wrongProduct.statusCode).toBe(403);
      expect(inactiveGrant.statusCode).toBe(403);
      expect(activeGrant.statusCode).toBe(404);
      expect(activeGrant.json().data.error).toContain("product-owned BFF");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("enforces the NOVA BFF capability policy instead of the generic read grant", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/voice/calls/reconciliation`,
        headers: { authorization: `Bearer ${ADVISOR_TOKEN}` }
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().data.error).toContain("nova:admin capability required");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("returns 404 for product routes outside the owner BFF allowlist", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const novaInternal = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/voice/internal/events`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      const foreignNamespace = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/nova/lumen/worklist`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });

      expect(novaInternal.statusCode).toBe(404);
      expect(foreignNamespace.statusCode).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("fails closed when a product-specific gateway identity is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    let isolatedApp: FastifyInstance | undefined;
    try {
      const handle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes({
          resolveSession: async (token) => sessions[token],
          gatewayCredentials: { identity: "", integration: "", pulsoIris: "", lumen: "", tenant: "" }
        })
      });
      isolatedApp = handle.app;

      const pulso = await isolatedApp.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      const lumen = await isolatedApp.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/worklist`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      const identity = await isolatedApp.inject({
        method: "GET",
        url: "/v1/identity/operators",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      const integration = await isolatedApp.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/integrations/whatsapp/status`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      const tenants = await isolatedApp.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });

      expect(pulso.statusCode).toBe(503);
      expect(lumen.statusCode).toBe(503);
      expect(identity.statusCode).toBe(503);
      expect(integration.statusCode).toBe(503);
      expect(tenants.statusCode).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await isolatedApp?.close();
      fetchMock.mockRestore();
    }
  });

  it("uses distinct gateway identities for Identity and Integration", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    try {
      const identity = await app.inject({
        method: "GET",
        url: "/v1/identity/operators",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      const integration = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/integrations/whatsapp/status`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });

      expect(identity.statusCode).toBe(200);
      expect(integration.statusCode).toBe(200);
      const identityHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      const integrationHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
      expect(identityHeaders.get("authorization")).toBe(`Bearer ${GATEWAY_TO_IDENTITY_TOKEN}`);
      expect(integrationHeaders.get("authorization")).toBe(`Bearer ${GATEWAY_TO_INTEGRATION_TOKEN}`);
      expect(identityHeaders.get("x-hyperion-caller")).toBe("api-gateway");
      expect(integrationHeaders.get("x-hyperion-caller")).toBe("api-gateway");
      expect(identityHeaders.get("authorization")).not.toBe(integrationHeaders.get("authorization"));
      expect(
        verifyOperatorAssertion(integrationHeaders.get(OPERATOR_ASSERTION_HEADER) ?? undefined, OPERATOR_ASSERTION_KEY)
      ).toMatchObject({
        operatorId: sessions[COORDINATOR_TOKEN]!.operator.id,
        role: "coordinator",
        tenantId: AUTHORIZED_TENANT_ID
      });
      expect(
        verifyOperatorAssertion(identityHeaders.get(OPERATOR_ASSERTION_HEADER) ?? undefined, OPERATOR_ASSERTION_KEY)
      ).not.toHaveProperty("tenantId");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("signs the NOVA product together with operator and tenant context", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/voice/campaigns`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      const forwarded = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(
        verifyOperatorAssertion(forwarded.get(OPERATOR_ASSERTION_HEADER) ?? undefined, OPERATOR_ASSERTION_KEY)
      ).toMatchObject({
        operatorId: sessions[COORDINATOR_TOKEN]!.operator.id,
        role: "coordinator",
        tenantId: AUTHORIZED_TENANT_ID,
        productId: "NOVA"
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("allows coordinator to write configuration", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/sites`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: { name: "Sede de prueba" }
    });

    // Authorization and routing passed; upstream is not running in tests.
    expect(response.statusCode).toBe(502);
  });

  it("allows coordinator to write holidays and payer exclusions", async () => {
    const holiday = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/holidays`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: { holidayDate: "2026-12-25", name: "Navidad" }
    });
    const exclusion = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/payer-exclusions/00000000-0000-4000-8000-000000000001`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: { status: "paused" }
    });

    expect(holiday.statusCode).toBe(502);
    expect(exclusion.statusCode).toBe(502);
  });

  it("forbids advisor from writing configuration", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/sites`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { name: "Sede de prueba" }
    });

    expect(response.statusCode).toBe(403);
  });

  it("authorizes percent-encoded path segments using their canonical representation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { created: true } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    try {
      const forbidden = await app.inject({
        method: "POST",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/%63onfig/sites`,
        headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
        payload: { name: "Sede de prueba" }
      });
      const allowed = await app.inject({
        method: "POST",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/%63onfig/sites`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
        payload: { name: "Sede de prueba" }
      });

      expect(forbidden.statusCode).toBe(403);
      expect(allowed.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        `${isolatedServiceUrls.PULSO_IRIS_SERVICE_URL}/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/sites`
      );
      const upstreamHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(upstreamHeaders.get("authorization")).toBe(`Bearer ${GATEWAY_TO_PULSO_TOKEN}`);
      expect(upstreamHeaders.get("x-hyperion-caller")).toBe("api-gateway");
      expect(upstreamHeaders.get("authorization")).not.toBe(`Bearer ${COORDINATOR_TOKEN}`);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("rejects request paths that could be decoded again by a downstream", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/%2563onfig/sites`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { name: "Sede de prueba" }
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects ambiguous separators before authorization and proxying", async () => {
    const encodedSeparator = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config%2Fsites`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    const duplicateSeparator = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris//config/sites`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(encodedSeparator.statusCode).toBe(400);
    expect(duplicateSeparator.statusCode).toBe(400);
  });

  it("revalidates sessions across gateway replicas immediately after logout", async () => {
    let meRequests = 0;
    let revoked = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/me")) {
        meRequests += 1;
        if (!revoked) {
          return new Response(JSON.stringify({ data: sessions[COORDINATOR_TOKEN] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ data: { error: "Invalid or expired session" } }), {
          status: 401,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/auth/logout")) {
        revoked = true;
        return new Response(JSON.stringify({ data: { loggedOut: true } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream request: ${url}`);
    });

    let firstReplica: FastifyInstance | undefined;
    let secondReplica: FastifyInstance | undefined;
    try {
      const firstHandle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes()
      });
      const secondHandle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes()
      });
      firstReplica = firstHandle.app;
      secondReplica = secondHandle.app;

      const first = await firstReplica.inject({
        method: "GET",
        url: "/v1/platform/catalog",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      const second = await secondReplica.inject({
        method: "GET",
        url: "/v1/platform/catalog",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      const logout = await firstReplica.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      const afterLogout = await secondReplica.inject({
        method: "GET",
        url: "/v1/platform/catalog",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(logout.statusCode).toBe(200);
      expect(afterLogout.statusCode).toBe(401);
      expect(meRequests).toBe(4);
    } finally {
      await Promise.allSettled([firstReplica?.close(), secondReplica?.close()]);
      fetchMock.mockRestore();
    }
  });

  it("does not invalidate another token whose session lookup is in flight", async () => {
    let releaseAdvisor: () => void = () => undefined;
    let markAdvisorStarted: () => void = () => undefined;
    const advisorRelease = new Promise<void>((resolve) => {
      releaseAdvisor = resolve;
    });
    const advisorStarted = new Promise<void>((resolve) => {
      markAdvisorStarted = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/me")) {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === `Bearer ${ADVISOR_TOKEN}`) {
          markAdvisorStarted();
          await advisorRelease;
          return new Response(JSON.stringify({ data: sessions[ADVISOR_TOKEN] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (authorization === `Bearer ${COORDINATOR_TOKEN}`) {
          return new Response(JSON.stringify({ data: sessions[COORDINATOR_TOKEN] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
      }
      if (url.endsWith("/v1/auth/logout")) {
        return new Response(JSON.stringify({ data: { loggedOut: true } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream request: ${url}`);
    });

    let cachedApp: FastifyInstance | undefined;
    try {
      const handle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes()
      });
      cachedApp = handle.app;

      const coordinator = await cachedApp.inject({
        method: "GET",
        url: "/v1/platform/catalog",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      const advisorRequest = cachedApp.inject({
        method: "GET",
        url: "/v1/platform/catalog",
        headers: { authorization: `Bearer ${ADVISOR_TOKEN}` }
      });
      await advisorStarted;
      const logout = await cachedApp.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      releaseAdvisor();
      const advisor = await advisorRequest;

      expect(coordinator.statusCode).toBe(200);
      expect(logout.statusCode).toBe(200);
      expect(advisor.statusCode).toBe(200);
    } finally {
      releaseAdvisor();
      await cachedApp?.close();
      fetchMock.mockRestore();
    }
  });

  it("rejects a session lookup that finishes after the same token logs out", async () => {
    let releaseLookup: () => void = () => undefined;
    let markLookupStarted: () => void = () => undefined;
    const lookupRelease = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const lookupStarted = new Promise<void>((resolve) => {
      markLookupStarted = resolve;
    });
    let meRequests = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/me")) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${COORDINATOR_TOKEN}`);
        meRequests += 1;
        if (meRequests === 1) {
          markLookupStarted();
          await lookupRelease;
        }
        return new Response(JSON.stringify({ data: sessions[COORDINATOR_TOKEN] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (url.endsWith("/v1/auth/logout")) {
        return new Response(JSON.stringify({ data: { loggedOut: true } }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream request: ${url}`);
    });

    let cachedApp: FastifyInstance | undefined;
    try {
      const handle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes()
      });
      cachedApp = handle.app;

      const inFlight = cachedApp.inject({
        method: "GET",
        url: "/v1/platform/catalog",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      await lookupStarted;
      const logout = await cachedApp.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      releaseLookup();
      const staleRequest = await inFlight;

      expect(logout.statusCode).toBe(200);
      expect(staleRequest.statusCode).toBe(401);
      expect(meRequests).toBe(2);
    } finally {
      releaseLookup();
      await cachedApp?.close();
      fetchMock.mockRestore();
    }
  });

  it("forbids advisor from writing holidays and payer exclusions", async () => {
    const holiday = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/holidays`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { holidayDate: "2026-12-25", name: "Navidad" }
    });
    const exclusion = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/payer-exclusions`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: {
        professionalId: "00000000-0000-4000-8000-000000000001",
        payerId: "00000000-0000-4000-8000-000000000002"
      }
    });

    expect(holiday.statusCode).toBe(403);
    expect(exclusion.statusCode).toBe(403);
  });

  it("allows advisor to write operational records", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: {}
    });

    expect(response.statusCode).toBe(502);
  });

  it("reserves appointment verification and state changes for coordinators", async () => {
    const appointmentId = "00000000-0000-4000-8000-000000000010";
    const advisorVerify = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments/${appointmentId}/manual-verify`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { externalReference: "masked-reference", externalSystem: "manual" }
    });
    const advisorPatch = await app.inject({
      method: "PATCH",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments/${appointmentId}`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: { status: "verified" }
    });
    const coordinatorVerify = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments/${appointmentId}/manual-verify`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: { externalReference: "masked-reference", externalSystem: "manual" }
    });

    expect(advisorVerify.statusCode).toBe(403);
    expect(advisorPatch.statusCode).toBe(403);
    expect(coordinatorVerify.statusCode).toBe(502);
  });

  it("keeps auditor as read-only", async () => {
    const read = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/dashboard/live`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` }
    });
    const write = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/appointments`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` },
      payload: {}
    });
    const holidayWrite = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/holidays`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` },
      payload: { holidayDate: "2026-12-25", name: "Navidad" }
    });
    const holidayRead = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/config/holidays`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` }
    });

    expect(read.statusCode).toBe(502);
    expect(write.statusCode).toBe(403);
    expect(holidayWrite.statusCode).toBe(403);
    expect(holidayRead.statusCode).toBe(502);
  });

  it("requires admin role for operator management", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: {}
    });
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {}
    });

    expect(forbidden.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(502);
  });

  it("enforces WhatsApp integration RBAC at the gateway", async () => {
    const base = `/v1/tenants/${AUTHORIZED_TENANT_ID}/integrations/whatsapp`;
    const coordinatorStatus = await app.inject({
      method: "GET",
      url: `${base}/status`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
    });
    const advisorStatus = await app.inject({
      method: "GET",
      url: `${base}/status`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` }
    });
    const auditorQr = await app.inject({
      method: "GET",
      url: `${base}/qr`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` }
    });
    const adminQr = await app.inject({
      method: "GET",
      url: `${base}/qr`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });
    const coordinatorConnect = await app.inject({
      method: "POST",
      url: `${base}/connect`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` },
      payload: {}
    });
    const adminConnect = await app.inject({
      method: "POST",
      url: `${base}/connect`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: {}
    });

    expect(coordinatorStatus.statusCode).toBe(502);
    expect(advisorStatus.statusCode).toBe(403);
    expect(auditorQr.statusCode).toBe(403);
    expect(adminQr.statusCode).toBe(502);
    expect(adminQr.headers["cache-control"]).toContain("no-store");
    expect(adminQr.headers.pragma).toBe("no-cache");
    expect(coordinatorConnect.statusCode).toBe(403);
    expect(adminConnect.statusCode).toBe(502);
  });

  it("rejects path traversal in the proxied suffix", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/..%2Fadmin`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(400);
  });

  it("lists tenants through the gateway when the tenant edge is configured", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    // Tenant edge credential is present; upstream is intentionally down → 502.
    expect(response.statusCode).toBe(502);
  });

  it("filters the tenant directory by active product grants without an admin bypass", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        data: [
          { id: AUTHORIZED_TENANT_ID, name: "Authorized" },
          { id: OTHER_TENANT_ID, name: "Foreign" }
        ]
      })
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual([{ id: AUTHORIZED_TENANT_ID, name: "Authorized" }]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("fails closed on /v1/tenants without contacting upstream when the tenant edge is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    let isolatedApp: FastifyInstance | undefined;
    try {
      const handle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes({
          resolveSession: async (token) => sessions[token],
          gatewayCredentials: {
            identity: GATEWAY_TO_IDENTITY_TOKEN,
            integration: GATEWAY_TO_INTEGRATION_TOKEN,
            pulsoIris: GATEWAY_TO_PULSO_TOKEN,
            lumen: GATEWAY_TO_LUMEN_TOKEN,
            tenant: ""
          }
        })
      });
      isolatedApp = handle.app;

      const response = await isolatedApp.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().data.error).toContain("tenant edge credential");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await isolatedApp?.close();
      fetchMock.mockRestore();
    }
  });

  it("attests the tenant edge with the dedicated gateway credential", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${GATEWAY_TO_TENANT_TOKEN}`);
      expect(headers.get("x-hyperion-caller")).toBe("api-gateway");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("enforces tenant membership and role permissions for LUMEN", async () => {
    const encounterId = "00000000-0000-4000-8000-000000000020";
    const advisorWrite = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/encounters/${encounterId}/start`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: {}
    });
    const auditorRead = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/worklist`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` }
    });
    const auditorWrite = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/encounters/${encounterId}/start`,
      headers: { authorization: `Bearer ${AUDITOR_TOKEN}` },
      payload: {}
    });
    const foreignTenant = await app.inject({
      method: "GET",
      url: `/v1/tenants/${OTHER_TENANT_ID}/lumen/worklist`,
      headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
    });

    expect(advisorWrite.statusCode).toBe(502);
    expect(auditorRead.statusCode).toBe(502);
    expect(auditorWrite.statusCode).toBe(403);
    expect(foreignTenant.statusCode).toBe(403);
  });

  it("accepts a validated LUMEN audio payload above the global API body limit", async () => {
    const encounterId = "00000000-0000-4000-8000-000000000020";
    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/encounters/${encounterId}/transcriptions`,
      headers: { authorization: `Bearer ${ADVISOR_TOKEN}` },
      payload: {
        audioBase64: "A".repeat(1_200_000),
        mimeType: "audio/webm",
        source: "authorized_upload",
        durationSeconds: 30,
        idempotencyKey: "ad67c1d8-09c7-4f75-82bb-f55ec14d33ba"
      }
    });

    // The isolated upstream is intentionally unavailable; reaching the proxy
    // proves the LUMEN route overrode Fastify's 1 MiB global body limit.
    expect(response.statusCode).toBe(502);
  });
});

describe("api-gateway routes", () => {
  it("serves the platform catalog with all services", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/platform/catalog",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.services).toHaveLength(15);
    expect(body.meta.generatedAt).toBeTruthy();
  });

  it("rejects tenant ids that are not UUIDs before proxying", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/not-a-uuid/pulso-iris/overview",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().data.error).toContain("UUID");
  });

  it("blocks path traversal attempts in the tenant segment", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/abc%2F..%2F..%2Fpulso-iris%2Fcatalog/pulso-iris/overview",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns an enveloped 502 when the upstream service is unavailable", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "x-request-id": "corr-gateway-502"
      }
    });

    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.data.error).toBeTruthy();
    expect(body.meta.requestId).toBe("corr-gateway-502");
  });

  it("reports platform health as down when no downstream responds", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("downstream unavailable"));
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/platform/health",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe("down");
      expect(body.services).toHaveLength(14);
      expect(fetchMock).toHaveBeenCalledTimes(14);
      expect(fetchMock.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  }, 15_000);
});
