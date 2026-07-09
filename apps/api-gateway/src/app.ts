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

export type SessionResolver = (token: string) => Promise<AuthMe | undefined>;

const UPSTREAM_TIMEOUT_MS = 2_500;
const HEALTH_CACHE_TTL_MS = 5_000;
const SESSION_CACHE_TTL_MS = 30_000;
const SESSION_CACHE_MAX_ENTRIES = 1_000;

let healthCache: { expiresAt: number; payload: PlatformHealth } | undefined;

export function createGatewayRoutes(overrides?: { resolveSession?: SessionResolver }): RouteRegistrar {
  return async (app) => {
    const urls = readServiceUrls();
    const resolveSession = overrides?.resolveSession ?? createCachedSessionResolver(urls.identity);

    app.addHook("preHandler", async (request, reply) => {
      const path = (request.raw.url ?? request.url).split("?")[0] ?? "";
      if (!path.startsWith("/v1/") || path === "/v1/auth/login") {
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
        return proxyJson(request, reply, `${urls.identity}/v1/auth/login`, "POST", request.body);
      }
    );

    app.get("/v1/auth/me", async (request, reply) => {
      return proxyJson(request, reply, `${urls.identity}/v1/auth/me`, "GET");
    });

    app.post("/v1/auth/logout", async (request, reply) => {
      return proxyJson(request, reply, `${urls.identity}/v1/auth/logout`, "POST");
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
      return proxyGet(request, reply, `${urls.pulsoIris}/v1/pulso-iris/health`);
    });

    app.get("/v1/pulso-iris/catalog", async (request, reply) => {
      return proxyGet(request, reply, `${urls.pulsoIris}/v1/pulso-iris/catalog`);
    });

    const tenantProxyRoutes = [
      { path: "/v1/tenants/:tenantId/pulso-iris/overview", suffix: "overview" },
      { path: "/v1/tenants/:tenantId/pulso-iris/conversations", suffix: "conversations" },
      { path: "/v1/tenants/:tenantId/pulso-iris/appointments", suffix: "appointments" },
      { path: "/v1/tenants/:tenantId/pulso-iris/handoffs", suffix: "handoffs" },
      { path: "/v1/tenants/:tenantId/pulso-iris/rpa/actions", suffix: "rpa/actions" }
    ] as const;

    for (const route of tenantProxyRoutes) {
      app.get(route.path, async (request, reply) => {
        const params = request.params as { tenantId?: unknown };
        const tenantId = tenantIdSchema.safeParse(params.tenantId);
        if (!tenantId.success) {
          return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
        }

        const target = `${urls.pulsoIris}/v1/tenants/${encodeURIComponent(tenantId.data)}/pulso-iris/${route.suffix}`;
        return proxyGet(request, reply, target);
      });
    }

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

function readBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) {
    return undefined;
  }

  const token = authorization.slice("Bearer ".length).trim();
  return token.length >= 20 ? token : undefined;
}

function createCachedSessionResolver(identityUrl: string): SessionResolver {
  const cache = new Map<string, { expiresAt: number; session: AuthMe }>();

  return async (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.session;
    }

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

      if (cache.size >= SESSION_CACHE_MAX_ENTRIES) {
        cache.clear();
      }
      cache.set(key, { expiresAt: Date.now() + SESSION_CACHE_TTL_MS, session });

      return session;
    } catch {
      return undefined;
    }
  };
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
    { name: "pulso-iris-service", url: urls.pulsoIris }
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
  method: "GET" | "POST",
  body?: unknown
): Promise<unknown> {
  try {
    const headers: Record<string, string> = { "x-request-id": request.id };
    if (request.headers.authorization) {
      headers.authorization = request.headers.authorization;
    }
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    });
    const payload = await response.json();

    return reply.code(response.status).send(payload);
  } catch {
    return reply.code(502).send(envelope({ error: "Upstream service unavailable" }, request.id));
  }
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
