import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  assertNoPlaceholderSecrets,
  isRestrictedDeploymentEnvironment,
  readServiceConfig,
  type ServiceConfig
} from "@hyperion/config";
import { type ServiceHealth, type ServiceName, serviceHealthSchema } from "@hyperion/platform-contracts";
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
export {
  OPERATOR_ASSERTION_HEADER,
  createOperatorAssertion,
  readOperatorAssertionKey,
  validateOperatorAssertionContext,
  validateProductOperatorAssertionContext,
  verifyOperatorAssertion,
  type OperatorAssertionClaims,
  type OperatorAssertionFailure,
  type OperatorAssertionHeaders
} from "./operator-assertion.js";
export { assertJetStreamProductionGate } from "./jetstream-production-gate.js";
export {
  assertNoPlaceholderSecrets,
  ENV_EXAMPLE_PLACEHOLDER_VALUES,
  findPlaceholderSecretProblems,
  HYPERION_DEPLOYMENT_ENVIRONMENTS,
  isCiDeploymentEnvironment,
  isPlaceholderSecret,
  isRestrictedDeploymentEnvironment,
  readDeploymentEnvironment,
  REQUIRED_SECRET_ENV_KEYS,
  shouldEnforcePlaceholderRejection,
  type HyperionDeploymentEnvironment
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
  /** Provider-owned migration ledger. The global platform ledger is forbidden. */
  requiredMigrationLedger?: MigrationLedgerRequirement;
  /**
   * Transitional exception for Audit while its migrator is still extracted.
   * The runtime rejects this option for every other service.
   */
  requiredLegacyMigrationNames?: readonly string[];
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

export interface MigrationLedgerRequirement {
  /** Provider-owned schema; `platform` is deliberately forbidden. */
  schema: string;
  /** Exact provider migration names that must exist in `<schema>.migration_ledger`. */
  migrationNames: readonly string[];
  /** Exact immutable ledger. When present, extra, mixed or changed rows fail readiness. */
  exactMigrationLedger?: readonly Readonly<{ name: string; checksum: string }>[];
  /** Complete N-1 provider sets accepted during an explicit rolling cutover. */
  compatibleMigrationNameSets?: readonly (readonly string[])[];
}

const ACCESS_LOG_EXCLUDED_PATHS = new Set(["/health", "/ready"]);
const RESERVED_READINESS_NAMES = new Set([
  "postgres",
  "postgres_role",
  "schema_migrations",
  "legacy.platform.schema_migrations"
]);
const READINESS_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const DATABASE_ROLE_BY_SERVICE: Partial<Record<ServiceName, string>> = {
  "identity-service": "hyperion_identity",
  "tenant-service": "hyperion_tenant",
  "agent-service": "hyperion_sofia",
  "prompt-flow-service": "hyperion_sofia",
  "knowledge-service": "hyperion_knowledge",
  "audit-service": "hyperion_audit",
  "integration-service": "hyperion_integration",
  "pulso-iris-service": "hyperion_pulso",
  "whatsapp-channel-service": "hyperion_channel",
  "lumen-service": "hyperion_lumen",
  "nova-core-service": "hyperion_nova",
  "voice-channel-service": "hyperion_voice",
  "liwa-channel-service": "hyperion_liwa",
  "documents-service": "hyperion_documents"
};

export async function createService(options: RuntimeOptions): Promise<ServiceHandle> {
  assertNoPlaceholderSecrets(process.env);
  assertJetStreamProductionGate(process.env);
  const requiredSchemaVersion = normalizeSchemaVersionRequirement(options.requiredSchemaVersion);
  const requiredMigrationLedger = normalizeMigrationLedgerRequirement(options.requiredMigrationLedger);
  const requiredLegacyMigrationNames = normalizeLegacyMigrationNames(
    options.serviceName,
    options.requiredLegacyMigrationNames
  );
  const databaseReadinessRequirementCount =
    Number(requiredSchemaVersion !== undefined) +
    Number(requiredMigrationLedger !== undefined) +
    Number(requiredLegacyMigrationNames.length > 0);
  if (databaseReadinessRequirementCount > 1) {
    throw new TypeError("configure exactly one database schema readiness requirement");
  }
  if (databaseReadinessRequirementCount > 0 && options.databaseRequired !== true) {
    throw new TypeError("database schema readiness requirements require databaseRequired: true");
  }
  const config = readServiceConfig(options.serviceName);
  const expectedDatabaseRole = normalizeExpectedDatabaseRole(process.env.EXPECTED_DATABASE_ROLE);
  const normativeDatabaseRole = DATABASE_ROLE_BY_SERVICE[options.serviceName];
  if (config.databaseUrl && expectedDatabaseRole && expectedDatabaseRole !== normativeDatabaseRole) {
    throw new Error("EXPECTED_DATABASE_ROLE does not match the service database identity");
  }
  if (config.databaseUrl && isRestrictedDeploymentEnvironment(process.env) && !expectedDatabaseRole) {
    throw new Error("EXPECTED_DATABASE_ROLE is required for a production/staging database connection");
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

      if (requiredMigrationLedger) {
        const missingMigration = await findMissingMigration(db, requiredMigrationLedger);
        const dependencyName = `${requiredMigrationLedger.schema}.migration_ledger`;
        if (missingMigration) {
          dependencies.push({
            name: dependencyName,
            status: "down",
            detail: `missing migration: ${missingMigration}`
          });

          return sendReadiness(
            reply,
            buildReadinessHealth(options.serviceName, config.serviceVersion, "down", dependencies, readinessChecks)
          );
        }

        dependencies.push({
          name: dependencyName,
          status: "ok",
          detail: "required provider migrations applied"
        });
      }

      if (requiredLegacyMigrationNames.length > 0) {
        const missingMigration = await findMissingLegacyMigration(db, requiredLegacyMigrationNames);
        if (missingMigration) {
          dependencies.push({
            name: "legacy.platform.schema_migrations",
            status: "down",
            detail: `missing legacy migration: ${missingMigration}`
          });

          return sendReadiness(
            reply,
            buildReadinessHealth(options.serviceName, config.serviceVersion, "down", dependencies, readinessChecks)
          );
        }

        dependencies.push({
          name: "legacy.platform.schema_migrations",
          status: "ok",
          detail: "transitional Audit migrations applied"
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
  if (
    RESERVED_READINESS_NAMES.has(value.name) ||
    value.name.endsWith(".migration_ledger") ||
    value.name.endsWith(".schema_version") ||
    checks.has(value.name)
  ) {
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

/** NULL and PostgreSQL infinity both mean the password never expires. */
function isSafeRolePasswordExpiry(value: string | number | Date | null | undefined): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "infinity";
  // node-postgres parses PostgreSQL timestamptz 'infinity' as numeric
  // Infinity (OID 1184). Only positive infinity represents a password that
  // never expires; finite timestamps and -infinity must remain fail-closed.
  if (typeof value === "number") return value === Number.POSITIVE_INFINITY;
  if (value instanceof Date) return !Number.isFinite(value.getTime());
  return false;
}

async function findDatabaseRoleProblem(db: DatabaseClient, expectedRole: string): Promise<string | undefined> {
  try {
    await db.query("select pg_catalog.set_config('search_path', 'pg_catalog', false)");
    const result = await db.query<{
      currentRole: string;
      hasMemberships: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
      rolconfig: string[] | null;
      rolconnlimit: number;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
      rolvaliduntil: string | number | Date | null;
      sessionRole: string;
    }>(
      `select current_user as "currentRole", session_user as "sessionRole",
              database_role.rolcanlogin, database_role.rolsuper, database_role.rolcreatedb,
              database_role.rolcreaterole, database_role.rolinherit, database_role.rolreplication,
              database_role.rolbypassrls, database_role.rolconnlimit,
              database_role.rolvaliduntil, database_role.rolconfig,
              exists(select 1 from pg_catalog.pg_auth_members membership
                      where membership.member = database_role.oid
                         or membership.roleid = database_role.oid) as "hasMemberships"
         from pg_catalog.pg_roles database_role
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
      identity.rolbypassrls ||
      identity.rolconnlimit !== -1 ||
      !isSafeRolePasswordExpiry(identity.rolvaliduntil) ||
      identity.rolconfig !== null
    ) {
      return "database role has unsafe PostgreSQL capabilities";
    }
    return undefined;
  } catch {
    return "database role identity could not be verified";
  }
}

async function findMissingMigration(
  db: DatabaseClient,
  requirement: MigrationLedgerRequirement
): Promise<string | undefined> {
  try {
    if (requirement.exactMigrationLedger) {
      const result = await db.query<{ name: string; checksum: string }>(
        `select name, checksum from "${requirement.schema}".migration_ledger order by name`
      );
      const expected = requirement.exactMigrationLedger;
      if (
        result.rows.length !== expected.length ||
        result.rows.some(
          (row, index) => row.name !== expected[index]?.name || row.checksum !== expected[index]?.checksum
        )
      ) {
        return requirement.migrationNames[0];
      }
      return undefined;
    }
    const acceptedSets = [requirement.migrationNames, ...(requirement.compatibleMigrationNameSets ?? [])];
    const queriedNames = [...new Set(acceptedSets.flat())];
    const result = await db.query<{ name: string }>(
      `select name from "${requirement.schema}".migration_ledger where name = any($1::text[])`,
      [queriedNames]
    );
    const applied = new Set(result.rows.map((row) => row.name));
    if (acceptedSets.some((migrationNames) => migrationNames.every((name) => applied.has(name)))) return undefined;
    return requirement.migrationNames.find((name) => !applied.has(name));
  } catch {
    return requirement.migrationNames[0];
  }
}

async function findMissingLegacyMigration(
  db: DatabaseClient,
  requiredMigrationNames: readonly string[]
): Promise<string | undefined> {
  try {
    const result = await db.query<{ name: string }>(
      "select name from platform.schema_migrations where name = any($1::text[])",
      [requiredMigrationNames]
    );
    const applied = new Set(result.rows.map((row) => row.name));
    return requiredMigrationNames.find((name) => !applied.has(name));
  } catch {
    return requiredMigrationNames[0];
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

function normalizeMigrationLedgerRequirement(
  value: MigrationLedgerRequirement | undefined
): MigrationLedgerRequirement | undefined {
  if (value === undefined) return undefined;
  const compatibleSets = value.compatibleMigrationNameSets ?? [];
  const exactLedger = value.exactMigrationLedger ?? [];
  const validMigrationNames = (names: readonly string[]) =>
    Array.isArray(names) &&
    names.length > 0 &&
    names.length <= 256 &&
    names.every((name) => typeof name === "string" && /^[0-9]{3}-[a-z0-9][a-z0-9-]*\.sql$/.test(name)) &&
    new Set(names).size === names.length;
  if (
    !/^[a-z_][a-z0-9_]*$/.test(value.schema) ||
    value.schema === "platform" ||
    !validMigrationNames(value.migrationNames) ||
    !Array.isArray(exactLedger) ||
    (exactLedger.length > 0 &&
      (compatibleSets.length > 0 ||
        exactLedger.length !== value.migrationNames.length ||
        exactLedger.some(
          (entry, index) =>
            typeof entry !== "object" ||
            entry === null ||
            entry.name !== value.migrationNames[index] ||
            !/^[a-f0-9]{64}$/.test(entry.checksum)
        ))) ||
    !Array.isArray(compatibleSets) ||
    compatibleSets.length > 4 ||
    compatibleSets.some((names) => !validMigrationNames(names))
  ) {
    throw new TypeError("requiredMigrationLedger must identify a provider-owned ledger and safe migration names");
  }
  return {
    schema: value.schema,
    migrationNames: [...value.migrationNames],
    ...(exactLedger.length > 0
      ? { exactMigrationLedger: exactLedger.map(({ name, checksum }) => ({ name, checksum })) }
      : {}),
    ...(compatibleSets.length > 0 ? { compatibleMigrationNameSets: compatibleSets.map((names) => [...names]) } : {})
  };
}

function normalizeLegacyMigrationNames(
  serviceName: ServiceName,
  value: readonly string[] | undefined
): readonly string[] {
  if (value === undefined) return [];
  if (serviceName !== "audit-service") {
    throw new TypeError("requiredLegacyMigrationNames is restricted to audit-service");
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256 ||
    value.some((name) => typeof name !== "string" || !/^[0-9]{3}-[a-z0-9][a-z0-9-]*\.sql$/.test(name)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError("requiredLegacyMigrationNames must contain unique safe migration names");
  }
  return [...value];
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
