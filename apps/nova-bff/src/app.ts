import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { TextDecoder } from "node:util";
import rateLimit from "@fastify/rate-limit";
import {
  findNovaGrant,
  NOVA_BFF_TENANT_ROUTE_POLICIES,
  novaGrantAllows,
  type NovaBffTenantRoutePolicy,
  type NovaProductRole,
  type NovaCellComponent
} from "@hyperion/nova-contracts";
import { envelope, tenantIdSchema, type AccessPrincipal } from "@hyperion/platform-contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { createNovaOperatorAssertion, OPERATOR_ASSERTION_HEADER } from "./assertion.js";

export { NOVA_BFF_TENANT_ROUTE_POLICIES } from "@hyperion/nova-contracts";

export type PrincipalResolver = (token: string) => Promise<AccessPrincipal | undefined>;

export interface NovaBffOptions {
  resolvePrincipal: PrincipalResolver;
  accessKeyReadiness: () => Promise<boolean>;
  accessUrl: string;
  accessCredential: string | undefined;
  upstreams: Record<NovaCellComponent, string>;
  credentials: Record<NovaCellComponent, string | undefined>;
  operatorAssertionKey: string | undefined;
  providerEdgeCredential: string | undefined;
  fetch?: typeof fetch;
  now?: () => number;
}

const NOVA_ROLE_PREFERENCE = ["admin", "supervisor", "asesor"] as const satisfies readonly NovaProductRole[];
type NovaBffPublicRoutePolicy = {
  method: "GET" | "POST";
  path: `/v1/${string}`;
};
export const NOVA_BFF_PUBLIC_ROUTE_POLICIES = Object.freeze({
  login: { method: "POST", path: "/v1/auth/login" },
  me: { method: "GET", path: "/v1/auth/me" },
  logout: { method: "POST", path: "/v1/auth/logout" },
  tenants: { method: "GET", path: "/v1/tenants" },
  liwaWebhook: { method: "POST", path: "/v1/liwa/webhooks" },
  dialerWebhook: { method: "POST", path: "/v1/voice/webhooks/dialer" },
  elevenLabsWebhook: { method: "POST", path: "/v1/voice/webhooks/elevenlabs" }
} as const satisfies Record<string, NovaBffPublicRoutePolicy>);
export const NOVA_SESSION_COOKIE = "__Host-hyperion-nova-session";
export const NOVA_CSRF_COOKIE = "__Host-hyperion-nova-csrf";
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;
export const UPSTREAM_JSON_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const PROVIDER_WEBHOOK_BODY_LIMIT_BYTES = 2_100_000;
export const PROVIDER_WEBHOOK_RATE_LIMIT_MAX = 120;
export const PROVIDER_EDGE_TOKEN_HEADER = "x-hyperion-provider-edge-token";
export const PROVIDER_CLIENT_IP_HEADER = "x-hyperion-provider-client-ip";
const JSON_MEDIA_TYPE_PATTERN = /^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)$/i;
const SAFE_UPSTREAM_CACHE_HEADERS = ["cache-control", "pragma", "expires"] as const;
const serviceReadinessSchema = z.object({ status: z.literal("ok") }).passthrough();
const NOVA_BFF_READINESS_COMPONENTS = Object.freeze([
  ...new Set(NOVA_BFF_TENANT_ROUTE_POLICIES.map((policy) => policy.component))
]);
const NOVA_BFF_READINESS_DEPENDENCY_NAMES: Record<NovaCellComponent, string> = {
  nova: "nova-core",
  voice: "nova-voice",
  liwa: "nova-liwa",
  documents: "nova-documents"
};
export const NOVA_BFF_READINESS_PROBE_TIMEOUT_MS = 3_000;
type BffReadinessDependency = {
  name: string;
  status: "degraded" | "down" | "ok";
  required: boolean;
};
export const LOGIN_RATE_LIMIT_MAX = 10;
export const LOGIN_RATE_LIMIT_WINDOW = "1 minute";
export const MAX_NOVA_SESSION_COOKIE_BYTES = 4096;
const UPSTREAM_TIMEOUT_MS: Record<NovaCellComponent, number> = {
  nova: 30_000,
  voice: 30_000,
  liwa: 10_000,
  documents: 30_000
};

