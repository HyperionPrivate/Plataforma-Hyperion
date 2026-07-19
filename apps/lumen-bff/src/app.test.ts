import { accessPrincipalSchema, type AccessPrincipal } from "@hyperion/platform-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLumenBff,
  LUMEN_BFF_PUBLIC_ROUTE_POLICIES,
  LUMEN_BFF_READINESS_PROBE_TIMEOUT_MS,
  LUMEN_BFF_TENANT_ROUTE_POLICIES,
  LUMEN_CSRF_COOKIE,
  LUMEN_SESSION_COOKIE,
  UPSTREAM_JSON_BODY_LIMIT_BYTES,
  type LumenBffOptions
} from "./app.js";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ID = "22222222-2222-4222-8222-222222222222";
const ENCOUNTER_ID = "33333333-3333-4333-8333-333333333333";
const SESSION = "header.payload.signature-lumen-session";
const ASSERTION_KEY = "lumen-operator-assertion-key-0001";
const ACCESS_READY_URL = "http://access.test/ready";
const LUMEN_READY_URL = "http://lumen.test/ready";

describe("LUMEN BFF boundary", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports ready only with usable signing keys, configuration and the LUMEN upstream", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const url = String(input);
      if (url === ACCESS_READY_URL || url === LUMEN_READY_URL) return Response.json({ status: "ok" });
      return new Response(null, { status: 404 });
    });
    const app = createApp({ fetch: request, accessKeyReadiness: async () => true });

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(LUMEN_BFF_READINESS_PROBE_TIMEOUT_MS).toBe(3_000);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: "lumen-bff",
      product: "LUMEN",
      status: "ok",
      dependencies: [
        { name: "access-signing-keys", status: "ok", required: true },
        { name: "access-token-minting", status: "ok", required: false },
        { name: "lumen", status: "ok", required: true }
      ]
    });
    expect(request.mock.calls.map(([input]) => String(input)).sort()).toEqual(
      [ACCESS_READY_URL, LUMEN_READY_URL].sort()
    );
    await app.close();
  });

  it("keeps liveness up but readiness down when workload configuration or signing keys are unavailable", async () => {
    for (const overrides of [
      { accessCredential: undefined },
      { credential: undefined },
      { operatorAssertionKey: undefined }
    ] satisfies Array<Partial<LumenBffOptions>>) {
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
    expect(ready.json()).toMatchObject({
      status: "ok",
      dependencies: [
        { name: "access-signing-keys", status: "ok", required: true },
        { name: "access-token-minting", status: "degraded", required: false },
        { name: "lumen", status: "ok", required: true }
      ]
    });
    await app.close();
  });

  it("fails closed for every unsafe LUMEN readiness response without leaking dependency details", async () => {
    const failures: Array<{ name: string; response: () => Promise<Response> }> = [
      { name: "http-error", response: async () => Response.json({ status: "down" }, { status: 503 }) },
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
      const request = vi.fn<typeof fetch>(async (input) =>
        String(input) === LUMEN_READY_URL ? failure.response() : Response.json({ status: "ok" })
      );
      const app = createApp({ fetch: request, accessKeyReadiness: async () => true });
      const ready = await app.inject({ method: "GET", url: "/ready" });
      expect(ready.statusCode, failure.name).toBe(503);
      expect(ready.json().dependencies, failure.name).toContainEqual({
        name: "lumen",
        status: "down",
        required: true
      });
      expect(ready.body, failure.name).not.toMatch(/https?:\/\/|lumen-edge-token|operator-assertion-key/i);
      await app.close();
    }
  });

  it("reports unsafe Access readiness as optional degradation, never as trusted JSON", async () => {
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
        remoteAddress: "198.51.100.20",
        headers: { "x-requested-with": "lumen-console", "x-forwarded-for": `203.0.113.${attempt + 1}` },
        payload: {}
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.20",
      headers: { "x-requested-with": "lumen-console", "x-forwarded-for": "203.0.113.200" },
      payload: {}
    });
    const isolated = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.21",
      headers: { "x-requested-with": "lumen-console", "x-forwarded-for": "203.0.113.200" },
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
        headers: { "x-requested-with": "lumen-console" },
        payload: {
          email: attempt % 2 === 0 ? " Clinician@Example.COM " : "clinician@example.com",
          password: "invalid-password"
        }
      });
      expect(response.statusCode).toBe(401);
    }
    const distributedBlocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.220",
      headers: { "x-requested-with": "lumen-console" },
      payload: { email: "clinician@example.com", password: "invalid-password" }
    });
    const neighborAccount = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.220",
      headers: { "x-requested-with": "lumen-console" },
      payload: { email: "neighbor@example.com", password: "invalid-password" }
    });
    expect(distributedBlocked.statusCode).toBe(429);
    expect(neighborAccount.statusCode).toBe(401);
    expect(request).toHaveBeenCalledTimes(22);
    await app.close();
  });

  it("exposes the exact cell-local LUMEN health route through its dedicated workload identity", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://lumen.test/v1/lumen/health");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer lumen-edge-token");
      expect(headers.get("x-hyperion-caller")).toBe("lumen-bff");
      expect(init?.redirect).toBe("error");
      return Response.json({ data: { service: "lumen-service", product: "LUMEN", status: "ok" } });
    });
    const app = createApp({ fetch: request });
    const response = await app.inject({ method: "GET", url: "/v1/lumen/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ service: "lumen-service", product: "LUMEN", status: "ok" });
    await app.close();
  });

  it("returns 404 for another product namespace before any upstream call", async () => {
    const request = vi.fn<typeof fetch>();
    const app = createApp({ fetch: request });
    const response = await app.inject({ method: "GET", url: `/v1/tenants/${TENANT_ID}/nova/overview` });
    expect(response.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it("defines and registers only the reviewed LUMEN method and route pairs", async () => {
    expect(LUMEN_BFF_TENANT_ROUTE_POLICIES).toEqual([
      {
        method: "GET",
        path: "/v1/tenants/:tenantId/lumen/worklist",
        upstream: "lumen",
        capability: "lumen:read"
      },
      {
        method: "GET",
        path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId",
        upstream: "lumen",
        capability: "lumen:read"
      },
      {
        method: "POST",
        path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/start",
        upstream: "lumen",
        capability: "lumen:write"
      },
      {
        method: "POST",
        path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/transcriptions",
        upstream: "lumen",
        capability: "lumen:write"
      },
      {
        method: "POST",
        path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/structure",
        upstream: "lumen",
        capability: "lumen:write"
      },
      {
        method: "PATCH",
        path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/record",
        upstream: "lumen",
        capability: "lumen:write"
      },
      {
        method: "POST",
        path: "/v1/tenants/:tenantId/lumen/encounters/:encounterId/approve",
        upstream: "lumen",
        capability: "lumen:write"
      }
    ]);
    const app = createApp();
    await app.ready();
    for (const policy of LUMEN_BFF_TENANT_ROUTE_POLICIES) {
      expect(app.hasRoute({ method: policy.method, url: policy.path })).toBe(true);
    }
    for (const policy of Object.values(LUMEN_BFF_PUBLIC_ROUTE_POLICIES)) {
      expect(app.hasRoute({ method: policy.method, url: policy.path })).toBe(true);
    }
    await app.close();
  });

  it("rejects unlisted LUMEN routes and methods before any upstream call", async () => {
    const request = vi.fn<typeof fetch>();
    const app = createApp({ fetch: request });
    const unknownRoute = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/lumen/encounters`
    });
    const unknownMethod = await app.inject({
      method: "DELETE",
      url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}`
    });
    expect(unknownRoute.statusCode).toBe(404);
    expect(unknownMethod.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires a cookie session and an active tenant x product grant", async () => {
    const app = createApp();
    const unauthenticated = await app.inject({ method: "GET", url: `/v1/tenants/${TENANT_ID}/lumen/worklist` });
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();

    const wrongProduct = createApp({
      resolvePrincipal: async () => principal([{ productId: "NOVA", roles: ["admin"], capabilities: ["nova:read"] }])
    });
    const forbidden = await wrongProduct.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/lumen/worklist`,
      headers: { cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}` }
    });
    expect(forbidden.statusCode).toBe(403);
    await wrongProduct.close();
  });

  it("proxies only with the LUMEN workload credential and product-bound assertion", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`http://lumen.test/v1/tenants/${TENANT_ID}/lumen/worklist?day=today`);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer lumen-edge-token");
      expect(headers.get("x-hyperion-caller")).toBe("lumen-bff");
      expect(headers.get("x-operator-id")).toBe(OPERATOR_ID);
      expect(headers.get("x-operator-role")).toBe("advisor");
      expect(headers.get("x-hyperion-operator-assertion")).toMatch(
        new RegExp(`^${OPERATOR_ID}\\|advisor\\|${TENANT_ID}\\|LUMEN\\|`)
      );
      expect(init?.redirect).toBe("error");
      return Response.json({ data: [{ id: "encounter-1" }] });
    });
    const app = createApp({ fetch: request });
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${TENANT_ID}/lumen/worklist?day=today`,
      headers: { cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [{ id: "encounter-1" }] });
    await app.close();
  });

  it("fails closed on unsafe upstream representations and only forwards valid JSON", async () => {
    const upstreamResponses = [
      new Response("<script>lumen-html-marker</script>", {
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
      new Response(JSON.stringify("lumen-scalar-marker"), {
        status: 200,
        headers: { "content-type": "application/json" }
      }),
      new Response("lumen-invalid-json-marker", {
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
        url: `/v1/tenants/${TENANT_ID}/lumen/worklist`,
        headers: { cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}` }
      });

    const html = await inject();
    expect(html.statusCode).toBe(502);
    expect(html.body).not.toContain("lumen-html-marker");
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
    expect(scalar.body).toBe(JSON.stringify("lumen-scalar-marker"));
    expect(scalar.json()).toBe("lumen-scalar-marker");

    const invalidJson = await inject();
    expect(invalidJson.statusCode).toBe(502);
    expect(invalidJson.body).not.toContain("lumen-invalid-json-marker");
    expect(request).toHaveBeenCalledTimes(7);
    await app.close();
  });

  it("does not auto-expose HEAD for an allowed LUMEN GET route", async () => {
    const request = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    const app = createApp({ fetch: request });
    const response = await app.inject({
      method: "HEAD",
      url: `/v1/tenants/${TENANT_ID}/lumen/worklist`,
      headers: { cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}` }
    });
    expect(response.statusCode).toBe(404);
    expect(request).not.toHaveBeenCalled();
    await app.close();
  });

  it("cancels LUMEN JSON responses that exceed the byte limit before or during streaming", async () => {
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
        url: `/v1/tenants/${TENANT_ID}/lumen/worklist`,
        headers: { cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}` }
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

  it("requires write capability and a matching double-submit CSRF token", async () => {
    const readonly = createApp({
      resolvePrincipal: async () => principal([{ capabilities: ["lumen:read"] }])
    });
    const noCapability = await readonly.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}/start`,
      headers: {
        cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}; ${LUMEN_CSRF_COOKIE}=csrf-one`,
        "x-csrf-token": "csrf-one"
      },
      payload: {}
    });
    expect(noCapability.statusCode).toBe(403);
    await readonly.close();

    const app = createApp();
    const missingCsrf = await app.inject({
      method: "POST",
      url: `/v1/tenants/${TENANT_ID}/lumen/encounters/${ENCOUNTER_ID}/start`,
      headers: { cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}` },
      payload: {}
    });
    expect(missingCsrf.statusCode).toBe(403);
    await app.close();
  });

  it("creates a secure host-only session without returning the bearer to JavaScript", async () => {
    const nowMs = Date.parse("2026-07-17T12:00:00.000Z");
    const token = fakeJwt(Math.floor(nowMs / 1000) + 300);
    const access = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://access.test/v1/access/token");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer lumen-to-access-token");
      expect(headers.get("x-hyperion-caller")).toBe("lumen-bff");
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
      headers: { "x-requested-with": "lumen-console" },
      payload: { email: "clinician@example.test", password: "valid-password" }
    });
    expect(response.statusCode).toBe(201);
    const cookies = response.headers["set-cookie"];
    const serialized = Array.isArray(cookies) ? cookies.join("\n") : String(cookies);
    expect(serialized).toContain(`${LUMEN_SESSION_COOKIE}=`);
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
      headers: { "x-requested-with": "lumen-console" },
      payload: { email: "oversized@example.com", password: "valid-password" }
    });
    expect(response.statusCode).toBe(502);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(oversizedToken);
    await app.close();
  });

  it("lists only tenants granted for LUMEN and ignores an Authorization header", async () => {
    const app = createApp({
      resolvePrincipal: async (token) => (token === SESSION ? principal() : undefined)
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/tenants",
      headers: {
        authorization: "Bearer attacker-controlled-token",
        cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}`
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{ id: TENANT_ID, displayName: "Tenant 11111111" }]);
    await app.close();
  });

  it("projects one bearer-free console session with opaque tenants and the CSRF token", async () => {
    const app = createApp({
      resolvePrincipal: async () =>
        principal([{}, { productId: "NOVA", roles: ["admin"], capabilities: ["nova:admin"] }])
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: {
        cookie: `${LUMEN_SESSION_COOKIE}=${SESSION}; ${LUMEN_CSRF_COOKIE}=csrf-session-token`
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      operator: { id: OPERATOR_ID },
      tenants: [{ id: TENANT_ID, displayName: "Tenant 11111111" }],
      grants: [{ tenantId: TENANT_ID, productId: "LUMEN" }],
      csrfToken: "csrf-session-token"
    });
    expect(response.body).not.toContain(SESSION);
    expect(response.body).not.toContain("NOVA");
    expect(response.body).not.toContain('"slug"');
    await app.close();
  });
});

function createApp(overrides: Partial<LumenBffOptions> = {}) {
  return createLumenBff({
    resolvePrincipal: async (token) => (token === SESSION ? principal() : undefined),
    accessKeyReadiness: async () => true,
    accessUrl: "http://access.test",
    accessCredential: "lumen-to-access-token",
    upstream: "http://lumen.test",
    credential: "lumen-edge-token",
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
      email: "clinician@example.test",
      displayName: "Clinical Operator",
      role: "advisor"
    },
    grants: grants.map((grant) => ({
      tenantId: TENANT_ID,
      productId: grant.productId ?? "LUMEN",
      roles: grant.roles ?? ["advisor"],
      capabilities: grant.capabilities ?? ["lumen:read", "lumen:write"],
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
