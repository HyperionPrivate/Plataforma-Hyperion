import { accessPrincipalSchema, type AccessPrincipal } from "@hyperion/platform-contracts";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNovaBff,
  NOVA_BFF_PUBLIC_ROUTE_POLICIES,
  NOVA_BFF_READINESS_PROBE_TIMEOUT_MS,
  NOVA_BFF_TENANT_ROUTE_POLICIES,
  NOVA_CSRF_COOKIE,
  NOVA_SESSION_COOKIE,
  PROVIDER_CLIENT_IP_HEADER,
  PROVIDER_EDGE_TOKEN_HEADER,
  PROVIDER_WEBHOOK_RATE_LIMIT_MAX,
  UPSTREAM_JSON_BODY_LIMIT_BYTES,
  type NovaBffOptions
} from "./app.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const bearer = `Bearer ${"session-token-".repeat(3)}`;
const sessionToken = "session-token-value-that-is-long-enough";
const csrfToken = "csrf-token-value-that-is-long-enough";
const sessionCookies = `${NOVA_SESSION_COOKIE}=${sessionToken}; ${NOVA_CSRF_COOKIE}=${csrfToken}`;
const assertionKey = "nova-operator-assertion-key-0001";
const providerEdgeCredential = "nova-provider-edge-credential-000001";
const ACCESS_READY_URL = "http://access.test/ready";
const NOVA_READINESS_URLS = Object.freeze({
  nova: "http://nova-core.test/ready",
  voice: "http://voice.test/ready",
  liwa: "http://liwa.test/ready",
  documents: "http://documents.test/ready"
});
const apps: ReturnType<typeof createNovaBff>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("NOVA BFF boundary", () => {
  it("reports ready only with usable signing keys, configuration and every routed NOVA upstream", async () => {
    const readinessUrls = [ACCESS_READY_URL, ...Object.values(NOVA_READINESS_URLS)];
    const requestFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return readinessUrls.includes(String(input))
        ? Response.json({ status: "ok" })
        : new Response(null, { status: 404 });
    });
    const accessKeyReadiness = vi.fn(async () => true);
    const app = buildApp(async () => undefined, requestFetch, 1_900_000_000_000, {
      accessKeyReadiness,
      providerEdgeCredential: undefined
    });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(NOVA_BFF_READINESS_PROBE_TIMEOUT_MS).toBe(3_000);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "nova-bff",
      product: "NOVA",
      status: "ok",
      dependencies: [
        { name: "access-signing-keys", status: "ok", required: true },
        { name: "access-token-minting", status: "ok", required: false },
        { name: "nova-core", status: "ok", required: true },
        { name: "nova-voice", status: "ok", required: true },
        { name: "nova-liwa", status: "ok", required: true },
        { name: "nova-documents", status: "ok", required: true }
      ]
    });
    expect(accessKeyReadiness).toHaveBeenCalledTimes(1);
    expect(requestFetch.mock.calls.map(([input]) => String(input)).sort()).toEqual(readinessUrls.sort());
  });

  it("keeps liveness up but readiness down when required workload configuration or signing keys are unavailable", async () => {
    const credentials: NovaBffOptions["credentials"] = {
      nova: "core-edge-token",
      voice: "voice-edge-token",
      liwa: "liwa-edge-token",
      documents: "documents-edge-token"
    };
    const missingConfiguration = [
      { accessCredential: undefined },
      { operatorAssertionKey: undefined },
      ...Object.keys(credentials).map((component) => ({
        credentials: { ...credentials, [component]: undefined }
      }))
    ] satisfies Array<Partial<NovaBffOptions>>;

    for (const overrides of missingConfiguration) {
      const requestFetch = vi.fn<typeof fetch>();
      const accessKeyReadiness = vi.fn(async () => true);
      const app = buildApp(async () => undefined, requestFetch, 1_900_000_000_000, {
        ...overrides,
        accessKeyReadiness
      });
      const [health, ready] = await Promise.all([
        app.inject({ method: "GET", url: "/health" }),
        app.inject({ method: "GET", url: "/ready" })
      ]);

      expect(health.statusCode).toBe(200);
      expect(ready.statusCode).toBe(503);
      expect(ready.json().dependencies).toEqual([{ name: "workload-configuration", status: "down", required: true }]);
      expect(requestFetch).not.toHaveBeenCalled();
      expect(accessKeyReadiness).not.toHaveBeenCalled();
    }

    const requestFetch = vi.fn<typeof fetch>(async () => Response.json({ status: "ok" }));
    const app = buildApp(async () => undefined, requestFetch, 1_900_000_000_000, {
      accessKeyReadiness: async () => false
    });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().dependencies).toContainEqual({
      name: "access-signing-keys",
      status: "down",
      required: true
    });
  });

  it("keeps cached sessions routable when Access token minting is temporarily unavailable", async () => {
    const requestFetch = vi.fn<typeof fetch>(async (input) =>
      String(input) === ACCESS_READY_URL
        ? Response.json({ status: "down" }, { status: 503 })
        : Response.json({ status: "ok" })
    );
    const app = buildApp(async () => undefined, requestFetch);

    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(ready.statusCode).toBe(200);
    expect(ready.json().dependencies).toContainEqual({
      name: "access-token-minting",
      status: "degraded",
      required: false
    });
  });

  it("fails readiness when any provider-owned routed upstream is unavailable", async () => {
    for (const [component, unavailableUrl] of Object.entries(NOVA_READINESS_URLS)) {
      const requestFetch = vi.fn<typeof fetch>(async (input) =>
        String(input) === unavailableUrl
          ? Response.json({ status: "down" }, { status: 503 })
          : Response.json({ status: "ok" })
      );
      const app = buildApp(async () => undefined, requestFetch);
      const ready = await app.inject({ method: "GET", url: "/ready" });

      expect(ready.statusCode, component).toBe(503);
      expect(ready.json().dependencies, component).toContainEqual({
        name: component === "nova" ? "nova-core" : `nova-${component}`,
        status: "down",
        required: true
      });
    }
  });

  it("fails closed for unsafe required readiness responses without leaking dependency details", async () => {
    const failures: Array<{ name: string; response: () => Promise<Response> }> = [
      { name: "down-payload", response: async () => Response.json({ status: "down" }) },
      {
        name: "wrong-media-type",
        response: async () => new Response('{"status":"ok"}', { headers: { "content-type": "text/html" } })
      },
      {
        name: "invalid-json",
        response: async () => new Response("{", { headers: { "content-type": "application/json" } })
      },
      { name: "redirect", response: async () => new Response(null, { status: 302, headers: { location: "/ready" } }) },
      {
        name: "timeout",
        response: async () => {
          throw new DOMException("timed out", "TimeoutError");
        }
      }
    ];

    for (const failure of failures) {
      const requestFetch = vi.fn<typeof fetch>(async (input) =>
        String(input) === NOVA_READINESS_URLS.nova ? failure.response() : Response.json({ status: "ok" })
      );
      const app = buildApp(async () => undefined, requestFetch);
      const ready = await app.inject({ method: "GET", url: "/ready" });

      expect(ready.statusCode, failure.name).toBe(503);
      expect(ready.json().dependencies, failure.name).toContainEqual({
        name: "nova-core",
        status: "down",
        required: true
      });
      expect(ready.body, failure.name).not.toMatch(/https?:\/\/|edge-token|operator-assertion-key/i);
    }
  });

  it("limits invalid login bodies by observed IP and normalized accounts without trusting proxy headers", async () => {
    const resolvePrincipal = vi.fn(async () => undefined);
    const requestFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { error: "Invalid credentials" } }, { status: 401 })
    );
    const app = buildApp(resolvePrincipal, requestFetch);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/auth/login",
        remoteAddress: "198.51.100.10",
        headers: { "x-requested-with": "nova-console", "x-forwarded-for": `203.0.113.${attempt + 1}` },
        payload: {}
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.10",
      headers: { "x-requested-with": "nova-console", "x-forwarded-for": "203.0.113.200" },
      payload: {}
    });
    const isolated = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.11",
      headers: { "x-requested-with": "nova-console", "x-forwarded-for": "203.0.113.200" },
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
        headers: { "x-requested-with": "nova-console" },
        payload: {
          email: attempt % 2 === 0 ? " Victim@Example.COM " : "victim@example.com",
          password: "invalid-password"
        }
      });
      expect(response.statusCode).toBe(401);
    }
    const distributedBlocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.210",
      headers: { "x-requested-with": "nova-console" },
      payload: { email: "victim@example.com", password: "invalid-password" }
    });
    const neighborAccount = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.210",
      headers: { "x-requested-with": "nova-console" },
      payload: { email: "neighbor@example.com", password: "invalid-password" }
    });
    expect(distributedBlocked.statusCode).toBe(429);
    expect(neighborAccount.statusCode).toBe(401);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(requestFetch).toHaveBeenCalledTimes(22);
  });

  it("returns 404 for a route owned by another product before resolving a session", async () => {
    const resolvePrincipal = vi.fn(async () => principal([{ productId: "NOVA", capabilities: ["nova:read"] }]));
    const requestFetch = vi.fn();
    const app = buildApp(resolvePrincipal, requestFetch);

    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/other/records`,
      headers: { authorization: bearer }
    });

    expect(response.statusCode).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("registers only the reviewed NOVA method, route, capability and role policies", async () => {
    expect(NOVA_BFF_TENANT_ROUTE_POLICIES).toHaveLength(52);
    const routeKeys = NOVA_BFF_TENANT_ROUTE_POLICIES.map((policy) => `${policy.method} ${policy.path}`);
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
    expect(NOVA_BFF_TENANT_ROUTE_POLICIES.every((policy) => !policy.path.includes("*"))).toBe(true);
    expect(
      NOVA_BFF_TENANT_ROUTE_POLICIES.every(
        (policy) => policy.method.length > 0 && policy.path.startsWith("/v1/tenants/") && policy.capability.length > 0
      )
    ).toBe(true);
    expect(
      NOVA_BFF_TENANT_ROUTE_POLICIES.find(
        (policy) => policy.method === "POST" && policy.path.endsWith("/nova/reviews/:reviewId/decide")
      )
    ).toMatchObject({ capability: "nova:write", roles: ["admin", "supervisor"] });
    expect(
      NOVA_BFF_TENANT_ROUTE_POLICIES.find(
        (policy) => policy.method === "POST" && policy.path.endsWith("/nova/contacts/:contactId/calls")
      )
    ).toMatchObject({ capability: "nova:write", roles: ["admin", "supervisor"] });
    expect(
      NOVA_BFF_TENANT_ROUTE_POLICIES.some(
        (policy) =>
          policy.method === "POST" &&
          policy.component === "voice" &&
          (policy.path.endsWith("/voice/calls") || policy.path.includes("/voice/campaigns"))
      )
    ).toBe(false);
    expect(
      NOVA_BFF_TENANT_ROUTE_POLICIES.find(
        (policy) => policy.method === "POST" && policy.path.endsWith("/nova/lab/liwa-event")
      )
    ).toMatchObject({ capability: "nova:write", roles: ["admin", "supervisor"] });
    expect(
      NOVA_BFF_TENANT_ROUTE_POLICIES.find(
        (policy) => policy.method === "GET" && policy.path.endsWith("/nova/dashboard")
      )
    ).toMatchObject({ capability: "nova:read", roles: ["admin", "supervisor", "asesor"] });
    for (const suffix of ["/nova/reviews", "/nova/analytics/daily"]) {
      expect(
        NOVA_BFF_TENANT_ROUTE_POLICIES.find((policy) => policy.method === "GET" && policy.path.endsWith(suffix))
      ).toMatchObject({ capability: "nova:read", roles: ["admin", "supervisor"] });
    }

    const app = buildApp(async () => undefined, vi.fn());
    await app.ready();
    for (const policy of NOVA_BFF_TENANT_ROUTE_POLICIES) {
      expect(app.hasRoute({ method: policy.method, url: policy.path })).toBe(true);
    }
    for (const policy of Object.values(NOVA_BFF_PUBLIC_ROUTE_POLICIES)) {
      expect(app.hasRoute({ method: policy.method, url: policy.path })).toBe(true);
    }
  });

  it("rejects unlisted NOVA method and route pairs before resolving a session", async () => {
    const resolvePrincipal = vi.fn(async () =>
      principal([{ productId: "NOVA", capabilities: ["nova:read", "nova:write"] }])
    );
    const requestFetch = vi.fn<typeof fetch>(async () => Response.json({ data: { unexpectedlyExposed: true } }));
    const app = buildApp(resolvePrincipal, requestFetch);
    const futureRoute = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/nova/future-provider-export`,
      headers: { cookie: sessionCookies }
    });
    const wrongMethod = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${tenantId}/nova/contacts`,
      headers: { cookie: sessionCookies }
    });
    expect(futureRoute.statusCode).toBe(404);
    expect(wrongMethod.statusCode).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("preserves the signed raw body and only forwards allowlisted Dialer headers", async () => {
    const secret = "dialer-provider-webhook-secret-0001";
    const rawBody = '{  "event_id": "dialer-event-1", "status": "completed"  }\n';
    const signature = createHmac("sha256", secret).update(rawBody).digest("hex");
    const requestFetch = vi.fn<typeof fetch>(async (input, init) => {
      const headers = new Headers(init?.headers);
      const forwardedBody = Buffer.from(init?.body as Uint8Array).toString("utf8");
      expect(String(input)).toBe("http://voice.test/v1/voice/webhooks/dialer");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(forwardedBody).toBe(rawBody);
      expect(createHmac("sha256", secret).update(forwardedBody).digest("hex")).toBe(signature);
      expect(headers.get("x-dialer-signature")).toBe(signature);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-hyperion-caller")).toBeNull();
      expect(headers.get("x-operator-id")).toBeNull();
      expect(headers.get("x-untrusted-provider-header")).toBeNull();
      expect(headers.get(PROVIDER_EDGE_TOKEN_HEADER)).toBeNull();
      expect(headers.get(PROVIDER_CLIENT_IP_HEADER)).toBeNull();
      return Response.json({ data: { accepted: true, signature_valid: true } });
    });
    const app = buildApp(
      vi.fn(async () => undefined),
      requestFetch
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/voice/webhooks/dialer",
      headers: {
        ...providerEdgeHeaders(),
        "content-type": "application/json",
        "x-dialer-signature": signature,
        authorization: bearer,
        cookie: sessionCookies,
        "x-operator-id": "forged-operator",
        "x-untrusted-provider-header": "must-not-cross"
      },
      payload: rawBody
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.signature_valid).toBe(true);
  });

  it("fails closed when a NOVA provider callback upstream returns active content", async () => {
    const requestFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return new Response("<script>provider-html-marker</script>", {
        status: 200,
        headers: {
          "content-type": "text/html",
          location: "https://evil.example/",
          "set-cookie": "evil=1"
        }
      });
    });
    const app = buildApp(
      vi.fn(async () => undefined),
      requestFetch
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/liwa/webhooks",
      headers: {
        ...providerEdgeHeaders(),
        "content-type": "application/json",
        "x-liwa-webhook-secret": "provider-secret"
      },
      payload: { event: "message.received" }
    });

    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("provider-html-marker");
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("passes LIWA authentication failures through without exposing its simulation route", async () => {
    const expectedSecret = "liwa-provider-webhook-secret-0001";
    const requestFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const received = new Headers(init?.headers).get("x-liwa-webhook-secret");
      return received === expectedSecret
        ? Response.json({ data: { accepted: true } })
        : Response.json({ data: { error: "Invalid webhook secret" } }, { status: 401 });
    });
    const app = buildApp(
      vi.fn(async () => undefined),
      requestFetch
    );

    const rejected = await app.inject({
      method: "POST",
      url: "/v1/liwa/webhooks",
      headers: {
        ...providerEdgeHeaders(),
        "content-type": "application/json",
        "x-liwa-webhook-secret": "wrong-secret"
      },
      payload: { event: "message.received" }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/liwa/webhooks",
      headers: {
        ...providerEdgeHeaders(),
        "content-type": "application/json",
        "x-liwa-webhook-secret": expectedSecret
      },
      payload: { event: "message.received" }
    });
    const simulation = await app.inject({
      method: "POST",
      url: "/v1/liwa/webhooks/simulate",
      headers: { "content-type": "application/json", "x-liwa-webhook-secret": expectedSecret },
      payload: { event: "message.received" }
    });
    const probe = await app.inject({ method: "GET", url: "/v1/liwa/webhooks" });
    const querySecret = await app.inject({
      method: "POST",
      url: "/v1/liwa/webhooks?secret=must-never-be-accepted",
      headers: { "content-type": "application/json", "x-liwa-webhook-secret": expectedSecret },
      payload: { event: "message.received" }
    });

    expect(rejected.statusCode).toBe(401);
    expect(accepted.statusCode).toBe(200);
    expect(simulation.statusCode).toBe(404);
    expect(probe.statusCode).toBe(404);
    expect(querySecret.statusCode).toBe(404);
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });

  it("requires the authenticated edge identity and rate limits each sanitized provider source independently", async () => {
    const expectedSecret = "liwa-provider-webhook-secret-0001";
    const requestFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const received = new Headers(init?.headers).get("x-liwa-webhook-secret");
      return received === expectedSecret
        ? Response.json({ data: { accepted: true } })
        : Response.json({ data: { error: "Invalid webhook secret" } }, { status: 401 });
    });
    const app = buildApp(
      vi.fn(async () => undefined),
      requestFetch
    );
    const inject = (clientIp: string, secret: string, edgeCredential = providerEdgeCredential) =>
      app.inject({
        method: "POST",
        url: "/v1/liwa/webhooks",
        headers: {
          ...providerEdgeHeaders(clientIp, edgeCredential),
          "content-type": "application/json",
          "x-liwa-webhook-secret": secret
        },
        payload: { event: "message.received" }
      });

    const forgedEdge = await inject("198.51.100.10", expectedSecret, "forged-provider-edge-credential-0001");
    expect(forgedEdge.statusCode).toBe(403);
    const invalidEdgeSource = await inject("not-an-ip", expectedSecret);
    expect(invalidEdgeSource.statusCode).toBe(403);
    expect(requestFetch).not.toHaveBeenCalled();

    for (let attempt = 0; attempt < PROVIDER_WEBHOOK_RATE_LIMIT_MAX; attempt += 1) {
      const rejected = await inject("198.51.100.10", "wrong-secret");
      expect(rejected.statusCode).toBe(401);
    }

    const blockedLegitimateProvider = await inject("198.51.100.10", expectedSecret);
    expect(blockedLegitimateProvider.statusCode).toBe(429);
    expect(blockedLegitimateProvider.headers["retry-after"]).toBeDefined();

    const isolatedProvider = await inject("198.51.100.11", expectedSecret);
    expect(isolatedProvider.statusCode).toBe(200);
    expect(requestFetch).toHaveBeenCalledTimes(PROVIDER_WEBHOOK_RATE_LIMIT_MAX + 1);
  });

  it("returns 403 when the principal has no NOVA grant for the tenant", async () => {
    const resolvePrincipal = vi.fn(async () => principal([{ productId: "OTHER", capabilities: ["other:read"] }]));
    const requestFetch = vi.fn();
    const app = buildApp(resolvePrincipal, requestFetch);

    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/nova/contacts`,
      headers: { cookie: sessionCookies }
    });

    expect(response.statusCode).toBe(403);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("returns 403 when a read-only NOVA grant attempts a write", async () => {
    const requestFetch = vi.fn();
    const app = buildApp(async () => principal([{ productId: "NOVA", capabilities: ["nova:read"] }]), requestFetch);

    const response = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/campaigns`,
      headers: { cookie: sessionCookies, "x-csrf-token": csrfToken },
      payload: { name: "Campaign" }
    });

    expect(response.statusCode).toBe(403);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("enforces reviewed NOVA admin capabilities and product roles per route", async () => {
    const signedRoles: string[] = [];
    const requestFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      signedRoles.push(headers.get("x-operator-role") ?? "missing");
      expect(headers.get("x-hyperion-operator-assertion")).toContain(`|${signedRoles.at(-1)}|${tenantId}|NOVA|`);
      return Response.json({ data: { allowed: true } });
    });
    const mutationHeaders = { cookie: sessionCookies, "x-csrf-token": csrfToken };

    const supervisor = buildApp(
      async () =>
        principal([{ productId: "NOVA", roles: ["asesor", "supervisor"], capabilities: ["nova:read", "nova:write"] }]),
      requestFetch
    );
    const deniedBootstrap = await supervisor.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/bootstrap`,
      headers: mutationHeaders,
      payload: {}
    });
    const allowedReview = await supervisor.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/reviews/33333333-3333-4333-8333-333333333333/decide`,
      headers: mutationHeaders,
      payload: { decision: "skip" }
    });
    const allowedLab = await supervisor.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/lab/liwa-event`,
      headers: mutationHeaders,
      payload: { event: "message.received" }
    });
    expect(deniedBootstrap.statusCode).toBe(403);
    expect(allowedReview.statusCode).toBe(200);
    expect(allowedLab.statusCode).toBe(200);

    const advisor = buildApp(
      async () => principal([{ productId: "NOVA", roles: ["asesor"], capabilities: ["nova:write"] }]),
      requestFetch
    );
    const deniedReview = await advisor.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/reviews/33333333-3333-4333-8333-333333333333/decide`,
      headers: mutationHeaders,
      payload: { decision: "approve" }
    });
    expect(deniedReview.statusCode).toBe(403);

    const admin = buildApp(
      async () => principal([{ productId: "NOVA", roles: ["admin"], capabilities: ["nova:admin"] }]),
      requestFetch
    );
    const allowedBootstrap = await admin.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/bootstrap`,
      headers: mutationHeaders,
      payload: {}
    });
    expect(allowedBootstrap.statusCode).toBe(200);
    expect(requestFetch).toHaveBeenCalledTimes(3);
    expect(signedRoles).toEqual(["supervisor", "supervisor", "admin"]);
  });

  it("enforces the dashboard, review and analytics role matrix for every NOVA product role", async () => {
    const matrix = [
      { method: "GET", suffix: "dashboard", allowed: ["admin", "supervisor", "asesor"] },
      { method: "GET", suffix: "reviews", allowed: ["admin", "supervisor"] },
      { method: "GET", suffix: "analytics/daily", allowed: ["admin", "supervisor"] },
      {
        method: "POST",
        suffix: "reviews",
        payload: { contact_id: "44444444-4444-4444-8444-444444444444" },
        allowed: ["admin", "supervisor"]
      },
      {
        method: "POST",
        suffix: "reviews/33333333-3333-4333-8333-333333333333/decide",
        payload: { decision: "skip" },
        allowed: ["admin", "supervisor"]
      }
    ] as const;
    const roles = ["admin", "supervisor", "asesor"] as const;

    for (const role of roles) {
      const requestFetch = vi.fn<typeof fetch>(async (input, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-operator-role")).toBe(role);
        expect(headers.get("x-hyperion-operator-assertion")).toContain(`|${role}|${tenantId}|NOVA|`);
        expect(String(input)).toMatch(new RegExp(`^http://nova-core\\.test/v1/tenants/${tenantId}/nova/`));
        return Response.json({ data: [] });
      });
      const app = buildApp(
        async () =>
          principal([
            {
              productId: "NOVA",
              roles: [role],
              capabilities: ["nova:read", "nova:write", "nova:admin"]
            }
          ]),
        requestFetch
      );

      for (const route of matrix) {
        const callsBefore = requestFetch.mock.calls.length;
        const response = await app.inject({
          method: route.method,
          url: `/v1/tenants/${tenantId}/nova/${route.suffix}`,
          headers:
            route.method === "GET" ? { cookie: sessionCookies } : { cookie: sessionCookies, "x-csrf-token": csrfToken },
          ...(route.method === "POST" ? { payload: route.payload } : {})
        });
        const allowed = route.allowed.some((candidate) => candidate === role);
        expect(response.statusCode, `${role} ${route.method} ${route.suffix}`).toBe(allowed ? 200 : 403);
        expect(requestFetch.mock.calls.length, `${role} upstream calls after ${route.method} ${route.suffix}`).toBe(
          callsBefore + (allowed ? 1 : 0)
        );
      }
    }
  });

  it("proxies an allowed route with NOVA workload identity and product-bound assertion", async () => {
    const requestFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-hyperion-caller")).toBe("nova-bff");
      expect(headers.get("authorization")).toBe("Bearer core-edge-token");
      expect(headers.get("x-hyperion-operator-assertion")).toContain(`|${tenantId}|NOVA|`);
      return new Response(JSON.stringify({ data: [{ id: "contact-1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const app = buildApp(
      async () => principal([{ productId: "NOVA", capabilities: ["nova:read", "nova:write"] }]),
      requestFetch
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/nova/contacts?limit=25`,
      headers: { cookie: sessionCookies }
    });

    expect(response.statusCode).toBe(200);
    expect(requestFetch.mock.calls[0]?.[0]).toBe(`http://nova-core.test/v1/tenants/${tenantId}/nova/contacts?limit=25`);
  });

  it("fails closed on unsafe upstream representations and only forwards valid JSON", async () => {
    const upstreamResponses = [
      new Response("<script>nova-html-marker</script>", {
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
      new Response(JSON.stringify("nova-scalar-marker"), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      new Response("nova-invalid-json-marker", {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" }
      })
    ];
    const requestFetch = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      const response = upstreamResponses.shift();
      if (!response) throw new Error("Unexpected upstream request");
      return response;
    });
    const app = buildApp(async () => principal([{ productId: "NOVA", capabilities: ["nova:read"] }]), requestFetch);
    const inject = () =>
      app.inject({
        method: "GET",
        url: `/v1/tenants/${tenantId}/nova/contacts`,
        headers: { cookie: sessionCookies }
      });

    const html = await inject();
    expect(html.statusCode).toBe(502);
    expect(html.body).not.toContain("nova-html-marker");
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
    expect(scalar.body).toBe(JSON.stringify("nova-scalar-marker"));
    expect(scalar.json()).toBe("nova-scalar-marker");

    const invalidJson = await inject();
    expect(invalidJson.statusCode).toBe(502);
    expect(invalidJson.body).not.toContain("nova-invalid-json-marker");
    expect(requestFetch).toHaveBeenCalledTimes(7);
  });

  it("does not auto-expose HEAD for an allowed NOVA GET route", async () => {
    const requestFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    const app = buildApp(async () => principal([{ productId: "NOVA", capabilities: ["nova:read"] }]), requestFetch);

    const response = await app.inject({
      method: "HEAD",
      url: `/v1/tenants/${tenantId}/nova/contacts`,
      headers: { cookie: sessionCookies }
    });

    expect(response.statusCode).toBe(404);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("cancels NOVA JSON responses that exceed the byte limit before or during streaming", async () => {
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
    const requestFetch = vi.fn<typeof fetch>(async () => {
      const response = upstreamResponses.shift();
      if (!response) throw new Error("Unexpected upstream request");
      return response;
    });
    const app = buildApp(async () => principal([{ productId: "NOVA", capabilities: ["nova:read"] }]), requestFetch);
    const inject = () =>
      app.inject({
        method: "GET",
        url: `/v1/tenants/${tenantId}/nova/contacts`,
        headers: { cookie: sessionCookies }
      });

    const declared = await inject();
    expect(declared.statusCode).toBe(502);
    expect(declared.body).not.toContain("declared-oversize");
    const streamed = await inject();
    expect(streamed.statusCode).toBe(502);
    expect(streamed.body).not.toContain("streamed-oversize-marker");
    expect(cancellations).toEqual(["declared", "streamed"]);
    expect(requestFetch).toHaveBeenCalledTimes(2);
  });

  it("never accepts a browser bearer token in place of the isolated NOVA cookie", async () => {
    const resolvePrincipal = vi.fn(async () => principal([{ productId: "NOVA", capabilities: ["nova:read"] }]));
    const requestFetch = vi.fn();
    const app = buildApp(resolvePrincipal, requestFetch);

    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/nova/contacts`,
      headers: { authorization: bearer }
    });

    expect(response.statusCode).toBe(401);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("sets a host-only HttpOnly session cookie and never exposes the Access token in JSON", async () => {
    const nowMs = 1_900_000_000_000;
    const accessToken = createFakeJwt(Math.floor(nowMs / 1000) + 300);
    const requestFetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("http://access.test/v1/access/token");
      return new Response(
        JSON.stringify({
          data: { accessToken, tokenType: "Bearer", expiresAt: new Date(nowMs + 300_000).toISOString() }
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const app = buildApp(
      async (token) =>
        token === accessToken ? principal([{ productId: "NOVA", capabilities: ["nova:read"] }]) : undefined,
      requestFetch,
      nowMs
    );

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-requested-with": "nova-console" },
      payload: { email: "operator@example.com", password: "valid-password" }
    });

    expect(response.statusCode).toBe(201);
    const cookies = response.headers["set-cookie"] as string[];
    const sessionCookie = cookies.find((cookie) => cookie.startsWith(`${NOVA_SESSION_COOKIE}=`));
    const csrfCookie = cookies.find((cookie) => cookie.startsWith(`${NOVA_CSRF_COOKIE}=`));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Strict");
    expect(sessionCookie).toContain("Path=/");
    expect(sessionCookie).not.toContain("Domain=");
    expect(csrfCookie).not.toContain("HttpOnly");
    expect(response.body).not.toContain(accessToken);
  });

  it("projects only NOVA grants from a mixed principal at login without mutating the resolved principal", async () => {
    const nowMs = 1_900_000_000_000;
    const accessToken = createFakeJwt(Math.floor(nowMs / 1000) + 300);
    const mixedPrincipal = principal([
      { productId: "NOVA", roles: ["asesor"], capabilities: ["nova:read"] },
      { productId: "NOVA", roles: ["supervisor"], capabilities: ["nova:write"], active: false },
      { productId: "LUMEN", roles: ["clinician"], capabilities: ["lumen:read"] }
    ]);
    const originalGrants = mixedPrincipal.grants;
    const originalPrincipal = JSON.stringify(mixedPrincipal);
    const requestFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { accessToken, tokenType: "Bearer" } }, { status: 201 })
    );
    const app = buildApp(async (token) => (token === accessToken ? mixedPrincipal : undefined), requestFetch, nowMs);

    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-requested-with": "nova-console" },
      payload: { email: "operator@example.com", password: "valid-password" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.principal.grants).toMatchObject([
      { tenantId, productId: "NOVA", roles: ["asesor"], capabilities: ["nova:read"] }
    ]);
    expect(response.json().data.principal.grants).toHaveLength(1);
    expect(response.body).not.toContain("LUMEN");
    expect(mixedPrincipal.grants).toBe(originalGrants);
    expect(JSON.stringify(mixedPrincipal)).toBe(originalPrincipal);
  });

  it("projects only NOVA grants from a mixed principal at /v1/auth/me without mutating the resolved principal", async () => {
    const mixedPrincipal = principal([
      { productId: "NOVA", roles: ["supervisor"], capabilities: ["nova:read", "nova:write"] },
      { productId: "PULSO_IRIS", roles: ["advisor"], capabilities: ["pulso:read"] }
    ]);
    const originalGrants = mixedPrincipal.grants;
    const originalPrincipal = JSON.stringify(mixedPrincipal);
    const app = buildApp(async (token) => (token === sessionToken ? mixedPrincipal : undefined), vi.fn());

    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: `${NOVA_SESSION_COOKIE}=${sessionToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.grants).toMatchObject([
      {
        tenantId,
        productId: "NOVA",
        roles: ["supervisor"],
        capabilities: ["nova:read", "nova:write"]
      }
    ]);
    expect(response.json().data.grants).toHaveLength(1);
    expect(response.body).not.toContain("PULSO_IRIS");
    expect(mixedPrincipal.grants).toBe(originalGrants);
    expect(JSON.stringify(mixedPrincipal)).toBe(originalPrincipal);
  });

  it("rejects an oversized session before emitting any Set-Cookie header", async () => {
    const oversizedToken = `header.payload.${"x".repeat(4050)}`;
    const requestFetch = vi.fn<typeof fetch>(async () =>
      Response.json(
        { data: { token: oversizedToken, accessToken: oversizedToken, tokenType: "Bearer" } },
        { status: 201 }
      )
    );
    const app = buildApp(
      async (token) =>
        token === oversizedToken ? principal([{ productId: "NOVA", capabilities: ["nova:read"] }]) : undefined,
      requestFetch
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-requested-with": "nova-console" },
      payload: { email: "oversized@example.com", password: "valid-password" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(oversizedToken);
  });

  it("requires a matching double-submit CSRF token for product writes", async () => {
    const requestFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { created: true } }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
    );
    const app = buildApp(
      async () => principal([{ productId: "NOVA", roles: ["supervisor"], capabilities: ["nova:write"] }]),
      requestFetch
    );
    const withoutCsrf = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/campaigns`,
      headers: { cookie: sessionCookies },
      payload: { name: "Campaign" }
    });
    const withCsrf = await app.inject({
      method: "POST",
      url: `/v1/tenants/${tenantId}/nova/campaigns`,
      headers: { cookie: sessionCookies, "x-csrf-token": csrfToken },
      payload: { name: "Campaign" }
    });

    expect(withoutCsrf.statusCode).toBe(403);
    expect(withCsrf.statusCode).toBe(201);
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });
});

function buildApp(
  resolvePrincipal: (token: string) => Promise<AccessPrincipal | undefined>,
  requestFetch: typeof fetch,
  nowMs = 1_900_000_000_000,
  overrides: Partial<NovaBffOptions> = {}
) {
  const app = createNovaBff({
    resolvePrincipal,
    accessKeyReadiness: async () => true,
    accessUrl: "http://access.test",
    accessCredential: "nova-bff-to-access-token",
    upstreams: {
      nova: "http://nova-core.test",
      voice: "http://voice.test",
      liwa: "http://liwa.test",
      documents: "http://documents.test"
    },
    credentials: {
      nova: "core-edge-token",
      voice: "voice-edge-token",
      liwa: "liwa-edge-token",
      documents: "documents-edge-token"
    },
    operatorAssertionKey: assertionKey,
    providerEdgeCredential,
    fetch: requestFetch,
    now: () => nowMs,
    ...overrides
  });
  apps.push(app);
  return app;
}

function providerEdgeHeaders(clientIp = "198.51.100.10", credential = providerEdgeCredential) {
  return {
    [PROVIDER_EDGE_TOKEN_HEADER]: credential,
    [PROVIDER_CLIENT_IP_HEADER]: clientIp
  };
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

function createFakeJwt(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "test" })}.${encode({ exp })}.signature`;
}

function principal(
  grants: Array<{ productId: string; capabilities: string[]; roles?: string[]; active?: boolean }>
): AccessPrincipal {
  return accessPrincipalSchema.parse({
    operator: {
      id: "22222222-2222-4222-8222-222222222222",
      email: "operator@example.com",
      displayName: "Operator",
      role: "advisor"
    },
    grants: grants.map((grant) => ({
      tenantId,
      productId: grant.productId,
      roles: grant.roles ?? [grant.productId === "NOVA" ? "asesor" : "clinician"],
      capabilities: grant.capabilities,
      active: grant.active ?? true
    }))
  });
}