const providerWebhookRoutes = [
  {
    path: NOVA_BFF_PUBLIC_ROUTE_POLICIES.liwaWebhook.path,
    component: "liwa",
    headers: ["x-liwa-webhook-secret"]
  },
  {
    path: NOVA_BFF_PUBLIC_ROUTE_POLICIES.dialerWebhook.path,
    component: "voice",
    headers: ["x-dialer-signature", "x-webhook-signature"]
  },
  {
    path: NOVA_BFF_PUBLIC_ROUTE_POLICIES.elevenLabsWebhook.path,
    component: "voice",
    headers: ["x-elevenlabs-signature", "elevenlabs-signature", "x-webhook-signature"]
  }
] as const satisfies ReadonlyArray<{
  path: string;
  component: Extract<NovaCellComponent, "voice" | "liwa">;
  headers: readonly string[];
}>;

const rawJsonBodies = new WeakMap<FastifyRequest, Buffer>();

export function createNovaBff(options: NovaBffOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: false,
    exposeHeadRoutes: false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID()
  });
  const upstreams = normalizeUpstreams(options.upstreams);
  const accessUrl = normalizeUpstream("access", options.accessUrl);
  const providerEdgeCredential = normalizeProviderEdgeCredential(options.providerEdgeCredential);
  const requestFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  registerRawJsonBodyParser(app);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
  });
  if (!app.hasContentTypeParser("multipart/form-data")) {
    app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_request, body, done) => {
      done(null, body);
    });
  }

  app.get("/health", async () => ({ service: "nova-bff", product: "NOVA", status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    const configurationReady = Boolean(
      options.accessCredential &&
      options.operatorAssertionKey &&
      typeof options.accessKeyReadiness === "function" &&
      NOVA_BFF_READINESS_COMPONENTS.every((component) => options.credentials[component])
    );
    const dependencies = configurationReady
      ? await collectReadinessDependencies([
          probeAccessKeyReadiness(options.accessKeyReadiness),
          probeNovaBffDependency(requestFetch, "access-token-minting", `${accessUrl}/ready`, false),
          ...NOVA_BFF_READINESS_COMPONENTS.map((component) =>
            probeNovaBffDependency(
              requestFetch,
              NOVA_BFF_READINESS_DEPENDENCY_NAMES[component],
              `${upstreams[component]}/ready`,
              true
            )
          )
        ])
      : [{ name: "workload-configuration", status: "down" as const, required: true }];
    const status = dependencies.every((dependency) => !dependency.required || dependency.status === "ok")
      ? "ok"
      : "down";
    return reply.code(status === "ok" ? 200 : 503).send({
      service: "nova-bff",
      product: "NOVA",
      status,
      dependencies
    });
  });
  app.register(async (publicIngressApp) => {
    await publicIngressApp.register(rateLimit, { global: false, hook: "preHandler" });
    publicIngressApp.post(
      NOVA_BFF_PUBLIC_ROUTE_POLICIES.login.path,
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
        if (request.headers["x-requested-with"] !== "nova-console") {
          return reply.code(403).send(envelope({ error: "NOVA console request required" }, request.id));
        }
        if (!options.accessCredential) {
          return reply.code(503).send(envelope({ error: "NOVA to Access identity is not configured" }, request.id));
        }
        let response: Response;
        try {
          response = await requestFetch(`${accessUrl}/v1/access/token`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.accessCredential}`,
              "x-hyperion-caller": "nova-bff",
              "content-type": "application/json",
              "x-request-id": request.id
            },
            body: JSON.stringify(request.body ?? {}),
            redirect: "error",
            signal: AbortSignal.timeout(5_000)
          });
        } catch {
          return reply.code(502).send(envelope({ error: "Access service unavailable" }, request.id));
        }
        const parsedResponse = await parseStrictJsonResponse(response);
        if (parsedResponse.kind === "invalid") {
          return reply.code(502).send(envelope({ error: "Access returned an unsafe response" }, request.id));
        }
        const payload = parsedResponse.kind === "json" ? parsedResponse.payload : undefined;
        if (!response.ok) return reply.code(response.status).send(sanitizeAccessError(payload, request.id));
        const token = extractAccessToken(payload);
        if (!token) return reply.code(502).send(envelope({ error: "Access returned no usable session" }, request.id));
        const principal = await options.resolvePrincipal(token);
        if (!principal)
          return reply.code(502).send(envelope({ error: "Access returned an invalid session" }, request.id));

        const csrfToken = randomBytes(32).toString("base64url");
        const maxAge = readSessionMaxAgeSeconds(token, payload, now());
        const sessionCookie = serializeCookie(NOVA_SESSION_COOKIE, token, { httpOnly: true, maxAge });
        const csrfCookie = serializeCookie(NOVA_CSRF_COOKIE, csrfToken, { httpOnly: false, maxAge });
        if (
          Buffer.byteLength(sessionCookie, "utf8") > MAX_NOVA_SESSION_COOKIE_BYTES ||
          Buffer.byteLength(csrfCookie, "utf8") > MAX_NOVA_SESSION_COOKIE_BYTES
        ) {
          return reply.code(502).send(envelope({ error: "Access session exceeds the cookie-safe budget" }, request.id));
        }
        reply.header("set-cookie", [sessionCookie, csrfCookie]);
        reply.header("cache-control", "no-store");
        return reply.code(201).send(envelope({ principal: novaPrincipalProjection(principal) }, request.id));
      }
    );

    for (const route of providerWebhookRoutes) {
      publicIngressApp.route({
        method: "POST",
        url: route.path,
        bodyLimit: PROVIDER_WEBHOOK_BODY_LIMIT_BYTES,
        config: {
          rateLimit: {
            max: PROVIDER_WEBHOOK_RATE_LIMIT_MAX,
            timeWindow: LOGIN_RATE_LIMIT_WINDOW,
            keyGenerator: (request: FastifyRequest) =>
              providerWebhookRateLimitKey(request, route.path, providerEdgeCredential)
          }
        },
        handler: async (request, reply) =>
          proxyProviderWebhook(request, reply, route, upstreams, requestFetch, providerEdgeCredential)
      });
    }
  });

  app.get(NOVA_BFF_PUBLIC_ROUTE_POLICIES.me.path, async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    reply.header("cache-control", "no-store");
    return envelope(novaPrincipalProjection(session.principal), request.id);
  });

  app.post(NOVA_BFF_PUBLIC_ROUTE_POLICIES.logout.path, async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    if (!hasValidCsrf(request)) {
      return reply.code(403).send(envelope({ error: "Valid CSRF token required" }, request.id));
    }
    // Clear host-only cookies immediately. Identity also revokes the JWT jti
    // when the bearer is forwarded (BFFs should proxy logout to Access).
    clearSessionCookies(reply);
    return envelope({ loggedOut: true }, request.id);
  });

  app.get(NOVA_BFF_PUBLIC_ROUTE_POLICIES.tenants.path, async (request, reply) => {
    const session = await resolveCookieSession(request, options.resolvePrincipal);
    if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    const tenantIds = [
      ...new Set(
        session.principal.grants
          .filter((grant) => grant.active && grant.productId === "NOVA")
          .map((grant) => grant.tenantId)
      )
    ];
    return envelope(
      tenantIds.map((id) => ({ id, displayName: `Tenant ${id.slice(0, 8)}` })),
      request.id
    );
  });

  for (const policy of NOVA_BFF_TENANT_ROUTE_POLICIES) {
    app.route({
      method: policy.method,
      url: policy.path,
      handler: (request, reply) => authorizeAndProxy(request, reply, policy, options, upstreams, requestFetch, now)
    });
  }

  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send(envelope({ error: "Route is not part of the NOVA cell" }, request.id));
  });
  return app;
}

function registerRawJsonBodyParser(app: FastifyInstance): void {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
    rawJsonBodies.set(request, rawBody);
    try {
      done(null, JSON.parse(rawBody.toString("utf8")));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
}

async function proxyProviderWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  route: (typeof providerWebhookRoutes)[number],
  upstreams: Record<NovaCellComponent, string>,
  requestFetch: typeof fetch,
  providerEdgeCredential: string | undefined
): Promise<unknown> {
  if ((request.raw.url ?? request.url) !== route.path) {
    return reply.code(404).send(envelope({ error: "Provider webhook route must match exactly" }, request.id));
  }
  if (!providerEdgeCredential) {
    return reply.code(503).send(envelope({ error: "NOVA provider edge identity is not configured" }, request.id));
  }
  if (!readAuthenticatedProviderClientIp(request, providerEdgeCredential)) {
    return reply.code(403).send(envelope({ error: "Trusted NOVA provider edge required" }, request.id));
  }
  const contentType = request.headers["content-type"];
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return reply.code(415).send(envelope({ error: "Provider webhooks require application/json" }, request.id));
  }
  const target = buildTargetUrl(upstreams[route.component], route.path);
  if (!target) return reply.code(400).send(envelope({ error: "Invalid request target" }, request.id));

  const headers: Record<string, string> = {
    "content-type": contentType,
    "x-request-id": request.id
  };
  for (const name of route.headers) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }

  try {
    const rawBody = rawJsonBodies.get(request) ?? Buffer.from(JSON.stringify(request.body ?? {}));
    const response = await requestFetch(target, {
      method: "POST",
      headers,
      body: new Uint8Array(rawBody),
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS[route.component])
    });
    return sendStrictJsonUpstreamResponse(
      reply,
      response,
      request.id,
      "NOVA provider webhook returned an unsafe response"
    );
  } catch {
    return reply.code(502).send(envelope({ error: "NOVA provider webhook upstream unavailable" }, request.id));
  }
}

function normalizeProviderEdgeCredential(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const length = Buffer.byteLength(normalized, "utf8");
  if (length < 32 || length > 256) {
    throw new Error("NOVA provider edge credential must contain between 32 and 256 bytes");
  }
  return normalized;
}

function providerWebhookRateLimitKey(
  request: FastifyRequest,
  routePath: string,
  providerEdgeCredential: string | undefined
): string {
  const clientIp = providerEdgeCredential
    ? readAuthenticatedProviderClientIp(request, providerEdgeCredential)
    : undefined;
  const material = clientIp ? `provider:${routePath}:${clientIp}` : `provider:${routePath}:untrusted-edge`;
  return createHash("sha256").update(material).digest("base64url");
}

function readAuthenticatedProviderClientIp(
  request: FastifyRequest,
  providerEdgeCredential: string
): string | undefined {
  const candidateCredential = request.headers[PROVIDER_EDGE_TOKEN_HEADER];
  const candidateIp = request.headers[PROVIDER_CLIENT_IP_HEADER];
  if (typeof candidateCredential !== "string" || typeof candidateIp !== "string" || isIP(candidateIp) === 0) {
    return undefined;
  }
  const expected = Buffer.from(providerEdgeCredential, "utf8");
  const candidate = Buffer.from(candidateCredential, "utf8");
  if (expected.length !== candidate.length || !timingSafeEqual(expected, candidate)) return undefined;
  return candidateIp;
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

function novaPrincipalProjection(principal: AccessPrincipal): AccessPrincipal {
  return {
    operator: principal.operator,
    grants: principal.grants.filter((grant) => grant.active && grant.productId === "NOVA")
  };
}

async function authorizeAndProxy(
  request: FastifyRequest,
  reply: FastifyReply,
  policy: NovaBffTenantRoutePolicy,
  options: NovaBffOptions,
  upstreams: Record<NovaCellComponent, string>,
  requestFetch: typeof fetch,
  now: () => number
): Promise<unknown> {
  const parsedTenant = tenantIdSchema.safeParse(readTenantId(request.params));
  if (!parsedTenant.success) {
    return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
  }
  const session = await resolveCookieSession(request, options.resolvePrincipal);
  if (!session) return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
  const { principal } = session;
  if (request.method !== "GET" && request.method !== "HEAD" && !hasValidCsrf(request)) {
    return reply.code(403).send(envelope({ error: "Valid CSRF token required" }, request.id));
  }
  const grant = findNovaGrant(principal, parsedTenant.data);
  if (!grant) {
    return reply.code(403).send(envelope({ error: "NOVA grant required for this tenant" }, request.id));
  }
  if (!novaGrantAllows(grant, policy.capability)) {
    return reply.code(403).send(envelope({ error: `${policy.capability} capability required` }, request.id));
  }
  if (policy.roles && !policy.roles.some((role) => grant.roles.includes(role))) {
    return reply.code(403).send(envelope({ error: "NOVA role is not allowed for this operation" }, request.id));
  }
  const operatorRole = selectAuthorizedNovaRole(grant.roles, policy.roles);
  if (!operatorRole) {
    return reply.code(403).send(envelope({ error: "NOVA role is not allowed for this operation" }, request.id));
  }

  const component = policy.component;
  const credential = options.credentials[component];
  if (!credential || !options.operatorAssertionKey) {
    return reply.code(503).send(envelope({ error: "NOVA workload identity is not configured" }, request.id));
  }

  const target = buildTargetUrl(upstreams[component], request.raw.url ?? request.url);
  if (!target) return reply.code(400).send(envelope({ error: "Invalid request target" }, request.id));
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential}`,
    "x-hyperion-caller": "nova-bff",
    "x-request-id": request.id,
    "x-operator-id": principal.operator.id,
    "x-operator-role": operatorRole,
    [OPERATOR_ASSERTION_HEADER]: createNovaOperatorAssertion(
      {
        operatorId: principal.operator.id,
        role: operatorRole,
        tenantId: parsedTenant.data,
        expiresAtUnix: Math.floor(now() / 1000) + 60
      },
      options.operatorAssertionKey
    )
  };
  const contentType = request.headers["content-type"];
  if (contentType) headers["content-type"] = contentType;

  try {
    const body = request.method === "GET" ? undefined : serializeBody(request.body, contentType);
    const response = await requestFetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS[component])
    });
    return sendStrictJsonUpstreamResponse(reply, response, request.id, "NOVA upstream returned an unsafe response");
  } catch {
    return reply.code(502).send(envelope({ error: "NOVA upstream service unavailable" }, request.id));
  }
}

