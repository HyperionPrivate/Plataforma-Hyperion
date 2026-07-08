import { readServiceUrls } from "@hyperion/config";
import {
  envelope,
  platformHealthSchema,
  productModules,
  serviceCatalog,
  serviceHealthSchema,
  tenantIdSchema,
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

const UPSTREAM_TIMEOUT_MS = 2_500;
const HEALTH_CACHE_TTL_MS = 5_000;

let healthCache: { expiresAt: number; payload: PlatformHealth } | undefined;

export const registerRoutes: RouteRegistrar = async (app) => {
  const urls = readServiceUrls();

  app.get("/v1/platform/catalog", async (request) => {
    return envelope({
      services: serviceCatalog,
      productModules
    }, request.id);
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
      dependencies: [{
        name: "http",
        status: "down",
        latencyMs: Math.round(performance.now() - started),
        detail: error instanceof Error ? error.message : String(error)
      }]
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
