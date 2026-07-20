import { OPERATOR_ASSERTION_HEADER, createService, verifyOperatorAssertion } from "@hyperion/service-runtime";
import type { AccessMe, ProductGrant } from "@hyperion/platform-contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createGatewayRoutes } from "./app.js";
import { legacyGatewayTelemetry } from "./legacy-product-policy.js";

const AUTHORIZED_TENANT_ID = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
const OTHER_TENANT_ID = "3b8e6d4c-2a19-4f87-b6e5-1d0c9b8a7f6e";
const ADMIN_TOKEN = "admin-test-token-1234567890";
const COORDINATOR_TOKEN = "coordinator-test-token-1234567890";
const ADVISOR_TOKEN = "advisor-test-token-1234567890";
const GATEWAY_TO_IDENTITY_TOKEN = "gateway-to-identity-test-token-001";
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
  }
};

let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.LEGACY_GATEWAY_ENABLED;
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

  it("rejects unauthenticated product payloads before parsing their body", async () => {
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

  it("preserves grants returned for an opaque session token on platform routes", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/auth/me")) {
        return Response.json({ data: sessions[COORDINATOR_TOKEN] });
      }
      throw new Error(`Unexpected upstream request: ${url}`);
    });
    let opaqueApp: FastifyInstance | undefined;
    try {
      const handle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes()
      });
      opaqueApp = handle.app;

      const response = await opaqueApp.inject({
        method: "GET",
        url: "/v1/platform/catalog",
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });

      expect(COORDINATOR_TOKEN.split(".")).toHaveLength(1);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.services).toBeTruthy();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await opaqueApp?.close();
      fetchMock.mockRestore();
    }
  });

  it("returns 410 for retired product facade routes and increments telemetry", async () => {
    const before = legacyGatewayTelemetry.disabledRejects;
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      const tenantProduct = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
        headers: { authorization: `Bearer ${COORDINATOR_TOKEN}` }
      });
      const discovery = await app.inject({
        method: "GET",
        url: "/v1/nova/health",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      const whatsapp = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/integrations/whatsapp/status`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      const lumen = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/lumen/worklist`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });

      expect(tenantProduct.statusCode).toBe(410);
      expect(discovery.statusCode).toBe(410);
      expect(whatsapp.statusCode).toBe(410);
      expect(lumen.statusCode).toBe(410);
      expect(tenantProduct.json().data.error).toContain("permanently retired");
      expect(legacyGatewayTelemetry.disabledRejects).toBe(before + 4);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("ignores LEGACY_GATEWAY_ENABLED when retiring product routes", async () => {
    process.env.LEGACY_GATEWAY_ENABLED = "true";
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/nova/campaigns`,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      expect(response.statusCode).toBe(410);
    } finally {
      delete process.env.LEGACY_GATEWAY_ENABLED;
    }
  });

  it("fails closed when the identity gateway credential is missing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    let isolatedApp: FastifyInstance | undefined;
    try {
      const handle = await createService({
        serviceName: "api-gateway",
        databaseRequired: false,
        publicApi: true,
        registerRoutes: createGatewayRoutes({
          resolveSession: async (token) => sessions[token],
          gatewayCredentials: { identity: "", tenant: "" }
        })
      });
      isolatedApp = handle.app;

      const identity = await isolatedApp.inject({
        method: "GET",
        url: "/v1/identity/operators",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      const tenants = await isolatedApp.inject({
        method: "GET",
        url: "/v1/tenants",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
      });

      expect(identity.statusCode).toBe(503);
      expect(tenants.statusCode).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await isolatedApp?.close();
      fetchMock.mockRestore();
    }
  });

  it("uses the dedicated gateway identity for Identity operator routes", async () => {
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

      expect(identity.statusCode).toBe(200);
      const identityHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
      expect(identityHeaders.get("authorization")).toBe(`Bearer ${GATEWAY_TO_IDENTITY_TOKEN}`);
      expect(identityHeaders.get("x-hyperion-caller")).toBe("api-gateway");
      expect(
        verifyOperatorAssertion(identityHeaders.get(OPERATOR_ASSERTION_HEADER) ?? undefined, OPERATOR_ASSERTION_KEY)
      ).not.toHaveProperty("tenantId");
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

  it("rejects ambiguous separators before authorization", async () => {
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

  it("rejects path traversal in tenant product path segments", async () => {
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

  it("keeps LIWA webhook probes public", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/liwa/webhooks" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.ok).toBe(true);
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

  it("blocks path traversal attempts in the tenant segment", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants/abc%2F..%2F..%2Fpulso-iris%2Fcatalog/pulso-iris/overview",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` }
    });

    expect(response.statusCode).toBe(400);
  });

  it("returns an enveloped 410 for retired product routes", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${AUTHORIZED_TENANT_ID}/pulso-iris/overview`,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        "x-request-id": "corr-gateway-410"
      }
    });

    expect(response.statusCode).toBe(410);
    const body = response.json();
    expect(body.data.error).toContain("permanently retired");
    expect(body.meta.requestId).toBe("corr-gateway-410");
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
