import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import {
  accessMeSchema,
  envelope,
  platformControlTenantId,
  productIdSchema,
  tenantIdSchema,
  type AccessPrincipal
} from "@hyperion/platform-contracts";
import { createOperatorAssertion, OPERATOR_ASSERTION_HEADER } from "@hyperion/platform-contracts/operator-assertion";
import { platformProductCatalogV1 } from "@hyperion/platform-contracts/product-catalog";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

export type PlatformPrincipalResolver = (token: string) => Promise<AccessPrincipal | undefined>;
type Upstream = "identity" | "tenant";

export interface PlatformAdminRouteInventoryEntry {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  authorization: "public" | "session" | "platform-admin";
  owner: "local" | "access" | Upstream;
}

export const PLATFORM_ADMIN_ROUTE_INVENTORY = Object.freeze([
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
] satisfies readonly PlatformAdminRouteInventoryEntry[]);

export interface PlatformAdminBffOptions {
  resolvePrincipal: PlatformPrincipalResolver;
  accessUrl: string;
  accessCredential: string | undefined;
  upstreams: Record<Upstream, string>;
  credentials: Record<Upstream, string | undefined>;
  operatorAssertionKey: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

export const PLATFORM_ADMIN_SESSION_COOKIE = "__Host-hyperion-platform-admin-session";
export const PLATFORM_ADMIN_CSRF_COOKIE = "__Host-hyperion-platform-admin-csrf";
export const PLATFORM_ADMIN_REQUEST_HEADER = "platform-admin-console";
const operatorIdSchema = z.string().uuid();
const SAFE_METHODS = new Set(["GET", "HEAD"]);
export const LOGIN_RATE_LIMIT_MAX = 10;
export const LOGIN_RATE_LIMIT_WINDOW = "1 minute";
export const MAX_PLATFORM_SESSION_COOKIE_BYTES = 4096;

export function createPlatformAdminBff(options: PlatformAdminBffOptions): FastifyInstance {
  const registeredRoutes = new Set<string>();
  const app = Fastify({
    logger: false,
    trustProxy: false,
    exposeHeadRoutes: false,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID()
  });
  const requestFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const accessUrl = normalizeUrl("access", options.accessUrl);
  const upstreams = Object.fromEntries(
    Object.entries(options.upstreams).map(([name, value]) => [name, normalizeUrl(name, value)])
  ) as Record<Upstream, string>;

  app.register(rateLimit, { global: false, hook: "preHandler" });

  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) registeredRoutes.add(routeKey(String(method), route.url));
  });

  app.addHook("onReady", async () => assertRouteInventory(registeredRoutes));

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.get("/health", async () => ({ service: "platform-admin-bff", cell: "platform", status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    const configurationReady = Boolean(
      options.accessCredential &&
      options.credentials.identity &&
      options.credentials.tenant &&
      options.operatorAssertionKey
    );
    const dependencies = configurationReady
      ? await Promise.all([
          probePlatformDependency(requestFetch, "access-jwks", `${accessUrl}/.well-known/jwks.json`, "jwks"),
          probePlatformDependency(requestFetch, "identity", `${upstreams.identity}/ready`, "service"),
          probePlatformDependency(requestFetch, "tenant", `${upstreams.tenant}/ready`, "service")
        ])
      : [{ name: "workload-configuration", status: "down" as const }];
    const status = dependencies.every((dependency) => dependency.status === "ok") ? "ok" : "down";
    return reply.code(status === "ok" ? 200 : 503).send({
      service: "platform-admin-bff",
      cell: "platform",
      status,
      dependencies
    });
  });

  app.register(async (loginApp) => {
    loginApp.post(
      "/v1/auth/login",
      {
        config: {
          rateLimit: {
            max: LOGIN_RATE_LIMIT_MAX,
            timeWindow: LOGIN_RATE_LIMIT_WINDOW,
            keyGenerator: loginRateLimitKey
          }
        }
      },
      async (request, reply) => {
        if (request.headers["x-requested-with"] !== PLATFORM_ADMIN_REQUEST_HEADER) {
          return reply.code(403).send(envelope({ error: "Platform admin console request required" }, request.id));
        }
        if (!options.accessCredential) {
          return reply
            .code(503)
            .send(envelope({ error: "Platform admin to Access identity is not configured" }, request.id));
        }
        let response: Response;
        try {
          response = await requestFetch(`${accessUrl}/v1/access/token`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.accessCredential}`,
              "x-hyperion-caller": "platform-admin-bff",
              "x-request-id": request.id,
              "content-type": "application/json"
            },
            body: JSON.stringify(request.body ?? {}),
            redirect: "error",
            signal: AbortSignal.timeout(5_000)
          });
        } catch {
          return reply.code(502).send(envelope({ error: "Access service unavailable" }, request.id));
        }
        const payload = await readJson(response);
        if (!response.ok) return reply.code(response.status).send(sanitizeError(payload, request.id));
        const token = extractToken(payload);
        if (!token) return reply.code(502).send(envelope({ error: "Access returned no usable session" }, request.id));
        const principal = await options.resolvePrincipal(token);
        if (!principal)
          return reply.code(502).send(envelope({ error: "Access returned an invalid session" }, request.id));

        const csrfToken = randomBytes(32).toString("base64url");
        const maxAge = readMaxAge(token, payload, now());
        const sessionCookie = serializeCookie(PLATFORM_ADMIN_SESSION_COOKIE, token, true, maxAge);
        const csrfCookie = serializeCookie(PLATFORM_ADMIN_CSRF_COOKIE, csrfToken, false, maxAge);
        if (
          Buffer.byteLength(sessionCookie, "utf8") > MAX_PLATFORM_SESSION_COOKIE_BYTES ||
          Buffer.byteLength(csrfCookie, "utf8") > MAX_PLATFORM_SESSION_COOKIE_BYTES
        ) {
          return reply.code(502).send(envelope({ error: "Access session exceeds the cookie-safe budget" }, request.id));
        }
        reply.header("set-cookie", [sessionCookie, csrfCookie]);
        reply.header("cache-control", "no-store");
        return reply.code(201).send(envelope(accessMe(principal), request.id));
      }
    );
  });

  app.get("/v1/auth/me", async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    reply.header("cache-control", "no-store");
    return envelope(accessMe(session.principal), request.id);
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    if (!hasValidCsrf(request)) {
      return reply.code(403).send(envelope({ error: "Valid CSRF token required" }, request.id));
    }
    clearCookies(reply);
    return envelope({ loggedOut: true }, request.id);
  });

  app.get("/v1/platform/catalog", async (request, reply) => {
    const denial = await authorizeAdministration(request, reply, options.resolvePrincipal, false);
    if (denial) return denial;
    return envelope(platformProductCatalogV1, request.id);
  });

  app.get("/v1/identity/operators", (request, reply) =>
    authorizeAndProxy(request, reply, options, upstreams, requestFetch, "identity", "/v1/identity/operators", now)
  );
  app.post("/v1/identity/operators", (request, reply) =>
    authorizeAndProxy(request, reply, options, upstreams, requestFetch, "identity", "/v1/identity/operators", now)
  );
  app.patch("/v1/identity/operators/:operatorId", (request, reply) => {
    const operatorId = operatorIdSchema.safeParse(readParam(request.params, "operatorId"));
    if (!operatorId.success) return reply.code(400).send(envelope({ error: "operatorId must be a UUID" }, request.id));
    return authorizeAndProxy(
      request,
      reply,
      options,
      upstreams,
      requestFetch,
      "identity",
      `/v1/identity/operators/${encodeURIComponent(operatorId.data)}`,
      now
    );
  });

  app.get("/v1/tenants", (request, reply) =>
    authorizeAndProxy(request, reply, options, upstreams, requestFetch, "tenant", "/v1/tenants", now)
  );
  app.get("/v1/platform/grants", (request, reply) =>
    authorizeAndProxy(request, reply, options, upstreams, requestFetch, "identity", "/v1/access/grants", now)
  );
  app.route({
    method: ["PUT", "DELETE"],
    url: "/v1/platform/grants/:operatorId/:tenantId/:productId",
    handler: (request, reply) => {
      const operatorId = operatorIdSchema.safeParse(readParam(request.params, "operatorId"));
      const tenantId = tenantIdSchema.safeParse(readParam(request.params, "tenantId"));
      const productId = productIdSchema.safeParse(readParam(request.params, "productId"));
      if (!operatorId.success || !tenantId.success || !productId.success) {
        return reply.code(400).send(envelope({ error: "Invalid grant path" }, request.id));
      }
      return authorizeAndProxy(
        request,
        reply,
        options,
        upstreams,
        requestFetch,
        "identity",
        `/v1/access/operators/${encodeURIComponent(operatorId.data)}/grants/${encodeURIComponent(tenantId.data)}/${encodeURIComponent(productId.data)}`,
        now
      );
    }
  });
  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(envelope({ error: "Route is not part of platform administration" }, request.id))
  );
  return app;
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

async function probePlatformDependency(
  requestFetch: typeof fetch,
  name: string,
  url: string,
  kind: "jwks" | "service"
): Promise<{ name: string; status: "down" | "ok" }> {
  try {
    const response = await requestFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) return { name, status: "down" };
    const payload = await readJson(response);
    const valid =
      kind === "jwks"
        ? typeof payload === "object" &&
          payload !== null &&
          "keys" in payload &&
          Array.isArray(payload.keys) &&
          payload.keys.length > 0
        : typeof payload === "object" && payload !== null && "status" in payload && payload.status === "ok";
    return { name, status: valid ? "ok" : "down" };
  } catch {
    return { name, status: "down" };
  }
}

function assertRouteInventory(registeredRoutes: ReadonlySet<string>): void {
  const expectedRoutes = new Set(PLATFORM_ADMIN_ROUTE_INVENTORY.map((route) => routeKey(route.method, route.path)));
  const unexpected = [...registeredRoutes].filter((route) => !expectedRoutes.has(route)).sort();
  const missing = [...expectedRoutes].filter((route) => !registeredRoutes.has(route)).sort();
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `Platform admin route inventory mismatch; unexpected=${unexpected.join(",") || "none"}; missing=${missing.join(",") || "none"}`
    );
  }
}

function loginRateLimitKey(request: FastifyRequest): string {
  const email = readNormalizedLoginEmail(request.body);
  const material = email ? `account:${email}` : `ip:${request.ip}`;
  return createHash("sha256").update(material).digest("base64url");
}

function readNormalizedLoginEmail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || !("email" in body)) return undefined;
  const value = (body as { email?: unknown }).email;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().normalize("NFKC").toLowerCase();
  return normalized.length > 0 && normalized.length <= 320 ? normalized : undefined;
}

async function authorizeAndProxy(
  request: FastifyRequest,
  reply: FastifyReply,
  options: PlatformAdminBffOptions,
  upstreams: Record<Upstream, string>,
  requestFetch: typeof fetch,
  upstream: Upstream,
  path: string,
  now: () => number
): Promise<unknown> {
  const session = await resolveCookieSession(request, options.resolvePrincipal);
  if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
  if (!canManagePlatform(session.principal)) {
    return reply.code(403).send(envelope({ error: "manage:platform capability required" }, request.id));
  }
  if (!SAFE_METHODS.has(request.method) && !hasValidCsrf(request)) {
    return reply.code(403).send(envelope({ error: "Valid CSRF token required" }, request.id));
  }
  const credential = options.credentials[upstream];
  if (!credential || (upstream === "identity" && !options.operatorAssertionKey)) {
    return reply.code(503).send(envelope({ error: `Platform admin ${upstream} edge is not configured` }, request.id));
  }
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential}`,
    "x-hyperion-caller": "platform-admin-bff",
    "x-request-id": request.id,
    accept: "application/json"
  };
  if (upstream === "identity") {
    headers["x-operator-id"] = session.principal.operator.id;
    headers["x-operator-role"] = "platform-manager";
    headers[OPERATOR_ASSERTION_HEADER] = createOperatorAssertion(
      {
        operatorId: session.principal.operator.id,
        role: "platform-manager",
        tenantId: platformControlTenantId,
        expiresAtUnix: Math.floor(now() / 1000) + 60
      },
      options.operatorAssertionKey!
    );
  }
  const contentType = request.headers["content-type"];
  if (contentType) headers["content-type"] = contentType;
  try {
    const response = await requestFetch(`${upstreams[upstream]}${path}`, {
      method: request.method,
      headers,
      body: SAFE_METHODS.has(request.method) ? undefined : serializeBody(request.body, contentType),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new Error("Upstream redirects are not allowed");
    }
    if (response.status === 204) return reply.code(204).send();
    if (!isJsonMediaType(response.headers.get("content-type"))) {
      throw new Error("Upstream response is not JSON");
    }
    return reply.code(response.status).send(await response.json());
  } catch {
    return reply.code(502).send(envelope({ error: "Platform administration upstream unavailable" }, request.id));
  }
}

function isJsonMediaType(contentType: string | null): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType) return false;
  if (mediaType === "application/json") return true;
  const separator = mediaType.indexOf("/");
  return separator > 0 && separator < mediaType.length - 1 && mediaType.endsWith("+json");
}

async function authorizeAdministration(
  request: FastifyRequest,
  reply: FastifyReply,
  resolvePrincipal: PlatformPrincipalResolver,
  requireCsrf: boolean
): Promise<unknown | undefined> {
  const session = await resolveCookieSession(request, resolvePrincipal);
  if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
  if (!canManagePlatform(session.principal)) {
    return reply.code(403).send(envelope({ error: "manage:platform capability required" }, request.id));
  }
  if (requireCsrf && !hasValidCsrf(request)) {
    return reply.code(403).send(envelope({ error: "Valid CSRF token required" }, request.id));
  }
  return undefined;
}

function canManagePlatform(principal: AccessPrincipal): boolean {
  return principal.grants.some(
    (grant) =>
      grant.active &&
      grant.tenantId === platformControlTenantId &&
      grant.productId === "PLATFORM" &&
      grant.roles.includes("platform-admin") &&
      grant.capabilities.includes("manage:platform")
  );
}

function accessMe(principal: AccessPrincipal) {
  return accessMeSchema.parse({
    ...principal,
    tenantIds: [...new Set(principal.grants.filter((grant) => grant.active).map((grant) => grant.tenantId))]
  });
}

async function resolveCookieSession(request: FastifyRequest, resolvePrincipal: PlatformPrincipalResolver) {
  const token = readCookie(request.headers.cookie, PLATFORM_ADMIN_SESSION_COOKIE);
  if (!token || token.length < 20) return undefined;
  const principal = await resolvePrincipal(token);
  return principal ? { token, principal } : undefined;
}

function hasValidCsrf(request: FastifyRequest): boolean {
  const cookieToken = readCookie(request.headers.cookie, PLATFORM_ADMIN_CSRF_COOKIE);
  const headerToken = request.headers["x-csrf-token"];
  if (!cookieToken || typeof headerToken !== "string") return false;
  const left = Buffer.from(cookieToken);
  const right = Buffer.from(headerToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  let result: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    if (result !== undefined) return undefined;
    try {
      result = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return result;
}

function serializeCookie(name: string, value: string, httpOnly: boolean, maxAge: number): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "Secure",
    "SameSite=Strict"
  ];
  if (httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

function clearCookies(reply: FastifyReply): void {
  const attributes = "Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Strict";
  reply.header("set-cookie", [
    `${PLATFORM_ADMIN_SESSION_COOKIE}=; ${attributes}; HttpOnly`,
    `${PLATFORM_ADMIN_CSRF_COOKIE}=; ${attributes}`
  ]);
  reply.header("cache-control", "no-store");
}

function normalizeUrl(name: string, value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid ${name} upstream URL`);
  }
  return url.toString().replace(/\/$/, "");
}

function serializeBody(body: unknown, contentType: string | undefined): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (contentType?.includes("application/json")) return JSON.stringify(body);
  return typeof body === "string" ? body : JSON.stringify(body);
}

function readParam(params: unknown, key: string): unknown {
  return typeof params === "object" && params !== null && key in params
    ? (params as Record<string, unknown>)[key]
    : undefined;
}

function extractToken(payload: unknown): string | undefined {
  const data = unwrap(payload);
  if (typeof data !== "object" || data === null) return undefined;
  const record = data as { accessToken?: unknown; token?: unknown };
  const token = typeof record.accessToken === "string" ? record.accessToken : record.token;
  return typeof token === "string" && token.length >= 20 ? token : undefined;
}

function readMaxAge(token: string, payload: unknown, nowMs: number): number {
  const data = unwrap(payload);
  let expiry =
    typeof data === "object" && data !== null && typeof (data as { expiresAt?: unknown }).expiresAt === "string"
      ? Date.parse((data as { expiresAt: string }).expiresAt)
      : Number.NaN;
  if (!Number.isFinite(expiry)) {
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
        exp?: unknown;
      };
      expiry = typeof claims.exp === "number" ? claims.exp * 1000 : Number.NaN;
    } catch {
      expiry = Number.NaN;
    }
  }
  if (!Number.isFinite(expiry) || expiry <= nowMs) return 300;
  return Math.max(1, Math.min(900, Math.floor((expiry - nowMs) / 1000)));
}

async function readJson(response: Response): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return undefined;
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function unwrap(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data?: unknown }).data
    : payload;
}

function sanitizeError(payload: unknown, requestId: string) {
  const data = unwrap(payload);
  const error =
    typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : "Access request failed";
  return envelope({ error }, requestId);
}
