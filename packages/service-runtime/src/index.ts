import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { assertNoPlaceholderSecrets, readServiceConfig, type ServiceConfig } from "@hyperion/config";
import { type ServiceHealth, type ServiceName, serviceHealthSchema } from "@hyperion/contracts";
import { checkDatabase, createDatabase, type DatabaseClient } from "@hyperion/database";
import { createLogger, type Logger } from "@hyperion/logger";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { assertJetStreamProductionGate } from "./jetstream-production-gate.js";
import { resolveShutdownTimeoutMs, resolveTrustedProxies } from "./runtime-config.js";

export {
  INTERNAL_CALLER_HEADER,
  createInternalAuthorizationHeaders,
  readInternalCaller,
  readInternalCredential,
  validateInternalAuthorization,
  type InternalAuthorizationFailure,
  type InternalCredentialMap,
  type InternalRequestHeaders
} from "./internal-auth.js";
export { assertJetStreamProductionGate } from "./jetstream-production-gate.js";
export {
  assertNoPlaceholderSecrets,
  ENV_EXAMPLE_PLACEHOLDER_VALUES,
  findPlaceholderSecretProblems,
  isPlaceholderSecret,
  REQUIRED_SECRET_ENV_KEYS,
  shouldEnforcePlaceholderRejection
} from "@hyperion/config";

export interface ServiceContext {
  config: ServiceConfig;
  db?: DatabaseClient;
  logger: Logger;
  /** Registers a passive dependency check included in `/ready`. */
  registerReadinessCheck?: (check: RuntimeReadinessCheck) => void;
}

export interface RuntimeReadinessCheck {
  readonly name: string;
  readonly check: () => Promise<void> | void;
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
  requiredSchemaVersion?: SchemaVersionRequirement;
  /**
   * Marks the service as the public HTTP surface: enables security headers
   * and per-IP rate limiting. Internal services stay lean.
   */
  publicApi?: boolean;
  registerRoutes?: RouteRegistrar;
  createDatabase?: (connectionString: string) => DatabaseClient;
  /**
   * Grace period for all onClose hooks. It cannot be shorter than the
   * runtime's supported dispatcher drain budget.
   */
  shutdownTimeoutMs?: number;
}

export interface SchemaVersionRequirement {
  /** Schema owned by the service; the table name is always schema_version. */
  schema: string;
  /** Logical service key stored in schema_version.service_name. */
  serviceName: string;
  minimumVersion: number;
}

const ACCESS_LOG_EXCLUDED_PATHS = new Set(["/health", "/ready"]);
const RESERVED_READINESS_NAMES = new Set(["postgres", "postgres_role", "schema_migrations"]);
const READINESS_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const DATABASE_ROLE_BY_SERVICE: Partial<Record<ServiceName, string>> = {
  "identity-service": "hyperion_access",
  "tenant-service": "hyperion_access",
  "agent-service": "hyperion_sofia",
  "prompt-flow-service": "hyperion_sofia",
  "knowledge-service": "hyperion_knowledge",
  "audit-service": "hyperion_audit",
  "integration-service": "hyperion_integration",
  "pulso-iris-service": "hyperion_pulso",
  "whatsapp-channel-service": "hyperion_channel",
  "lumen-service": "hyperion_lumen"
};

