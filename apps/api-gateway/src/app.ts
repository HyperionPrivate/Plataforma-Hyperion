import { createHash } from "node:crypto";
import { readServiceUrls } from "@hyperion/config";
import {
  authMeSchema,
  envelope,
  platformHealthSchema,
  productModules,
  serviceCatalog,
  serviceHealthSchema,
  tenantIdSchema,
  type AuthMe,
  type HealthStatus,
  type OperatorRole,
  type PlatformHealth,
  type ServiceHealth,
  type ServiceName
} from "@hyperion/contracts";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import type { FastifyReply, FastifyRequest } from "fastify";

interface DownstreamService {
  name: ServiceName;
  url: string;
}

export type SessionResolver = ((token: string) => Promise<AuthMe | undefined>) & {
  invalidate?: (token: string) => void;
};

declare module "fastify" {
  interface FastifyRequest {
    canonicalPath: string;
    canonicalQuery?: string;
    session?: AuthMe;
  }
}

const UPSTREAM_TIMEOUT_MS = 2_500;
const LUMEN_AI_TIMEOUT_MS = 130_000;
const LUMEN_REQUEST_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const HEALTH_CACHE_TTL_MS = 5_000;
const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_CACHE_MAX_ENTRIES = 1_000;

type HttpMethod = "GET" | "POST" | "PATCH";

const PUBLIC_PATHS = new Set(["/v1/auth/login"]);

let healthCache: { expiresAt: number; payload: PlatformHealth } | undefined;

