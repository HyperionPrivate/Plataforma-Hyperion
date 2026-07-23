import { accessPrincipalSchema, type AccessPrincipal } from "@hyperion/platform-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPulsoBff,
  PULSO_BFF_PUBLIC_ROUTE_POLICIES,
  PULSO_BFF_READINESS_PROBE_TIMEOUT_MS,
  PULSO_BFF_TENANT_ROUTE_POLICIES,
  PULSO_CSRF_COOKIE,
  PULSO_SESSION_COOKIE,
  UPSTREAM_JSON_BODY_LIMIT_BYTES,
  type PulsoBffOptions
} from "./app.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ID = "22222222-2222-4222-8222-222222222222";
const SESSION = "header.payload.signature-pulso-session";
const ASSERTION_KEY = "pulso-operator-assertion-key-0001";
const ACCESS_READY_URL = "http://access.test/ready";
const PULSO_CORE_READY_URL = "http://pulso.test/ready";
const PULSO_INTEGRATION_READY_URL = "http://integration.test/ready";
const PULSO_CREDENTIALS: PulsoBffOptions["credentials"] = {
  core: "pulso-core-token",
  sofia: "pulso-sofia-token",
  "prompt-flow": "pulso-prompt-token",
  knowledge: "pulso-knowledge-token",
  integration: "pulso-integration-token",
  whatsapp: "pulso-whatsapp-token"
};