export async function createService(options: RuntimeOptions): Promise<ServiceHandle> {
  assertNoPlaceholderSecrets(process.env);
  assertJetStreamProductionGate(process.env);
  const requiredSchemaVersion = normalizeSchemaVersionRequirement(options.requiredSchemaVersion);
  const config = readServiceConfig(options.serviceName);
  const expectedDatabaseRole = normalizeExpectedDatabaseRole(process.env.EXPECTED_DATABASE_ROLE);
  const normativeDatabaseRole = DATABASE_ROLE_BY_SERVICE[options.serviceName];
  if (config.databaseUrl && expectedDatabaseRole && expectedDatabaseRole !== normativeDatabaseRole) {
    throw new Error("EXPECTED_DATABASE_ROLE does not match the service database identity");
  }
  if (config.databaseUrl && config.environment === "production" && !expectedDatabaseRole) {
    throw new Error("EXPECTED_DATABASE_ROLE is required for a production database connection");
  }
  const logger = createLogger(options.serviceName);
  const readinessChecks = new Map<string, RuntimeReadinessCheck["check"]>();
  const trustedProxies = resolveTrustedProxies(process.env.TRUST_PROXY);
  const app = Fastify({
    logger: false,
    trustProxy: trustedProxies,
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
  if (db && expectedDatabaseRole) {
    const databaseRoleProblem = await findDatabaseRoleProblem(db, expectedDatabaseRole);
    if (databaseRoleProblem) {
      await db.close();
      await app.close();
      throw new Error(`database identity verification failed: ${databaseRoleProblem}`);
    }
  }
  const context: ServiceContext = {
    config,
    db,
    logger,
    registerReadinessCheck: (check) => registerRuntimeReadinessCheck(readinessChecks, check)
  };

  let databaseClosePromise: Promise<void> | undefined;
  const closeDatabase = (): Promise<void> => {
    if (!db) return Promise.resolve();
    databaseClosePromise ??= Promise.resolve().then(async () => db.close());
    return databaseClosePromise;
  };

  // Fastify/Avvio closes hooks in reverse registration order. Register the
  // pool first so route-owned dispatchers registered later drain before it.
  app.addHook("onClose", async () => {
    await closeDatabase();
  });

  app.get("/health", async () => {
    return buildHealth(options.serviceName, config.serviceVersion, "ok");
  });

  app.get("/ready", async (_request, reply) => {
    if (!db) {
      const status = options.databaseRequired ? "down" : "ok";
      return sendReadiness(
        reply,
        buildReadinessHealth(
          options.serviceName,
          config.serviceVersion,
          status,
          [
            {
              name: "postgres",
              status,
              detail: options.databaseRequired ? "DATABASE_URL is required" : "not configured"
            }
          ],
          readinessChecks
        )
      );
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

      if (expectedDatabaseRole) {
        const databaseRoleProblem = await findDatabaseRoleProblem(db, expectedDatabaseRole);
        if (databaseRoleProblem) {
          dependencies.push({
            name: "postgres_role",
            status: "down",
            detail: databaseRoleProblem
          });
          return sendReadiness(
            reply,
            buildReadinessHealth(options.serviceName, config.serviceVersion, "down", dependencies, readinessChecks)
          );
        }

        dependencies.push({
          name: "postgres_role",
          status: "ok",
          detail: `connected as ${expectedDatabaseRole}`
        });
      }

      const missingMigration = await findMissingMigration(db, options.requiredMigrations ?? []);
      if (missingMigration) {
        dependencies.push({
          name: "schema_migrations",
          status: "down",
          detail: `missing migration: ${missingMigration}`
        });

        return sendReadiness(
          reply,
          buildReadinessHealth(options.serviceName, config.serviceVersion, "down", dependencies, readinessChecks)
        );
      }

      if ((options.requiredMigrations ?? []).length > 0) {
        dependencies.push({
          name: "schema_migrations",
          status: "ok",
          detail: "required migrations applied"
        });
      }

      if (requiredSchemaVersion) {
        const schemaVersionProblem = await findSchemaVersionProblem(db, requiredSchemaVersion);
        const dependencyName = `${requiredSchemaVersion.schema}.schema_version`;
        if (schemaVersionProblem) {
          dependencies.push({
            name: dependencyName,
            status: "down",
            detail: schemaVersionProblem
          });
          return sendReadiness(
            reply,
            buildReadinessHealth(options.serviceName, config.serviceVersion, "down", dependencies, readinessChecks)
          );
        }

        dependencies.push({
          name: dependencyName,
          status: "ok",
          detail: `schema version >= ${requiredSchemaVersion.minimumVersion}`
        });
      }

      return sendReadiness(
        reply,
        buildReadinessHealth(options.serviceName, config.serviceVersion, "ok", dependencies, readinessChecks)
      );
    } catch (error) {
      logger.error("database readiness failed", { error: error instanceof Error ? error.message : String(error) });
      return sendReadiness(
        reply,
        buildReadinessHealth(
          options.serviceName,
          config.serviceVersion,
          "down",
          [
            {
              name: "postgres",
              status: "down",
              detail: "database readiness failed"
            }
          ],
          readinessChecks
        )
      );
    }
  });

  if (options.registerRoutes) {
    try {
      await options.registerRoutes(app, context);
    } catch (error) {
      try {
        await app.close();
      } finally {
        await closeDatabase();
      }
      throw error;
    }
  }

  return { app, context };
}

async function sendReadiness(
  reply: FastifyReply,
  pendingHealth: ServiceHealth | Promise<ServiceHealth>
): Promise<FastifyReply> {
  const health = await pendingHealth;
  return reply.code(health.status === "ok" ? 200 : 503).send(health);
}

function registerRuntimeReadinessCheck(
  checks: Map<string, RuntimeReadinessCheck["check"]>,
  value: RuntimeReadinessCheck
): void {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.name !== "string" ||
    !READINESS_NAME_PATTERN.test(value.name) ||
    typeof value.check !== "function"
  ) {
    throw new TypeError("readiness check must have a safe name and a check function");
  }
  if (RESERVED_READINESS_NAMES.has(value.name) || checks.has(value.name)) {
    throw new Error("readiness check name is reserved or already registered");
  }
  checks.set(value.name, value.check);
}

async function buildReadinessHealth(
  service: ServiceName,
  version: string,
  baseStatus: ServiceHealth["status"],
  dependencies: ServiceHealth["dependencies"],
  checks: ReadonlyMap<string, RuntimeReadinessCheck["check"]>
): Promise<ServiceHealth> {
  const runtimeDependencies = await Promise.all(
    [...checks].map(async ([name, check]) => {
      try {
        await check();
        return { name, status: "ok" as const };
      } catch {
        return {
          name,
          status: "down" as const,
          detail: "dependency readiness check failed"
        };
      }
    })
  );
  const status =
    baseStatus === "down" || runtimeDependencies.some((dependency) => dependency.status === "down")
      ? "down"
      : baseStatus;
  return buildHealth(service, version, status, [...dependencies, ...runtimeDependencies]);
}

async function findDatabaseRoleProblem(db: DatabaseClient, expectedRole: string): Promise<string | undefined> {
  try {
    const result = await db.query<{
      currentRole: string;
      hasMemberships: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
      sessionRole: string;
    }>(
      `select current_user as "currentRole", session_user as "sessionRole",
              database_role.rolcanlogin, database_role.rolsuper, database_role.rolcreatedb,
              database_role.rolcreaterole, database_role.rolinherit, database_role.rolreplication,
              database_role.rolbypassrls,
              exists(select 1 from pg_auth_members membership
                      where membership.member = database_role.oid
                         or membership.roleid = database_role.oid) as "hasMemberships"
         from pg_roles database_role
        where database_role.rolname = current_user`
    );
    const identity = result.rows[0];
    if (!identity || identity.currentRole !== expectedRole || identity.sessionRole !== expectedRole) {
      return "database role does not match the configured service identity";
    }
    if (
      !identity.rolcanlogin ||
      identity.hasMemberships ||
      identity.rolsuper ||
      identity.rolcreatedb ||
      identity.rolcreaterole ||
      identity.rolinherit ||
      identity.rolreplication ||
      identity.rolbypassrls
    ) {
      return "database role has unsafe PostgreSQL capabilities";
    }
    return undefined;
  } catch {
    return "database role identity could not be verified";
  }
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

async function findSchemaVersionProblem(
  db: DatabaseClient,
  requirement: SchemaVersionRequirement
): Promise<string | undefined> {
  try {
    const result = await db.query<{ current_version: number | string }>(
      `select current_version from "${requirement.schema}".schema_version where service_name = $1`,
      [requirement.serviceName]
    );
    const currentVersion = Number(result.rows[0]?.current_version);
    if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
      return `schema version is missing; require >= ${requirement.minimumVersion}`;
    }
    if (currentVersion < requirement.minimumVersion) {
      return `schema version ${currentVersion} is below required ${requirement.minimumVersion}`;
    }
    return undefined;
  } catch {
    return `schema version is unavailable; require >= ${requirement.minimumVersion}`;
  }
}

function normalizeSchemaVersionRequirement(
  value: SchemaVersionRequirement | undefined
): SchemaVersionRequirement | undefined {
  if (value === undefined) return undefined;
  if (
    !/^[a-z_][a-z0-9_]*$/.test(value.schema) ||
    !/^[a-z][a-z0-9_-]*$/.test(value.serviceName) ||
    !Number.isSafeInteger(value.minimumVersion) ||
    value.minimumVersion < 1
  ) {
    throw new TypeError("requiredSchemaVersion must contain safe identifiers and a positive integer version");
  }
  return { ...value };
}

function normalizeExpectedDatabaseRole(value: string | undefined): string | undefined {
  const role = value?.trim();
  if (!role) return undefined;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) {
    throw new Error("EXPECTED_DATABASE_ROLE must be a safe PostgreSQL role identifier");
  }
  return role;
}

export async function startService(options: RuntimeOptions): Promise<void> {
  const shutdownTimeoutMs = resolveShutdownTimeoutMs(options.shutdownTimeoutMs, process.env.SHUTDOWN_TIMEOUT_MS);
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
    }, shutdownTimeoutMs);
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