export function createGatewayRoutes(overrides?: { resolveSession?: SessionResolver }): RouteRegistrar {
  return async (app) => {
    const urls = readServiceUrls();
    const resolveSession = overrides?.resolveSession ?? createCachedSessionResolver(urls.identity);

    // Authenticate before Fastify parses potentially large LUMEN audio payloads.
    app.addHook("onRequest", async (request, reply) => {
      const requestTarget = canonicalizeRequestTarget(request.raw.url ?? request.url);
      if (!requestTarget) {
        return reply.code(400).send(envelope({ error: "Invalid request path" }, request.id));
      }

      request.canonicalPath = requestTarget.path;
      request.canonicalQuery = requestTarget.query;

      const path = requestTarget.path;
      if (!path.startsWith("/v1/") || PUBLIC_PATHS.has(path)) {
        return;
      }

      const token = readBearerToken(request.headers.authorization);
      if (!token) {
        return reply.code(401).send(envelope({ error: "Authentication required" }, request.id));
      }

      const session = await resolveSession(token);
      if (!session) {
        return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
      }

      request.session = session;

      const denial = authorizeRequest(request.method as HttpMethod, path, session.operator.role);
      if (denial) {
        return reply.code(403).send(envelope({ error: denial }, request.id));
      }

      const tenantMatch = path.match(/^\/v1\/tenants\/([^/]+)\//);
      if (tenantMatch) {
        const requestedTenant = decodeURIComponent(tenantMatch[1] ?? "");
        const isAdmin = session.operator.role === "admin";
        if (!isAdmin && !session.tenantIds.includes(requestedTenant)) {
          return reply.code(403).send(envelope({ error: "Forbidden for this tenant" }, request.id));
        }
      }
    });

    app.post(
      "/v1/auth/login",
      { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
      async (request, reply) => {
        return proxyJson(request, reply, buildUpstreamUrl(urls.identity, request), "POST", request.body);
      }
    );

    app.get("/v1/auth/me", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.identity, request), "GET");
    });

    app.post("/v1/auth/logout", async (request, reply) => {
      const token = readBearerToken(request.headers.authorization);
      return proxyJson(
        request,
        reply,
        buildUpstreamUrl(urls.identity, request),
        "POST",
        undefined,
        UPSTREAM_TIMEOUT_MS,
        () => {
          if (token) resolveSession.invalidate?.(token);
        }
      );
    });

    app.get("/v1/identity/operators", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.identity, request), "GET");
    });

    app.post("/v1/identity/operators", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.identity, request), "POST", request.body);
    });

    app.patch("/v1/identity/operators/:operatorId", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.identity, request), "PATCH", request.body);
    });

    app.get("/v1/platform/catalog", async (request) => {
      return envelope(
        {
          services: serviceCatalog,
          productModules
        },
        request.id
      );
    });

    app.get("/v1/pulso-iris/health", async (request, reply) => {
      return proxyGet(request, reply, buildUpstreamUrl(urls.pulsoIris, request));
    });

    app.get("/v1/pulso-iris/catalog", async (request, reply) => {
      return proxyGet(request, reply, buildUpstreamUrl(urls.pulsoIris, request));
    });

    app.get("/v1/lumen/health", async (request, reply) => {
      return proxyGet(request, reply, buildUpstreamUrl(urls.lumen, request));
    });

    app.get("/v1/lumen/catalog", async (request, reply) => {
      return proxyGet(request, reply, buildUpstreamUrl(urls.lumen, request));
    });

    app.get("/v1/tenants", async (request, reply) => {
      try {
        const response = await fetch(buildUpstreamUrl(urls.tenant, request), {
          headers: { "x-request-id": request.id },
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
        });
        const payload = (await response.json()) as { data?: unknown };
        if (!response.ok) {
          return reply.code(response.status).send(payload);
        }

        const rows = Array.isArray(payload.data) ? payload.data : [];
        const session = request.session;
        const visible =
          session && session.operator.role !== "admin"
            ? rows.filter(
                (row) =>
                  typeof row === "object" &&
                  row !== null &&
                  session.tenantIds.includes(String((row as { id?: unknown }).id))
              )
            : rows;

        return envelope(visible, request.id);
      } catch {
        return reply.code(502).send(envelope({ error: "Upstream service unavailable" }, request.id));
      }
    });

    app.get("/v1/tenants/:tenantId/integrations/whatsapp/status", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.integration, request), "GET");
    });

    app.post("/v1/tenants/:tenantId/integrations/whatsapp/connect", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.integration, request), "POST", request.body ?? {});
    });

    app.get("/v1/tenants/:tenantId/integrations/whatsapp/qr", async (request, reply) => {
      reply.header("cache-control", "no-store, private, max-age=0");
      reply.header("pragma", "no-cache");
      reply.header("expires", "0");
      return proxyJson(request, reply, buildUpstreamUrl(urls.integration, request), "GET");
    });

    app.post("/v1/tenants/:tenantId/integrations/whatsapp/disconnect", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.integration, request), "POST", request.body ?? {});
    });

    app.get("/v1/tenants/:tenantId/pulso-iris/sofia/readiness", async (request, reply) => {
      return proxyJson(request, reply, buildUpstreamUrl(urls.integration, request), "GET");
    });

    // Proxy generico de PULSO IRIS: la validacion de tenant y la membresia
    // operador-tenant ya ocurrieron en el preHandler.
    app.route({
      method: ["GET", "POST", "PATCH"],
      url: "/v1/tenants/:tenantId/pulso-iris/*",
      handler: async (request, reply) => {
        const tenantId = tenantIdSchema.safeParse(readCanonicalTenantId(request.canonicalPath));
        if (!tenantId.success) {
          return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
        }

        const method = request.method as "GET" | "POST" | "PATCH";
        return proxyJson(
          request,
          reply,
          buildUpstreamUrl(urls.pulsoIris, request, true),
          method,
          method === "GET" ? undefined : request.body
        );
      }
    });

    app.route({
      method: ["GET", "POST", "PATCH"],
      url: "/v1/tenants/:tenantId/lumen/*",
      bodyLimit: LUMEN_REQUEST_BODY_LIMIT_BYTES,
      handler: async (request, reply) => {
        const tenantId = tenantIdSchema.safeParse(readCanonicalTenantId(request.canonicalPath));
        if (!tenantId.success) {
          return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
        }

        const method = request.method as "GET" | "POST" | "PATCH";
        return proxyJson(
          request,
          reply,
          buildUpstreamUrl(urls.lumen, request, true),
          method,
          method === "GET" ? undefined : request.body,
          LUMEN_AI_TIMEOUT_MS
        );
      }
    });

    app.get("/v1/platform/health", async () => {
      const now = Date.now();
      if (healthCache && healthCache.expiresAt > now) {
        return healthCache.payload;
      }

      const services = buildRegistry();
      const health = await Promise.all(services.map((service) => fetchServiceHealth(service)));
      const status = summarize(health);

      const payload = platformHealthSchema.parse({
        status,
        checkedAt: new Date().toISOString(),
        services: health
      });

      healthCache = { expiresAt: now + HEALTH_CACHE_TTL_MS, payload };
      return payload;
    });
  };
}

export const registerRoutes: RouteRegistrar = createGatewayRoutes();

