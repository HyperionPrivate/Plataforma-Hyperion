import cors from "@fastify/cors";
import { readServiceConfig, type ServiceConfig } from "@hyperion/config";
import { type ServiceHealth, type ServiceName, serviceHealthSchema } from "@hyperion/contracts";
import { checkDatabase, createDatabase, type DatabaseClient } from "@hyperion/database";
import { createLogger, type Logger } from "@hyperion/logger";
import Fastify, { type FastifyInstance } from "fastify";

export interface ServiceContext {
  config: ServiceConfig;
  db?: DatabaseClient;
  logger: Logger;
}

export type RouteRegistrar = (app: FastifyInstance, context: ServiceContext) => Promise<void> | void;

export interface RuntimeOptions {
  serviceName: ServiceName;
  databaseRequired?: boolean;
  registerRoutes?: RouteRegistrar;
}

export async function createService(options: RuntimeOptions): Promise<FastifyInstance> {
  const config = readServiceConfig(options.serviceName);
  const logger = createLogger(options.serviceName);
  const app = Fastify({
    logger: false,
    trustProxy: true
  });

  if (config.corsAllowedOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsAllowedOrigins,
      credentials: true
    });
  }

  const db = config.databaseUrl ? createDatabase(config.databaseUrl) : undefined;
  const context: ServiceContext = { config, db, logger };

  app.get("/health", async () => {
    return buildHealth(options.serviceName, config.serviceVersion, "ok");
  });

  app.get("/ready", async () => {
    if (!db) {
      const status = options.databaseRequired ? "down" : "ok";
      return buildHealth(options.serviceName, config.serviceVersion, status, [{
        name: "postgres",
        status,
        detail: options.databaseRequired ? "DATABASE_URL is required" : "not configured"
      }]);
    }

    try {
      const latencyMs = await checkDatabase(db);
      return buildHealth(options.serviceName, config.serviceVersion, "ok", [{
        name: "postgres",
        status: "ok",
        latencyMs
      }]);
    } catch (error) {
      logger.error("database readiness failed", { error: error instanceof Error ? error.message : String(error) });
      return buildHealth(options.serviceName, config.serviceVersion, "down", [{
        name: "postgres",
        status: "down",
        detail: "database readiness failed"
      }]);
    }
  });

  if (options.registerRoutes) {
    await options.registerRoutes(app, context);
  }

  app.addHook("onClose", async () => {
    await db?.close();
  });

  return app;
}

export async function startService(options: RuntimeOptions): Promise<void> {
  const app = await createService(options);
  const config = readServiceConfig(options.serviceName);
  const logger = createLogger(options.serviceName);

  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info("service started", { host: config.host, port: config.port });
  } catch (error) {
    logger.error("service failed to start", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}

function buildHealth(
  service: ServiceName,
  version: string,
  status: ServiceHealth["status"],
  dependencies: ServiceHealth["dependencies"] = []
): ServiceHealth {
  return serviceHealthSchema.parse({
    service,
    status,
    version,
    checkedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    dependencies
  });
}