function selectAuthorizedNovaRole(
  grantRoles: readonly NovaProductRole[],
  allowedRoles?: readonly NovaProductRole[]
): NovaProductRole | undefined {
  const preference = allowedRoles ?? NOVA_ROLE_PREFERENCE;
  return preference.find((role) => grantRoles.includes(role));
}

function readTenantId(params: unknown): unknown {
  return typeof params === "object" && params !== null && "tenantId" in params
    ? (params as { tenantId?: unknown }).tenantId
    : undefined;
}

function normalizeUpstreams(upstreams: Record<NovaCellComponent, string>): Record<NovaCellComponent, string> {
  return Object.fromEntries(
    Object.entries(upstreams).map(([component, value]) => {
      return [component, normalizeUpstream(component, value)];
    })
  ) as Record<NovaCellComponent, string>;
}

function normalizeUpstream(component: string, value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Invalid ${component} upstream URL`);
  }
  return url.toString().replace(/\/$/, "");
}

async function probeNovaBffDependency(
  requestFetch: typeof fetch,
  name: string,
  url: string,
  required: boolean
): Promise<BffReadinessDependency> {
  const failureStatus = required ? "down" : "degraded";
  try {
    const response = await requestFetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(NOVA_BFF_READINESS_PROBE_TIMEOUT_MS)
    });
    if (!response.ok) {
      await cancelResponseBody(response);
      return { name, status: failureStatus, required };
    }
    const parsed = await parseStrictJsonResponse(response);
    const valid = parsed.kind === "json" && serviceReadinessSchema.safeParse(parsed.payload).success;
    return { name, status: valid ? "ok" : failureStatus, required };
  } catch {
    return { name, status: failureStatus, required };
  }
}

async function probeAccessKeyReadiness(accessKeyReadiness: () => Promise<boolean>): Promise<BffReadinessDependency> {
  try {
    return {
      name: "access-signing-keys",
      status: (await accessKeyReadiness()) ? "ok" : "down",
      required: true
    };
  } catch {
    return { name: "access-signing-keys", status: "down", required: true };
  }
}

async function collectReadinessDependencies(
  probes: readonly Promise<BffReadinessDependency>[]
): Promise<BffReadinessDependency[]> {
  const settled = await Promise.allSettled(probes);
  return settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : { name: `readiness-probe-${index + 1}`, status: "down", required: true }
  );
}

function buildTargetUrl(base: string, rawTarget: string): string | undefined {
  if (!rawTarget.startsWith("/") || hasUnsafeTargetCharacter(rawTarget)) return undefined;
  const rawPath = rawTarget.split("?", 1)[0] ?? "";
  if (/%(?:2e|2f|5c|25)/iu.test(rawPath) || rawPath.split("/").some((part) => part === "." || part === "..")) {
    return undefined;
  }
  return `${base}${rawTarget}`;
}

function hasUnsafeTargetCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return character === "\\" || codePoint <= 31 || codePoint === 127;
  });
}

function serializeBody(body: unknown, contentType: string | undefined): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  if (contentType?.toLowerCase().includes("application/json")) return JSON.stringify(body);
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function resolveCookieSession(
  request: FastifyRequest,
  resolvePrincipal: PrincipalResolver
): Promise<{ token: string; principal: AccessPrincipal } | undefined> {
  const token = readCookie(request.headers.cookie, NOVA_SESSION_COOKIE);
  if (!token || token.length < 20) return undefined;
  const principal = await resolvePrincipal(token);
  return principal ? { token, principal } : undefined;
}

function hasValidCsrf(request: FastifyRequest): boolean {
  const cookieToken = readCookie(request.headers.cookie, NOVA_CSRF_COOKIE);
  const headerToken = request.headers["x-csrf-token"];
  if (!cookieToken || typeof headerToken !== "string") return false;
  const left = Buffer.from(cookieToken);
  const right = Buffer.from(headerToken);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  let found: string | undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    if (found !== undefined) return undefined;
    const raw = part.slice(separator + 1).trim();
    try {
      found = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return found;
}

function serializeCookie(name: string, value: string, options: { httpOnly: boolean; maxAge: number }): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${options.maxAge}`,
    "Secure",
    "SameSite=Strict"
  ];
  if (options.httpOnly) attributes.push("HttpOnly");
  return attributes.join("; ");
}