function canonicalizeRequestTarget(rawTarget: string): { path: string; query?: string } | undefined {
  const queryStart = rawTarget.indexOf("?");
  const rawPath = queryStart === -1 ? rawTarget : rawTarget.slice(0, queryStart);
  const query = queryStart === -1 ? undefined : rawTarget.slice(queryStart + 1);

  if (!rawPath.startsWith("/") || rawPath.includes("\\") || containsControlCharacters(rawPath)) {
    return undefined;
  }

  if (rawPath === "/") {
    return { path: rawPath, query };
  }

  const rawSegments = rawPath.slice(1).split("/");
  if (rawSegments.at(-1) === "") {
    rawSegments.pop();
  }
  if (rawSegments.length === 0 || rawSegments.some((segment) => segment.length === 0)) {
    return undefined;
  }

  const canonicalSegments: string[] = [];
  for (const rawSegment of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment).normalize("NFC");
    } catch {
      return undefined;
    }

    // Structural delimiters, dot segments, controls and a remaining percent
    // can be interpreted differently (or decoded again) by another HTTP hop.
    if (
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("%") ||
      /[\\/?#;]/.test(decoded) ||
      containsControlCharacters(decoded)
    ) {
      return undefined;
    }

    canonicalSegments.push(encodeURIComponent(decoded));
  }

  return { path: `/${canonicalSegments.join("/")}`, query };
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function readCanonicalTenantId(path: string): string | undefined {
  const match = path.match(/^\/v1\/tenants\/([^/]+)(?:\/|$)/);
  return match ? decodeURIComponent(match[1] ?? "") : undefined;
}

function buildUpstreamUrl(baseUrl: string, request: FastifyRequest, includeQuery = false): string {
  const query = includeQuery && request.canonicalQuery !== undefined ? `?${request.canonicalQuery}` : "";
  return `${baseUrl}${request.canonicalPath}${query}`;
}

function readBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length >= 20 ? token : undefined;
}

function authorizeRequest(method: HttpMethod, path: string, role: OperatorRole): string | undefined {
  if (role === "admin") {
    return undefined;
  }

  if (method === "GET") {
    if (path.includes("/integrations/whatsapp/") || path.endsWith("/pulso-iris/sofia/readiness")) {
      return role === "coordinator" ? undefined : "Admin or coordinator role required";
    }
    return undefined;
  }

  if (path === "/v1/auth/logout") {
    return undefined;
  }

  if (path.startsWith("/v1/identity/operators")) {
    return "Admin role required";
  }

  if (role === "auditor") {
    return "Read-only role";
  }

  if (path.includes("/integrations/whatsapp/")) {
    return "Admin role required";
  }

  if (path.includes("/pulso-iris/config/")) {
    return role === "coordinator" ? undefined : "Coordinator role required";
  }

  const appointmentAction = /\/pulso-iris\/appointments\/[^/]+\/(manual-verify|reject|cancel|reschedule)$/.test(path);
  const appointmentPatch = method === "PATCH" && /\/pulso-iris\/appointments\/[^/]+$/.test(path);
  if (appointmentAction || appointmentPatch) {
    return role === "coordinator" ? undefined : "Coordinator role required";
  }

  if (path.includes("/pulso-iris/campaigns") || path.includes("/pulso-iris/rpa/actions")) {
    return role === "coordinator" ? undefined : "Coordinator role required";
  }

  if (path.includes("/pulso-iris/")) {
    return role === "coordinator" || role === "advisor" ? undefined : "Forbidden";
  }

  if (path.includes("/lumen/")) {
    return role === "coordinator" || role === "advisor" ? undefined : "Forbidden";
  }

  return "Forbidden";
}