describe("PULSO BFF boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checks only signing keys, Access and the upstreams actually published by the PULSO allowlist", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const url = String(input);
      if ([ACCESS_READY_URL, PULSO_CORE_READY_URL, PULSO_INTEGRATION_READY_URL].includes(url)) {
        return Response.json({ status: "ok" });
      }
      return new Response(null, { status: 404 });
    });
    const app = createApp({
      fetch: request,
      accessKeyReadiness: async () => true,
      credentials: {
        ...PULSO_CREDENTIALS,
        sofia: undefined,
        "prompt-flow": undefined,
        knowledge: undefined,
        whatsapp: undefined
      }
    });

    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(PULSO_BFF_READINESS_PROBE_TIMEOUT_MS).toBe(3_000);
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      service: "pulso-bff",
      product: "PULSO_IRIS",
      status: "ok",
      dependencies: [
        { name: "access-signing-keys", status: "ok", required: true },
        { name: "access-token-minting", status: "ok", required: false },
        { name: "pulso-core", status: "ok", required: true },
        { name: "pulso-integration", status: "ok", required: true }
      ]
    });
    expect(request.mock.calls.map(([input]) => String(input)).sort()).toEqual(
      [ACCESS_READY_URL, PULSO_CORE_READY_URL, PULSO_INTEGRATION_READY_URL].sort()
    );
    expect(request.mock.calls.flat().join(" ")).not.toMatch(/sofia\.test|prompt\.test|knowledge\.test|whatsapp\.test/);
    await app.close();
  });

  it("keeps liveness up but readiness down when required PULSO configuration or signing keys are unavailable", async () => {
    const missingConfiguration: Array<Partial<PulsoBffOptions>> = [
      { accessCredential: undefined },
      { operatorAssertionKey: undefined },
      { credentials: { ...PULSO_CREDENTIALS, core: undefined } },
      { credentials: { ...PULSO_CREDENTIALS, integration: undefined } }
    ];
    for (const overrides of missingConfiguration) {
      const request = vi.fn<typeof fetch>();
      const accessKeyReadiness = vi.fn(async () => true);
      const app = createApp({ ...overrides, fetch: request, accessKeyReadiness });
      const [health, ready] = await Promise.all([
        app.inject({ method: "GET", url: "/health" }),
        app.inject({ method: "GET", url: "/ready" })
      ]);
      expect(health.statusCode).toBe(200);
      expect(ready.statusCode).toBe(503);
      expect(ready.json().dependencies).toEqual([{ name: "workload-configuration", status: "down", required: true }]);
      expect(request).not.toHaveBeenCalled();
      expect(accessKeyReadiness).not.toHaveBeenCalled();
      await app.close();
    }

    const request = vi.fn<typeof fetch>(async () => Response.json({ status: "ok" }));
    const app = createApp({ fetch: request, accessKeyReadiness: async () => false });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().dependencies).toContainEqual({
      name: "access-signing-keys",
      status: "down",
      required: true
    });
    await app.close();
  });

  it("keeps cached sessions routable when Access token minting is temporarily unavailable", async () => {
    const request = vi.fn<typeof fetch>(async (input) =>
      String(input) === ACCESS_READY_URL
        ? Response.json({ status: "down" }, { status: 503 })
        : Response.json({ status: "ok" })
    );
    const app = createApp({ fetch: request, accessKeyReadiness: async () => true });

    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(ready.statusCode).toBe(200);
    expect(ready.json().dependencies).toContainEqual({
      name: "access-token-minting",
      status: "degraded",
      required: false
    });
    await app.close();
  });

  it("fails closed for unsafe responses from every required PULSO upstream without leaking details", async () => {
    const failures: Array<{ name: string; target: string; response: () => Promise<Response> }> = [
      {
        name: "core-http-error",
        target: PULSO_CORE_READY_URL,
        response: async () => Response.json({ status: "down" }, { status: 503 })
      },
      {
        name: "core-down-payload",
        target: PULSO_CORE_READY_URL,
        response: async () => Response.json({ status: "down" })
      },
      {
        name: "integration-wrong-media-type",
        target: PULSO_INTEGRATION_READY_URL,
        response: async () => new Response('{"status":"ok"}', { headers: { "content-type": "text/html" } })
      },
      {
        name: "integration-invalid-json",
        target: PULSO_INTEGRATION_READY_URL,
        response: async () => new Response("{", { headers: { "content-type": "application/json" } })
      },
      {
        name: "core-redirect",
        target: PULSO_CORE_READY_URL,
        response: async () => new Response(null, { status: 302, headers: { location: "/ready" } })
      },
      {
        name: "integration-timeout",
        target: PULSO_INTEGRATION_READY_URL,
        response: async () => {
          throw new DOMException("timed out", "TimeoutError");
        }
      }
    ];
    for (const failure of failures) {
      const request = vi.fn<typeof fetch>(async (input) =>
        String(input) === failure.target ? failure.response() : Response.json({ status: "ok" })
      );
      const app = createApp({ fetch: request, accessKeyReadiness: async () => true });
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode, failure.name).toBe(503);
      expect(ready.json().dependencies, failure.name).toContainEqual({
        name: failure.target === PULSO_CORE_READY_URL ? "pulso-core" : "pulso-integration",
        status: "down",
        required: true
      });
      expect(ready.body, failure.name).not.toMatch(/https?:\/\/|pulso-(?:core|integration)-token|assertion-key/i);
      await app.close();
    }
  });

  it("reports unsafe Access readiness as optional degradation", async () => {
    const accessFailures = [
      async () => new Response('{"status":"ok"}', { headers: { "content-type": "text/plain" } }),
      async () => new Response("{", { headers: { "content-type": "application/json" } }),
      async () => new Response(null, { status: 307, headers: { location: "/ready" } }),
      async () => {
        throw new DOMException("timed out", "TimeoutError");
      }
    ];
    for (const accessFailure of accessFailures) {
      const request = vi.fn<typeof fetch>(async (input) =>
        String(input) === ACCESS_READY_URL ? accessFailure() : Response.json({ status: "ok" })
      );
      const app = createApp({ fetch: request, accessKeyReadiness: async () => true });
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().dependencies).toContainEqual({
        name: "access-token-minting",
        status: "degraded",
        required: false
      });
      await app.close();
    }
  });

  it("limits invalid login bodies by observed IP and normalized accounts without trusting proxy headers", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { error: "Invalid credentials" } }, { status: 401 })
    );
    const app = createApp({ fetch: request });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: "198.51.100.30",
        headers: { "x-requested-with": "pulso-console", "x-forwarded-for": `203.0.113.${attempt + 1}` },
        payload: {}
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.30",
      headers: { "x-requested-with": "pulso-console", "x-forwarded-for": "203.0.113.200" },
      payload: {}
    });
    const isolated = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.31",
      headers: { "x-requested-with": "pulso-console", "x-forwarded-for": "203.0.113.200" },
      payload: {}
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(isolated.statusCode).toBe(401);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: `198.51.100.${100 + attempt}`,
        headers: { "x-requested-with": "pulso-console" },
        payload: {
          email: attempt % 2 === 0 ? " Advisor@Example.COM " : "advisor@example.com",
          password: "invalid-password"
        }
      });
      expect(response.statusCode).toBe(401);
    }
    const distributedBlocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.230",
      headers: { "x-requested-with": "pulso-console" },
      payload: { email: "advisor@example.com", password: "invalid-password" }
    });
    const neighborAccount = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.230",
      headers: { "x-requested-with": "pulso-console" },
      payload: { email: "neighbor@example.com", password: "invalid-password" }
    });
    expect(distributedBlocked.statusCode).toBe(429);
    expect(neighborAccount.statusCode).toBe(401);
    expect(request).toHaveBeenCalledTimes(22);
    await app.close();
  });

  it.each(["nova", "lumen", "sofia", "knowledge", "whatsapp"])(
    "returns 404 for the non-exposed %s namespace",
    async (component) => {
      const request = vi.fn<typeof fetch>();
      const app = createApp({ fetch: request });
      const response = await app.inject({
        method: "GET",
        url: `/v1/tenants/${TENANT_ID}/${component}/status`
      });
      expect(response.statusCode).toBe(404);
      expect(request).not.toHaveBeenCalled();
      await app.close();
    }
  );

  it("registers only the reviewed PULSO method, route, capability and role policies", async () => {
    expect(PULSO_BFF_TENANT_ROUTE_POLICIES).toHaveLength(77);
    const routeKeys = PULSO_BFF_TENANT_ROUTE_POLICIES.map((policy) => `${policy.method} ${policy.path}`);
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
    expect(PULSO_BFF_TENANT_ROUTE_POLICIES.every((policy) => !policy.path.includes("*"))).toBe(true);
    expect(
      PULSO_BFF_TENANT_ROUTE_POLICIES.every(
        (policy) => policy.method.length > 0 && policy.path.startsWith("/v1/tenants/") && policy.capability.length > 0
      )
    ).toBe(true);
    expect(
      PULSO_BFF_TENANT_ROUTE_POLICIES.find((policy) => policy.method === "GET" && policy.path.endsWith("/config/sites"))
    ).toMatchObject({ capability: "pulso:read", roles: ["admin", "coordinator", "auditor"] });
    expect(
      PULSO_BFF_TENANT_ROUTE_POLICIES.find(
        (policy) => policy.method === "POST" && policy.path.endsWith("/integrations/whatsapp/connect")
      )
    ).toMatchObject({ capability: "pulso:admin", roles: ["admin"] });
    expect(routeKeys).not.toContain("POST /v1/tenants/:tenantId/pulso-iris/simulation/appointments");

    const app = createApp();
    await app.ready();
    for (const policy of PULSO_BFF_TENANT_ROUTE_POLICIES) {
      expect(app.hasRoute({ method: policy.method, url: policy.path })).toBe(true);
    }
    for (const policy of Object.values(PULSO_BFF_PUBLIC_ROUTE_POLICIES)) {
      expect(app.hasRoute({ method: policy.method, url: policy.path })).toBe(true);
    }
    await app.close();
  });

  it("fails closed before session resolution for unlisted PULSO method and route pairs", async () => {
    const resolvePrincipal = vi.fn(async () => principal());
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: { unexpectedlyExposed: true } }));
    const app = createApp({ resolvePrincipal, fetch: request });

    const futureRoute = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/future-provider-export`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    const wrongMethod = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/overview`,
      headers: {
        cookie: `${PULSO_SESSION_COOKIE}=${SESSION}; ${PULSO_CSRF_COOKIE}=csrf-session-token`,
        "x-csrf-token": "csrf-session-token"
      }
    });
    const simulation = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/simulation/appointments`,
      headers: {
        cookie: `${PULSO_SESSION_COOKIE}=${SESSION}; ${PULSO_CSRF_COOKIE}=csrf-session-token`,
        "x-csrf-token": "csrf-session-token"
      },
      payload: {}
    });

    expect(futureRoute.statusCode).toBe(404);
    expect(wrongMethod.statusCode).toBe(404);
    expect(simulation.statusCode).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not authorize PULSO configuration or Integration status from method-derived capabilities alone", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: { unexpectedlyAuthorized: true } }));
    const app = createApp({ fetch: request });

    const config = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/config/sites`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    const integrationStatus = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/integrations/whatsapp/status`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });

    expect(config.statusCode).toBe(403);
    expect(integrationStatus.statusCode).toBe(403);
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it("preserves reviewed PULSO config access for auditors and coordinated writes", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: { allowed: true } }));
    const auditor = createApp({
      fetch: request,
      resolvePrincipal: async () => principal([{ roles: ["auditor"], capabilities: ["pulso:read"] }])
    });
    const read = await auditor.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/config/sites`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    expect(read.statusCode).toBe(200);
    await auditor.close();

    const coordinator = createApp({
      fetch: request,
      resolvePrincipal: async () => principal([{ roles: ["coordinator"], capabilities: ["pulso:read", "pulso:write"] }])
    });
    const write = await coordinator.inject({
      method: "PATCH",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/config/sites/33333333-3333-4333-8333-333333333333`,
      headers: {
        cookie: `${PULSO_SESSION_COOKIE}=${SESSION}; ${PULSO_CSRF_COOKIE}=csrf-session-token`,
        "x-csrf-token": "csrf-session-token"
      },
      payload: { name: "Reviewed site" }
    });
    expect(write.statusCode).toBe(200);
    expect(request).toHaveBeenCalledTimes(2);
    await coordinator.close();
  });

  it("rejects unreviewed config resources before resolving a session", async () => {
    const resolvePrincipal = vi.fn(async () => principal());
    const request = vi.fn<typeof fetch>();
    const app = createApp({ resolvePrincipal, fetch: request });
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/config/import/future-resource/template`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    expect(response.statusCode).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an active PULSO_IRIS grant for the selected tenant", async () => {
    const app = createApp({
      resolvePrincipal: async () =>
        principal([{ productId: "LUMEN", roles: ["advisor"], capabilities: ["lumen:read"] }])
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/overview`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it.each([
    ["pulso-iris", "overview", "http://pulso.test", "pulso-core-token", "advisor"],
    ["integrations", "whatsapp/status", "http://integration.test", "pulso-integration-token", "coordinator"]
  ])("routes %s only to its cell-owned upstream", async (component, suffix, base, credential, role) => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${base}/v1/tenants/${TENANT_ID}/${component}/${suffix}`);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${credential}`);
      expect(headers.get("x-hyperion-caller")).toBe("pulso-bff");
      expect(headers.get("x-operator-id")).toBe(OPERATOR_ID);
      expect(headers.get("x-hyperion-operator-assertion")).toMatch(
        new RegExp(`^${OPERATOR_ID}\\|${role}\\|${TENANT_ID}\\|PULSO_IRIS\\|`)
      );
      expect(init?.redirect).toBe("error");
      return Response.json({ data: { status: "ok" } });
    });
    const app = createApp({
      fetch: request,
      resolvePrincipal: async () => principal([{ roles: [role] }])
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/${component}/${suffix}`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("fails closed on unsafe upstream representations and only forwards valid JSON", async () => {
    const upstreamResponses = [
      new Response("<script>pulso-html-marker</script>", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          location: "https://evil.example/",
          "set-cookie": "evil=1"
        }
      }),
      new Response(null, {
        status: 302,
        headers: {
          "content-type": "application/json",
          location: "https://evil.example/",
          "set-cookie": "evil=1"
        }
      }),
      new Response(JSON.stringify({ data: { format: "problem+json" } }), {
        status: 200,
        headers: {
          "content-type": "application/problem+json; charset=utf-8",
          "cache-control": "no-store, private, max-age=0",
          pragma: "no-cache",
          expires: "0",
          location: "https://evil.example/",
          "set-cookie": "evil=1"
        }
      }),
      new Response(null, { status: 204 }),
      new Response(null, { status: 205 }),
      new Response(JSON.stringify("pulso-scalar-marker"), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      new Response("pulso-invalid-json-marker", {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      })
    ];
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      const response = upstreamResponses.shift();
      if (!response) throw new Error("Unexpected upstream request");
      return response;
    });
    const app = createApp({ fetch: request });
    const inject = () =>
      app.inject({
        method: "GET",
        url: `/v1/tenants/${TENANT_ID}/pulso-iris/overview`,
        headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
      });

    const html = await inject();
    expect(html.statusCode).toBe(502);
    expect(html.body).not.toContain("pulso-html-marker");
    expect(html.headers.location).toBeUndefined();
    expect(html.headers["set-cookie"]).toBeUndefined();
    expect(html.headers["x-content-type-options"]).toBe("nosniff");

    const redirect = await inject();
    expect(redirect.statusCode).toBe(502);
    expect(redirect.headers.location).toBeUndefined();
    expect(redirect.headers["set-cookie"]).toBeUndefined();

    const json = await inject();
    expect(json.statusCode).toBe(200);
    expect(json.json()).toEqual({ data: { format: "problem+json" } });
    expect(json.headers["content-type"]).toMatch(/^application\/json\b/);
    expect(json.headers["cache-control"]).toBe("no-store, private, max-age=0");
    expect(json.headers.pragma).toBe("no-cache");
    expect(json.headers.expires).toBe("0");
    expect(json.headers.location).toBeUndefined();
    expect(json.headers["set-cookie"]).toBeUndefined();

    const empty = await inject();
    expect(empty.statusCode).toBe(204);
    expect(empty.body).toBe("");

    const reset = await inject();
    expect(reset.statusCode).toBe(205);
    expect(reset.body).toBe("");

    const scalar = await inject();
    expect(scalar.statusCode).toBe(200);
    expect(scalar.body).toBe(JSON.stringify("pulso-scalar-marker"));
    expect(scalar.json()).toBe("pulso-scalar-marker");

    const invalidJson = await inject();
    expect(invalidJson.statusCode).toBe(502);
    expect(invalidJson.body).not.toContain("pulso-invalid-json-marker");
    expect(request).toHaveBeenCalledTimes(7);
    await app.close();
  });

  it("preserves the Integration no-store policy on the exact WhatsApp QR route", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`http://integration.test/v1/tenants/${TENANT_ID}/integrations/whatsapp/qr`);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-operator-role")).toBe("admin");
      expect(headers.get("x-hyperion-operator-assertion")).toMatch(
        new RegExp(`^${OPERATOR_ID}\\|admin\\|${TENANT_ID}\\|PULSO_IRIS\\|`)
      );
      return new Response(JSON.stringify({ data: { qr: "sensitive-qr-marker" } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store, private, max-age=0",
          pragma: "no-cache",
          expires: "0"
        }
      });
    });
    const coordinator = createApp({
      fetch: request,
      resolvePrincipal: async () => principal([{ roles: ["coordinator"], capabilities: ["pulso:admin"] }])
    });
    const forbidden = await coordinator.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/integrations/whatsapp/qr`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(request).not.toHaveBeenCalled();
    await coordinator.close();

    const app = createApp({
      fetch: request,
      resolvePrincipal: async () => principal([{ roles: ["auditor", "admin"], capabilities: ["pulso:admin"] }])
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/integrations/whatsapp/qr`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers.expires).toBe("0");
    expect(request).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not auto-expose HEAD for an allowed PULSO GET route", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    const app = createApp({ fetch: request });
    const response = await app.inject({
      method: "HEAD",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/overview`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    expect(response.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it("cancels PULSO JSON responses that exceed the byte limit before or during streaming", async () => {
    const cancellations: string[] = [];
    const encoder = new TextEncoder();
    const upstreamResponses = [
      cancellableJsonResponse(
        [encoder.encode('{"marker":"declared-oversize"}')],
        () => cancellations.push("declared"),
        UPSTREAM_JSON_BODY_LIMIT_BYTES + 1
      ),
      cancellableJsonResponse(
        [new Uint8Array(UPSTREAM_JSON_BODY_LIMIT_BYTES), encoder.encode("streamed-oversize-marker")],
        () => cancellations.push("streamed")
      )
    ];
    const request = vi.fn<typeof fetch>(async () => {
      const response = upstreamResponses.shift();
      if (!response) throw new Error("Unexpected upstream request");
      return response;
    });
    const app = createApp({ fetch: request });
    const inject = () =>
      app.inject({
        method: "GET",
        url: `/v1/tenants/${TENANT_ID}/pulso-iris/overview`,
        headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
      });

    const declared = await inject();
    expect(declared.statusCode).toBe(502);
    expect(declared.body).not.toContain("declared-oversize");
    const streamed = await inject();
    expect(streamed.statusCode).toBe(502);
    expect(streamed.body).not.toContain("streamed-oversize-marker");
    expect(cancellations).toEqual(["declared", "streamed"]);
    expect(request).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("routes the exact PULSO SOFIA readiness policy to Integration", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`http://integration.test/v1/tenants/${TENANT_ID}/pulso-iris/sofia/readiness`);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer pulso-integration-token");
      expect(headers.get("x-hyperion-caller")).toBe("pulso-bff");
      expect(headers.get("x-hyperion-operator-assertion")).toMatch(
        new RegExp(`^${OPERATOR_ID}\\|coordinator\\|${TENANT_ID}\\|PULSO_IRIS\\|`)
      );
      return Response.json({ data: { status: "ready" } });
    });
    const app = createApp({
      fetch: request,
      resolvePrincipal: async () => principal([{ roles: ["coordinator"] }])
    });
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/sofia/readiness`,
      headers: { cookie: `${PULSO_SESSION_COOKIE}=${SESSION}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("ready");
    expect(request).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects writes without both pulso:write and a matching CSRF token", async () => {
    const readonly = createApp({
      resolvePrincipal: async () => principal([{ capabilities: ["pulso:read"] }])
    });
    const noCapability = await readonly.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/appointments`,
      headers: {
        cookie: `${PULSO_SESSION_COOKIE}=${SESSION}; ${PULSO_CSRF_COOKIE}=csrf-one`,
        "x-csrf-token": "csrf-one"
      },
      payload: {}
    });
    expect(noCapability.statusCode).toBe(403);
    await readonly.close();

    const app = createApp();
    const csrfMismatch = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/pulso-iris/appointments`,
      headers: {
        cookie: `${PULSO_SESSION_COOKIE}=${SESSION}; ${PULSO_CSRF_COOKIE}=csrf-one`,
        "x-csrf-token": "csrf-two"
      },
      payload: {}
    });
    expect(csrfMismatch.statusCode).toBe(403);
    await app.close();
  });

  it("creates a product-origin cookie session without exposing the bearer", async () => {
    const nowMs = Date.parse("2026-07-17T12:00:00.000Z");
    const token = fakeJwt(Math.floor(nowMs / 1000) + 300);
    const access = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://access.test/v1/access/token");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer pulso-to-access-token");
      expect(headers.get("x-hyperion-caller")).toBe("pulso-bff");
      return Response.json(
        { data: { token, tokenType: "Bearer", expiresAt: new Date(nowMs + 300_000).toISOString() } },
        { status: 201 }
      );
    });
    const app = createApp({
      fetch: access,
      now: () => nowMs,
      resolvePrincipal: async (candidate) => (candidate === token ? principal() : undefined)
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-requested-with": "pulso-console" },
      payload: { email: "advisor@example.test", password: "valid-password" }
    });
    expect(response.statusCode).toBe(201);
    const cookies = response.headers["set-cookie"];
    const serialized = Array.isArray(cookies) ? cookies.join("\n") : String(cookies);
    expect(serialized).toContain(`${PULSO_SESSION_COOKIE}=`);
    expect(serialized).toContain("HttpOnly");
    expect(serialized).toContain("Secure");
    expect(serialized).toContain("SameSite=Strict");
    expect(serialized).not.toContain("Domain=");
    expect(response.body).not.toContain(token);
    await app.close();
  });

  it("rejects an oversized session before emitting any Set-Cookie header", async () => {
    const oversizedToken = `header.payload.${"x".repeat(4050)}`;
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        { data: { token: oversizedToken, accessToken: oversizedToken, tokenType: "Bearer" } },
        { status: 201 }
      )
    );
    const app = createApp({
      fetch: request,
      resolvePrincipal: async (token) => (token === oversizedToken ? principal() : undefined)
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-requested-with": "pulso-console" },
      payload: { email: "oversized@example.com", password: "valid-password" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(oversizedToken);
    await app.close();
  });

  it("lists only PULSO grants and never accepts a browser Authorization bearer", async () => {
    const app = createApp();
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: {
        authorization: "Bearer attacker-controlled-token",
        cookie: `${PULSO_SESSION_COOKIE}=${SESSION}`
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{ id: TENANT_ID, displayName: "Tenant 11111111" }]);
    await app.close();
  });

  it("projects one bearer-free console session with opaque tenants and the CSRF token", async () => {
    const app = createApp({
      resolvePrincipal: async () =>
        principal([{}, { productId: "LUMEN", roles: ["advisor"], capabilities: ["lumen:read"] }])
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: {
        cookie: `${PULSO_SESSION_COOKIE}=${SESSION}; ${PULSO_CSRF_COOKIE}=csrf-session-token`
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      operator: { id: OPERATOR_ID },
      tenants: [{ id: TENANT_ID, displayName: "Tenant 11111111" }],
      grants: [{ tenantId: TENANT_ID, productId: "PULSO_IRIS" }],
      csrfToken: "csrf-session-token"
    });
    expect(response.body).not.toContain(SESSION);
    expect(response.body).not.toContain("LUMEN");
    expect(response.body).not.toContain('"slug"');
    await app.close();
  });
});

