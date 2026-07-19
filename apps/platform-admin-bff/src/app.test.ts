import { accessPrincipalSchema, platformControlTenantId, type AccessPrincipal } from "@hyperion/platform-contracts";
import { platformProductCatalogV1 } from "@hyperion/platform-contracts/product-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlatformAdminBff,
  PLATFORM_ADMIN_CSRF_COOKIE,
  PLATFORM_ADMIN_REQUEST_HEADER,
  PLATFORM_ADMIN_ROUTE_INVENTORY,
  PLATFORM_ADMIN_SESSION_COOKIE
} from "./app.js";

const tenantId = "11111111-1111-4111-8111-111111111111";
const operatorId = "22222222-2222-4222-8222-222222222222";
const sessionToken = "platform-admin-session-token-long-enough";
const csrfToken = "platform-admin-csrf-token-long-enough";
const cookies = `${PLATFORM_ADMIN_SESSION_COOKIE}=${sessionToken}; ${PLATFORM_ADMIN_CSRF_COOKIE}=${csrfToken}`;
const apps: ReturnType<typeof createPlatformAdminBff>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("platform admin BFF", () => {
  it("pins the complete neutral route inventory and contains no audit or product-domain surface", () => {
    expect(PLATFORM_ADMIN_ROUTE_INVENTORY).toEqual([
      { method: "GET", path: "/health", authorization: "public", owner: "local" },
      { method: "GET", path: "/ready", authorization: "public", owner: "local" },
      { method: "POST", path: "/v1/auth/login", authorization: "public", owner: "access" },
      { method: "GET", path: "/v1/auth/me", authorization: "session", owner: "local" },
      { method: "POST", path: "/v1/auth/logout", authorization: "session", owner: "local" },
      { method: "GET", path: "/v1/platform/catalog", authorization: "platform-admin", owner: "local" },
      { method: "GET", path: "/v1/identity/operators", authorization: "platform-admin", owner: "identity" },
      { method: "POST", path: "/v1/identity/operators", authorization: "platform-admin", owner: "identity" },
      {
        method: "PATCH",
        path: "/v1/identity/operators/:operatorId",
        authorization: "platform-admin",
        owner: "identity"
      },
      { method: "GET", path: "/v1/tenants", authorization: "platform-admin", owner: "tenant" },
      { method: "GET", path: "/v1/platform/grants", authorization: "platform-admin", owner: "identity" },
      {
        method: "PUT",
        path: "/v1/platform/grants/:operatorId/:tenantId/:productId",
        authorization: "platform-admin",
        owner: "identity"
      },
      {
        method: "DELETE",
        path: "/v1/platform/grants/:operatorId/:tenantId/:productId",
        authorization: "platform-admin",
        owner: "identity"
      }
    ]);
    expect(PLATFORM_ADMIN_ROUTE_INVENTORY.some((route) => /audit|nova|lumen|pulso/i.test(route.path))).toBe(false);
  });

  it("reports ready only when JWKS, Identity, Tenant and dedicated workload credentials are usable", async () => {
    const healthyFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [{ kid: "platform-key" }] });
      if (url.endsWith("/ready")) return Response.json({ status: "ok" });
      return new Response(null, { status: 404 });
    });
    const healthy = buildApp(async () => undefined, healthyFetch);
    const ready = await healthy.inject({ method: "GET", url: "/ready" });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: "ok",
      dependencies: [
        { name: "access-jwks", status: "ok" },
        { name: "identity", status: "ok" },
        { name: "tenant", status: "ok" }
      ]
    });

    const unavailable = buildApp(
      async () => undefined,
      vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.includes("tenant.test")) return Response.json({ status: "down" }, { status: 503 });
        if (url.endsWith("/.well-known/jwks.json")) return Response.json({ keys: [{ kid: "platform-key" }] });
        return Response.json({ status: "ok" });
      })
    );
    const down = await unavailable.inject({ method: "GET", url: "/ready" });
    const live = await unavailable.inject({ method: "GET", url: "/health" });

    expect(down.statusCode).toBe(503);
    expect(down.json().dependencies).toContainEqual({ name: "tenant", status: "down" });
    expect(live.statusCode).toBe(200);
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
        remoteAddress: "198.51.100.40",
        headers: { "x-requested-with": PLATFORM_ADMIN_REQUEST_HEADER, "x-forwarded-for": `203.0.113.${attempt + 1}` },
        payload: {}
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.40",
      headers: { "x-requested-with": PLATFORM_ADMIN_REQUEST_HEADER, "x-forwarded-for": "203.0.113.200" },
      payload: {}
    });
    const isolated = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.41",
      headers: { "x-requested-with": PLATFORM_ADMIN_REQUEST_HEADER, "x-forwarded-for": "203.0.113.200" },
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
        headers: { "x-requested-with": PLATFORM_ADMIN_REQUEST_HEADER },
        payload: {
          email: attempt % 2 === 0 ? " Admin@Example.COM " : "admin@example.com",
          password: "invalid-password"
        }
      });
      expect(response.statusCode).toBe(401);
    }
    const distributedBlocked = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.240",
      headers: { "x-requested-with": PLATFORM_ADMIN_REQUEST_HEADER },
      payload: { email: "admin@example.com", password: "invalid-password" }
    });
    const neighborAccount = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      remoteAddress: "198.51.100.240",
      headers: { "x-requested-with": PLATFORM_ADMIN_REQUEST_HEADER },
      payload: { email: "neighbor@example.com", password: "invalid-password" }
    });
    expect(distributedBlocked.statusCode).toBe(429);
    expect(neighborAccount.statusCode).toBe(401);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(requestFetch).toHaveBeenCalledTimes(22);
  });

  it("returns 404 for product routes before resolving a session", async () => {
    const resolvePrincipal = vi.fn(async () => principal(true));
    const requestFetch = vi.fn();
    const app = buildApp(resolvePrincipal, requestFetch);
    const response = await app.inject({
      method: "GET",
      url: `/v1/tenants/${tenantId}/nova/contacts`,
      headers: { cookie: cookies }
    });

    expect(response.statusCode).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("retires audit reads and tenant writes before resolving a session or contacting an upstream", async () => {
    const resolvePrincipal = vi.fn(async () => principal(true));
    const requestFetch = vi.fn();
    const app = buildApp(resolvePrincipal, requestFetch);

    const audit = await app.inject({ method: "GET", url: "/v1/audit/events", headers: { cookie: cookies } });
    const tenantWrite = await app.inject({
      method: "POST",
      url: "/v1/tenants",
      headers: { cookie: cookies, "x-csrf-token": csrfToken },
      payload: { displayName: "No direct SQL provisioning" }
    });

    expect(audit.statusCode).toBe(404);
    expect(tenantWrite.statusCode).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("returns 403 when a valid principal lacks PLATFORM manage:platform", async () => {
    const requestFetch = vi.fn();
    const app = buildApp(async () => principal(false), requestFetch);
    const response = await app.inject({ method: "GET", url: "/v1/identity/operators", headers: { cookie: cookies } });

    expect(response.statusCode).toBe(403);
    expect(response.json().data.error).toContain("manage:platform");
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("never promotes a PLATFORM grant attached to a customer tenant", async () => {
    const requestFetch = vi.fn();
    const app = buildApp(async () => principal(true, tenantId), requestFetch);
    const response = await app.inject({ method: "GET", url: "/v1/identity/operators", headers: { cookie: cookies } });

    expect(response.statusCode).toBe(403);
    expect(requestFetch).not.toHaveBeenCalled();
  });

  it("ignores browser bearer tokens and requires the host-only session cookie", async () => {
    const resolvePrincipal = vi.fn(async () => principal(true));
    const app = buildApp(resolvePrincipal, vi.fn());
    const response = await app.inject({
      method: "GET",
      url: "/v1/platform/catalog",
      headers: { authorization: `Bearer ${sessionToken}` }
    });

    expect(response.statusCode).toBe(401);
    expect(resolvePrincipal).not.toHaveBeenCalled();
  });

  it("serves the provider-owned versioned product catalog", async () => {
    const app = buildApp(async () => principal(true), vi.fn());
    const response = await app.inject({
      method: "GET",
      url: "/v1/platform/catalog",
      headers: { cookie: cookies }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(platformProductCatalogV1);
    expect(response.json().data.catalogVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses the exact console header, stores JWT/CSRF in host-only cookies, and never reflects the JWT", async () => {
    const nowMs = 1_900_000_000_000;
    const accessToken = fakeJwt(Math.floor(nowMs / 1000) + 300);
    const requestFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-hyperion-caller")).toBe("platform-admin-bff");
      expect(headers.get("authorization")).toBe("Bearer platform-to-access");
      expect(init?.redirect).toBe("error");
      return new Response(
        JSON.stringify({
          data: {
            token: accessToken,
            accessToken,
            tokenType: "Bearer",
            expiresAt: new Date(nowMs + 300_000).toISOString()
          }
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    });
    const app = buildApp(async (token) => (token === accessToken ? principal(true) : undefined), requestFetch, nowMs);
    const wrongHeader = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-requested-with": "HyperionPlatformAdmin" },
      payload: { email: "admin@example.com", password: "valid-password" }
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-requested-with": PLATFORM_ADMIN_REQUEST_HEADER },
      payload: { email: "admin@example.com", password: "valid-password" }
    });

    expect(wrongHeader.statusCode).toBe(403);
    expect(response.statusCode).toBe(201);
    const setCookies = response.headers["set-cookie"] as string[];
    const session = setCookies.find((value) => value.startsWith(`${PLATFORM_ADMIN_SESSION_COOKIE}=`));
    const csrf = setCookies.find((value) => value.startsWith(`${PLATFORM_ADMIN_CSRF_COOKIE}=`));
    expect(session).toContain("HttpOnly");
    expect(session).toContain("Secure");
    expect(session).toContain("SameSite=Strict");
    expect(session).not.toContain("Domain=");
    expect(csrf).not.toContain("HttpOnly");
    expect(response.body).not.toContain(accessToken);
    expect(response.json().data).toMatchObject({
      operator: { id: operatorId },
      tenantIds: [platformControlTenantId]
    });
  });

  it("rejects an oversized session before emitting any Set-Cookie header", async () => {
    const nowMs = 1_900_000_000_000;
    const oversizedToken = `header.payload.${"x".repeat(4050)}`;
    const requestFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              token: oversizedToken,
              accessToken: oversizedToken,
              tokenType: "Bearer",
              expiresAt: new Date(nowMs + 300_000).toISOString()
            }
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
    );
    const app = buildApp(async () => principal(true), requestFetch, nowMs);
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "x-requested-with": PLATFORM_ADMIN_REQUEST_HEADER },
      payload: { email: "admin@example.com", password: "valid-password" }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json().data.error).toContain("cookie-safe budget");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("proxies only the identity admin allowlist with a signed platform-manager context", async () => {
    const requestFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(String(input)).toBe("http://identity.test/v1/identity/operators");
      expect(headers.get("authorization")).toBe("Bearer platform-to-identity");
      expect(headers.get("x-hyperion-caller")).toBe("platform-admin-bff");
      expect(headers.get("x-operator-id")).toBe(operatorId);
      expect(headers.get("x-operator-role")).toBe("platform-manager");
      expect(headers.get("x-hyperion-operator-assertion")).toContain(`|platform-manager|${platformControlTenantId}|`);
      expect(init?.redirect).toBe("error");
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const app = buildApp(async () => principal(true), requestFetch);
    const response = await app.inject({ method: "GET", url: "/v1/identity/operators", headers: { cookie: cookies } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [] });
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });

  it("accepts application/json and +json media types and preserves 204 without a body", async () => {
    const requestFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: tenantId }] }), {
          status: 200,
          headers: { "content-type": "Application/JSON; Charset=UTF-8" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "grant conflict" }), {
          status: 409,
          headers: {
            "content-type": "application/problem+json; charset=utf-8",
            "x-unsafe-upstream-header": "must-not-be-reflected"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 204,
          headers: { "content-type": "text/html", "x-unsafe-upstream-header": "must-not-be-reflected" }
        })
      );
    const app = buildApp(async () => principal(true), requestFetch);

    const applicationJson = await app.inject({ method: "GET", url: "/v1/tenants", headers: { cookie: cookies } });
    const structuredJson = await app.inject({
      method: "GET",
      url: "/v1/platform/grants",
      headers: { cookie: cookies }
    });
    const noContent = await app.inject({
      method: "GET",
      url: "/v1/identity/operators",
      headers: { cookie: cookies }
    });

    expect(applicationJson.statusCode).toBe(200);
    expect(applicationJson.json()).toEqual({ data: [{ id: tenantId }] });
    expect(structuredJson.statusCode).toBe(409);
    expect(structuredJson.json()).toEqual({ error: "grant conflict" });
    expect(structuredJson.headers["x-unsafe-upstream-header"]).toBeUndefined();
    expect(noContent.statusCode).toBe(204);
    expect(noContent.body).toBe("");
    expect(noContent.headers["x-unsafe-upstream-header"]).toBeUndefined();
    expect(requestFetch).toHaveBeenCalledTimes(3);
    for (const [, init] of requestFetch.mock.calls) expect(init?.redirect).toBe("error");
  });

  it("fails closed on HTML, malformed JSON, and upstream redirect responses", async () => {
    const followedRedirect = Response.json({ data: { leaked: true } });
    Object.defineProperty(followedRedirect, "redirected", { value: true });
    const requestFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<script>stealCsrf()</script>", {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            location: "https://attacker.example",
            "set-cookie": "attacker=session"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response("{not-json", {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(Response.redirect("https://attacker.example", 302))
      .mockResolvedValueOnce(followedRedirect);
    const app = buildApp(async () => principal(true), requestFetch);

    const responses = [
      await app.inject({ method: "GET", url: "/v1/tenants", headers: { cookie: cookies } }),
      await app.inject({ method: "GET", url: "/v1/platform/grants", headers: { cookie: cookies } }),
      await app.inject({ method: "GET", url: "/v1/identity/operators", headers: { cookie: cookies } }),
      await app.inject({ method: "GET", url: "/v1/identity/operators", headers: { cookie: cookies } })
    ];

    expect(responses.map((response) => response.statusCode)).toEqual([502, 502, 502, 502]);
    for (const response of responses) {
      expect(response.headers["content-type"]).toMatch(/^application\/json\b/);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.body).not.toContain("stealCsrf");
      expect(response.body).not.toContain("leaked");
      expect(response.json().data.error).toBe("Platform administration upstream unavailable");
    }
    for (const [, init] of requestFetch.mock.calls) expect(init?.redirect).toBe("error");
  });

  it("proxies the exact tenant read and grant write surfaces supported by their owners", async () => {
    const calls: string[] = [];
    const requestFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(input)}`);
      return new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const app = buildApp(async () => principal(true), requestFetch);
    const writeHeaders = { cookie: cookies, "x-csrf-token": csrfToken };

    const tenants = await app.inject({ method: "GET", url: "/v1/tenants", headers: { cookie: cookies } });
    const upsert = await app.inject({
      method: "PUT",
      url: `/v1/platform/grants/${operatorId}/${tenantId}/NOVA`,
      headers: writeHeaders,
      payload: { roles: ["admin"], capabilities: ["nova:admin"], active: true }
    });
    const revoke = await app.inject({
      method: "DELETE",
      url: `/v1/platform/grants/${operatorId}/${tenantId}/NOVA`,
      headers: writeHeaders
    });

    expect([tenants.statusCode, upsert.statusCode, revoke.statusCode]).toEqual([200, 200, 200]);
    expect(calls).toEqual([
      "GET http://tenant.test/v1/tenants",
      `PUT http://identity.test/v1/access/operators/${operatorId}/grants/${tenantId}/NOVA`,
      `DELETE http://identity.test/v1/access/operators/${operatorId}/grants/${tenantId}/NOVA`
    ]);
  });

  it("requires matching double-submit CSRF for administrative writes and logout", async () => {
    const requestFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { created: true } }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
    );
    const app = buildApp(async () => principal(true), requestFetch);
    const denied = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: { cookie: cookies },
      payload: { email: "user@example.com" }
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/v1/identity/operators",
      headers: { cookie: cookies, "x-csrf-token": csrfToken },
      payload: { email: "user@example.com" }
    });
    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: { cookie: cookies, "x-csrf-token": csrfToken }
    });

    expect(denied.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(201);
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers["set-cookie"])).toContain("Max-Age=0");
    expect(requestFetch).toHaveBeenCalledTimes(1);
  });
});