function clearSessionCookies(reply: FastifyReply): void {
  const expired = "Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Secure; SameSite=Strict";
  reply.header("set-cookie", [`${NOVA_SESSION_COOKIE}=; ${expired}; HttpOnly`, `${NOVA_CSRF_COOKIE}=; ${expired}`]);
  reply.header("cache-control", "no-store");
}

function extractAccessToken(payload: unknown): string | undefined {
  const data = unwrapEnvelope(payload);
  if (typeof data !== "object" || data === null) return undefined;
  const value = (data as { accessToken?: unknown }).accessToken;
  return typeof value === "string" && value.length >= 20 ? value : undefined;
}

function readSessionMaxAgeSeconds(token: string, payload: unknown, nowMs: number): number {
  const data = unwrapEnvelope(payload);
  const expiresAt =
    typeof data === "object" && data !== null && typeof (data as { expiresAt?: unknown }).expiresAt === "string"
      ? Date.parse((data as { expiresAt: string }).expiresAt)
      : Number.NaN;
  let expiryMs = expiresAt;
  if (!Number.isFinite(expiryMs)) {
    try {
      const payloadPart = token.split(".")[1];
      const claims = JSON.parse(Buffer.from(payloadPart ?? "", "base64url").toString("utf8")) as { exp?: unknown };
      expiryMs = typeof claims.exp === "number" ? claims.exp * 1000 : Number.NaN;
    } catch {
      expiryMs = Number.NaN;
    }
  }
  if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) return 300;
  return Math.max(1, Math.min(86_400, Math.floor((expiryMs - nowMs) / 1000)));
}