function createCachedSessionResolver(identityUrl: string): SessionResolver {
  const cache = new Map<string, { expiresAt: number; session: AuthMe }>();
  const tokenStates = new Map<string, { activeRequests: number; generation: number }>();

  const resolve: SessionResolver = async (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.session;
    }

    const tokenState = tokenStates.get(key) ?? { activeRequests: 0, generation: 0 };
    tokenStates.set(key, tokenState);
    tokenState.activeRequests += 1;
    const requestGeneration = tokenState.generation;
    try {
      const response = await fetch(`${identityUrl}/v1/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });

      if (!response.ok) {
        cache.delete(key);
        return undefined;
      }

      const payload = (await response.json()) as { data?: unknown };
      const session = authMeSchema.parse(payload.data);

      // A logout completed while this lookup was in flight. Do not authorize
      // the request or repopulate a token that has just been invalidated.
      if (requestGeneration !== tokenState.generation) {
        return undefined;
      }

      if (cache.size >= SESSION_CACHE_MAX_ENTRIES) {
        cache.clear();
      }
      cache.set(key, { expiresAt: Date.now() + SESSION_CACHE_TTL_MS, session });

      return session;
    } catch {
      return undefined;
    } finally {
      tokenState.activeRequests -= 1;
      if (tokenState.activeRequests === 0 && tokenStates.get(key) === tokenState) {
        tokenStates.delete(key);
      }
    }
  };

  resolve.invalidate = (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    const tokenState = tokenStates.get(key);
    if (tokenState) tokenState.generation += 1;
    cache.delete(key);
  };

  return resolve;
}

function buildRegistry(): DownstreamService[] {
  const urls = readServiceUrls();

  return [
    { name: "identity-service", url: urls.identity },
    { name: "tenant-service", url: urls.tenant },
    { name: "agent-service", url: urls.agent },
    { name: "prompt-flow-service", url: urls.promptFlow },
    { name: "knowledge-service", url: urls.knowledge },
    { name: "audit-service", url: urls.audit },
    { name: "integration-service", url: urls.integration },
    { name: "pulso-iris-service", url: urls.pulsoIris },
    { name: "whatsapp-channel-service", url: urls.whatsappChannel },
    { name: "lumen-service", url: urls.lumen }
  ];
}

async function proxyGet(request: FastifyRequest, reply: FastifyReply, url: string): Promise<unknown> {
  try {
    const response = await fetch(url, {
      headers: { "x-request-id": request.id },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    const payload = await response.json();

    return reply.code(response.status).send(payload);
  } catch {
    return reply.code(502).send(envelope({ error: "Upstream service unavailable" }, request.id));
  }
}

async function proxyJson(
  request: FastifyRequest,
  reply: FastifyReply,
  url: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
  onUpstreamSuccess?: () => void
): Promise<unknown> {
  const requestAbort = createRequestAbortSignal(request, reply);
  try {
    const headers: Record<string, string> = { "x-request-id": request.id };
    if (request.headers.authorization) {
      headers.authorization = request.headers.authorization;
    }
    if (request.session) {
      headers["x-operator-id"] = request.session.operator.id;
      headers["x-operator-role"] = request.session.operator.role;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(timeoutMs)])
    });
    if (response.ok) {
      onUpstreamSuccess?.();
    }
    const payload = await response.json();

    return reply.code(response.status).send(payload);
  } catch {
    if (requestAbort.signal.aborted && reply.raw.destroyed) return undefined;
    return reply.code(502).send(envelope({ error: "Upstream service unavailable" }, request.id));
  } finally {
    requestAbort.cleanup();
  }
}

function createRequestAbortSignal(
  request: FastifyRequest,
  reply: FastifyReply
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abortRequest = () => controller.abort(new DOMException("Client request aborted", "AbortError"));
  const abortResponse = () => {
    if (!reply.raw.writableEnded) abortRequest();
  };

  request.raw.once("aborted", abortRequest);
  reply.raw.once("close", abortResponse);

  return {
    signal: controller.signal,
    cleanup: () => {
      request.raw.off("aborted", abortRequest);
      reply.raw.off("close", abortResponse);
    }
  };
}

async function fetchServiceHealth(service: DownstreamService): Promise<ServiceHealth> {
  const started = performance.now();

  try {
    const response = await fetch(`${service.url}/ready`, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    const payload = await response.json();
    const parsed = serviceHealthSchema.parse(payload);

    if (!response.ok || parsed.status !== "ok") {
      return {
        ...parsed,
        status: parsed.status === "ok" ? "degraded" : parsed.status
      };
    }

    return parsed;
  } catch (error) {
    return {
      service: service.name,
      status: "down",
      version: "unknown",
      checkedAt: new Date().toISOString(),
      uptimeSeconds: 0,
      dependencies: [
        {
          name: "http",
          status: "down",
          latencyMs: Math.round(performance.now() - started),
          detail: error instanceof Error ? error.message : String(error)
        }
      ]
    };
  }
}

function summarize(services: ServiceHealth[]): HealthStatus {
  if (services.length === 0) {
    return "degraded";
  }

  if (services.every((service) => service.status === "ok")) {
    return "ok";
  }

  if (services.every((service) => service.status === "down")) {
    return "down";
  }

  return "degraded";
}