function buildApp(
  resolvePrincipal: (token: string) => Promise<AccessPrincipal | undefined>,
  requestFetch: typeof fetch,
  nowMs = 1_900_000_000_000
) {
  const app = createPlatformAdminBff({
    resolvePrincipal,
    accessUrl: "http://access.test",
    accessCredential: "platform-to-access",
    upstreams: {
      identity: "http://identity.test",
      tenant: "http://tenant.test"
    },
    credentials: {
      identity: "platform-to-identity",
      tenant: "platform-to-tenant"
    },
    operatorAssertionKey: "platform-admin-assertion-key-0001",
    fetch: requestFetch,
    now: () => nowMs
  });
  apps.push(app);
  return app;
}

function principal(canManage: boolean, grantTenantId: string = platformControlTenantId): AccessPrincipal {
  return accessPrincipalSchema.parse({
    operator: {
      id: operatorId,
      email: "admin@example.com",
      displayName: "Platform Admin",
      role: "admin"
    },
    grants: [
      {
        tenantId: canManage ? grantTenantId : tenantId,
        productId: canManage ? "PLATFORM" : "NOVA",
        roles: [canManage ? "platform-admin" : "admin"],
        capabilities: [canManage ? "manage:platform" : "nova:admin"]
      }
    ]
  });
}

function fakeJwt(exp: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", kid: "test" })}.${encode({ exp })}.signature`;
}