function createApp(overrides: Partial<PulsoBffOptions> = {}) {
  return createPulsoBff({
    resolvePrincipal: async (token) => (token === SESSION ? principal() : undefined),
    accessKeyReadiness: async () => true,
    accessUrl: "http://access.test",
    accessCredential: "pulso-to-access-token",
    upstreams: {
      core: "http://pulso.test",
      sofia: "http://sofia.test",
      "prompt-flow": "http://prompt.test",
      knowledge: "http://knowledge.test",
      integration: "http://integration.test",
      whatsapp: "http://whatsapp.test"
    },
    credentials: PULSO_CREDENTIALS,
    operatorAssertionKey: ASSERTION_KEY,
    fetch: async () => Response.json({ data: {} }),
    now: () => Date.parse("2026-07-17T12:00:00.000Z"),
    ...overrides
  });
}

function principal(
  grants: Array<{
    productId?: string;
    roles?: string[];
    capabilities?: string[];
    active?: boolean;
  }> = [{}]
): AccessPrincipal {
  return accessPrincipalSchema.parse({
    operator: {
      id: OPERATOR_ID,
      email: "advisor@example.test",
      displayName: "PULSO Advisor",
      role: "advisor"
    },
    grants: grants.map((grant) => ({
      tenantId: TENANT_ID,
      productId: grant.productId ?? "PULSO_IRIS",
      roles: grant.roles ?? ["advisor"],
      capabilities: grant.capabilities ?? ["pulso:read", "pulso:write"],
      active: grant.active ?? true
    }))
  });
}

function fakeJwt(exp: number): string {
  return [
    Buffer.from(JSON.stringify({ alg: "RS256", kid: "test" })).toString("base64url"),
    Buffer.from(JSON.stringify({ exp })).toString("base64url"),
    "test-signature"
  ].join(".");
}

function cancellableJsonResponse(
  chunks: readonly Uint8Array[],
  onCancel: () => void,
  declaredLength?: number
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = chunks[index];
        if (chunk) {
          index += 1;
          controller.enqueue(chunk);
        }
      },
      cancel() {
        onCancel();
      }
    },
    { highWaterMark: 0 }
  );
  const headers = new Headers({ "content-type": "application/json" });
  if (declaredLength !== undefined) headers.set("content-length", String(declaredLength));
  return new Response(body, { status: 200, headers });
}
