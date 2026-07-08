import { readServiceUrls } from "@hyperion/config";
import {
  envelope,
  platformHealthSchema,
  productModules,
  serviceCatalog,
  serviceHealthSchema,
  type HealthStatus,
  type ServiceHealth,
  type ServiceName
} from "@hyperion/contracts";
import { startService, type RouteRegistrar } from "@hyperion/service-runtime";

interface DownstreamService {
  name: ServiceName;
  url: string;
}

const registerRoutes: RouteRegistrar = async (app) => {
  app.get("/v1/platform/catalog", async (request) => {
    return envelope({
      services: serviceCatalog,
      productModules
    }, request.id);
  });

  app.get("/v1/platform/health", async () => {
    const services = buildRegistry();
    const health = await Promise.all(services.map((service) => fetchServiceHealth(service)));
    const status = summarize(health);

    return platformHealthSchema.parse({
      status,
      checkedAt: new Date().toISOString(),
      services: health
    });
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
    { name: "integration-service", url: urls.integration }
  ];
}

async function fetchServiceHealth(service: DownstreamService): Promise<ServiceHealth> {
  const started = performance.now();

  try {
    const response = await fetch(`${service.url}/ready`, {
      signal: AbortSignal.timeout(2_500)
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
  if (services.every((service) => service.status === "ok")) {
    return "ok";
  }

  if (services.every((service) => service.status === "down")) {
    return "down";
  }

  return "degraded";
}

await startService({
  serviceName: "api-gateway",
  databaseRequired: false,
  registerRoutes
});