type StrictJsonResponse = { kind: "empty" } | { kind: "json"; payload: unknown; body: Buffer } | { kind: "invalid" };

async function parseStrictJsonResponse(response: Response): Promise<StrictJsonResponse> {
  if (response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    return { kind: "invalid" };
  }
  if (response.status === 204 || response.status === 205) return { kind: "empty" };
  if (!isJsonMediaType(response.headers.get("content-type"))) {
    await cancelResponseBody(response);
    return { kind: "invalid" };
  }
  const body = await readBoundedResponseBody(response);
  if (!body) return { kind: "invalid" };
  try {
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return { kind: "json", payload, body };
  } catch {
    return { kind: "invalid" };
  }
}

async function sendStrictJsonUpstreamResponse(
  reply: FastifyReply,
  response: Response,
  requestId: string,
  error: string
): Promise<unknown> {
  const parsed = await parseStrictJsonResponse(response);
  if (parsed.kind === "invalid") return reply.code(502).send(envelope({ error }, requestId));
  copySafeCacheHeaders(reply, response);
  if (parsed.kind === "empty") return reply.code(response.status).send();
  return reply.code(response.status).type("application/json; charset=utf-8").send(parsed.body);
}

async function readBoundedResponseBody(response: Response): Promise<Buffer | undefined> {
  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const declaredBytes = Number(declaredLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > UPSTREAM_JSON_BODY_LIMIT_BYTES) {
      await cancelResponseBody(response);
      return undefined;
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength > UPSTREAM_JSON_BODY_LIMIT_BYTES - totalBytes) {
        await cancelReader(reader);
        return undefined;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } catch {
    await cancelReader(reader);
    return undefined;
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is already unusable; cancellation is best-effort cleanup.
  }
}

function copySafeCacheHeaders(reply: FastifyReply, response: Response): void {
  for (const name of SAFE_UPSTREAM_CACHE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) reply.header(name, value);
  }
}

function isJsonMediaType(value: string | null): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim() ?? "";
  return JSON_MEDIA_TYPE_PATTERN.test(mediaType);
}

function unwrapEnvelope(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null && "data" in payload
    ? (payload as { data?: unknown }).data
    : payload;
}

function sanitizeAccessError(payload: unknown, requestId: string) {
  const data = unwrapEnvelope(payload);
  const error =
    typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : "Access request failed";
  return envelope({ error }, requestId);
}
