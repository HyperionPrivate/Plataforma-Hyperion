import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
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

export interface ServiceHandle {
  app: FastifyInstance;
  context: ServiceContext;
}

export type RouteRegistrar = (app: FastifyInstance, context: ServiceContext) => Promise<void> | void;

export interface RuntimeOptions {
  serviceName: ServiceName;
  databaseRequired?: boolean;
  requiredMigrations?: string[];
  /**
   * Marks the service as the public HTTP surface: enables security headers
   * and per-IP rate limiting. Internal services stay lean.
   */
  publicApi?: boolean;
  registerRoutes?: RouteRegistrar;
  createDatabase?: (connectionString: string) => DatabaseClient;
}

const SHUTDOWN_TIMEOUT_MS = 10_000;
const ACCESS_LOG_EXCLUDED_PATHS = new Set(["/health", "/ready"]);

export async function createService(options: RuntimeOptions): Promise<ServiceHandle> {
  const config = readServiceConfig(options.serviceName);
  const logger = createLogger(options.serviceName);
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 1_048_576,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID()
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    const path = (request.raw.url ?? request.url).split("?")[0] ?? "";
    if (ACCESS_LOG_EXCLUDED_PATHS.has(path)) {
      return;
    }

    logger.info("request completed", {
      requestId: request.id,
      method: request.method,
      path,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime)
    });
  });

  if (options.publicApi) {
    await app.register(helmet, {
      // API-only surface: CSP is irrelevant and breaks nothing by being off.
      contentSecurityPolicy: false
    });
    await app.register(rateLimit, {
      max: 300,
      timeWindow: "1 minute"
    });
  }

  if (config.corsAllowedOrigins.length > 0) {
    await app.register(cors, {
      origin: config.corsAllowedOrigins,
      credentials: true
    });
  }

  const db = config.databaseUrl ? (options.createDatabase ?? createDatabase)(config.databaseUrl) : undefined;
  const context: ServiceContext = { config, db, logger };

  app.get("/health", async () => {
    return buildHealth(options.serviceName, config.serviceVersion, "ok");
  });

  app.get("/ready", async () => {
    if (!db) {
      const status = options.databaseRequired ? "down" : "ok";
      return buildHealth(options.serviceName, config.serviceVersion, status, [
        {
          name: "postgres",
          status,
          detail: options.databaseRequired ? "DATABASE_URL is required" : "not configured"
        }
      ]);
    }

    try {
      const latencyMs = await checkDatabase(db);
      const dependencies: ServiceHealth["dependencies"] = [
        {
          name: "postgres",
          status: "ok",
          latencyMs
        }
      ];

      const missingMigration = await findMissingMigration(db, options.requiredMigrations ?? []);
      if (missingMigration) {
        dependencies.push({
          name: "schema_migrations",
          status: "down",
          detail: `missing migration: ${missingMigration}`
        });

        return buildHealth(options.serviceName, config.serviceVersion, "down", dependencies);
      }

      if ((options.requiredMigrations ?? []).length > 0) {
        dependencies.push({
          name: "schema_migrations",
          status: "ok",
          detail: "required migrations applied"
        });
      }

      return buildHealth(options.serviceName, config.serviceVersion, "ok", dependencies);
    } catch (error) {
      logger.error("database readiness failed", { error: error instanceof Error ? error.message : String(error) });
      return buildHealth(options.serviceName, config.serviceVersion, "down", [
        {
          name: "postgres",
          status: "down",
          detail: "database readiness failed"
        }
      ]);
    }
  });

  if (options.registerRoutes) {
    await options.registerRoutes(app, context);
  }

  app.addHook("onClose", async () => {
    await db?.close();
  });

  return { app, context };
}

async function findMissingMigration(db: DatabaseClient, requiredMigrations: string[]): Promise<string | undefined> {
  if (requiredMigrations.length === 0) {
    return undefined;
  }

  try {
    const result = await db.query<{ name: string }>(
      "select name from platform.schema_migrations where name = any($1::text[])",
      [requiredMigrations]
    );
    const applied = new Set(result.rows.map((row) => row.name));
    return requiredMigrations.find((name) => !applied.has(name));
  } catch {
    return requiredMigrations[0];
  }
}

export async function startService(options: RuntimeOptions): Promise<void> {
  const { app, context } = await createService(options);
  const { config, logger } = context;

  try {
    await app.listen({ host: config.host, port: config.port });
    logger.info("service started", { host: config.host, port: config.port });
  } catch (error) {
    logger.error("service failed to start", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info("shutdown signal received", { signal });

    const failsafe = setTimeout(() => {
      logger.error("shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    failsafe.unref();

    app.close().then(
      () => {
        logger.info("service stopped");
        process.exit(0);
      },
      (error: unknown) => {
        logger.error("shutdown failed", { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      }
    );
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
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
