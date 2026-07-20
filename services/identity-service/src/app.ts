import { assertAccessRuntimeDatabaseBoundary } from "@hyperion/access-migrations/runtime-boundary";
import {
  authLoginRequestSchema,
  authSessionSchema,
  accessLoginRequestSchema,
  accessMeSchema,
  accessPrincipalSchema,
  envelope,
  operatorCreateSchema,
  operatorListSchema,
  operatorPatchSchema,
  productGrantSchema,
  productGrantUpsertSchema,
  productIdSchema,
  platformControlTenantId,
  tenantIdSchema,
  type AccessPrincipal,
  type ProductGrant,
  type ProductGrantUpsert
} from "@hyperion/platform-contracts";
import {
  readInternalCredential,
  readInternalCaller,
  validateOperatorAssertionContext,
  validateInternalAuthorization,
  type InternalCredentialMap,
  type RouteRegistrar,
  type ServiceContext
} from "@hyperion/service-runtime";
import type { FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import {
  generateSessionToken,
  getSessionTtlHours,
  hashPassword,
  hashSessionToken,
  readBearerToken,
  verifyPassword
} from "./auth.js";
import { AccessTokenSizeError, loadAccessTokenServices, type AccessTokenService } from "./access-token.js";
import {
  AccessTenantProjectionReconciler,
  PostgresAccessTenantProjectionOutbox,
  createAccessTenantProjectionHttpDispatcher,
  createAccessTenantProjectionJetStreamDispatcher,
  readAccessTenantProjectionConfiguration
} from "./access-tenant-projections.js";
import {
  AccessLumenProjectionReconciler,
  PostgresAccessLumenProjectionOutbox,
  createAccessLumenProjectionDispatcher,
  createAccessLumenProjectionJetStreamDispatcher,
  enqueueAccessLumenOperatorProjections,
  mutateLumenGrantWithProjection,
  readAccessLumenProjectionConfiguration
} from "./lumen-projections.js";

interface OperatorRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  password_hash: string | null;
}

interface OperatorListRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  status: string;
  tenantIds: string[];
  createdAt: Date;
}

interface ProductGrantRow {
  tenantId: string;
  productId: string;
  roles: string[];
  capabilities: string[];
  active: boolean;
}

interface ProductGrantPath {
  operatorId: string;
  tenantId: string;
  productId: string;
}

interface AdministrativeProductGrantRow extends ProductGrantRow {
  operatorId: string;
}

type QueryExecutor = Pick<NonNullable<ServiceContext["db"]>, "query">;

const PLATFORM_RECOVERY_ROLE = "platform-admin";
const PLATFORM_RECOVERY_CAPABILITY = "manage:platform";
const PLATFORM_RECOVERY_LOCK_NAME = "hyperion:platform-recovery-admin:v1";

class PlatformRecoveryInvariantError extends Error {}

export const registerRoutes: RouteRegistrar = async (app, context) => {
  context.registerReadinessCheck?.({
    name: "access_runtime_boundary",
    check: async () => {
      if (!context.db) throw new Error("Access database is unavailable");
      await assertAccessRuntimeDatabaseBoundary(context.db as never, "hyperion_identity");
    }
  });
  const tenantProjectionConfiguration = readAccessTenantProjectionConfiguration(process.env);
  const lumenProjectionConfiguration = readAccessLumenProjectionConfiguration(process.env);
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_IDENTITY_TOKEN");
  const novaBffToken = readInternalCredential(process.env, "NOVA_BFF_TO_ACCESS_TOKEN");
  const lumenBffToken = readInternalCredential(process.env, "LUMEN_BFF_TO_ACCESS_TOKEN");
  const pulsoBffToken = readInternalCredential(process.env, "PULSO_BFF_TO_ACCESS_TOKEN");
  const platformAdminBffToken = readInternalCredential(process.env, "PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN");
  const platformAdminIdentityToken = readInternalCredential(process.env, "PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN");
  // The legacy gateway is an optional N-1 caller. Requiring its shared
  // assertion secret here would make the neutral platform unable to start
  // after the gateway is removed. Dedicated platform-admin assertions remain
  // mandatory for platform-admin-bff administrative calls below.
  const operatorAssertionKey = readOptionalGatewayAssertionKey(process.env);
  const platformAdminAssertionKey = readInternalCredential(process.env, "PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY");
  if (platformAdminAssertionKey && platformAdminAssertionKey.length < 24) {
    throw new Error("PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY must be at least 24 characters");
  }
  const administrativeCredentials: InternalCredentialMap = {
    "api-gateway": gatewayToken,
    "platform-admin-bff": platformAdminIdentityToken
  };
  const accessTokenServices = await loadAccessTokenServices(process.env);
  const jwksPublisher = accessTokenServices.values().next().value;

  await ensureInitialAdmin(context);
  if (context.db) {
    if (accessTokenServices.size > 0) {
      context.registerReadinessCheck?.({
        name: "platform_access_grants_schema",
        check: async () => {
          const result = await context.db!.query<{ product_grants: string | null }>(
            "select to_regclass('access_runtime.product_grants')::text as product_grants"
          );
          if (!result.rows[0]?.product_grants) throw new Error("Access grants schema is not migrated");
        }
      });
    }
    context.registerReadinessCheck?.({
      name: "access_tenant_projection_schema",
      check: async () => {
        const result = await context.db!.query<{
          stateTable: string | null;
          outboxTable: string | null;
        }>(
          `select to_regclass('access_runtime.tenant_projection_state')::text as "stateTable",
                  to_regclass('access_runtime.tenant_projection_outbox')::text as "outboxTable"`
        );
        if (!result.rows[0]?.stateTable || !result.rows[0]?.outboxTable) {
          throw new Error("Access tenant projection schema is not migrated");
        }
      }
    });

    if (tenantProjectionConfiguration.transport !== "disabled") {
      const tenantReconciler = new AccessTenantProjectionReconciler(
        context.db,
        tenantProjectionConfiguration.reconcileLimit,
        tenantProjectionConfiguration.reconcileIntervalMs
      );
      const tenantBackfill = await tenantReconciler.reconcileOnce();
      context.logger.info("Access tenant snapshot reconciliation completed", { ...tenantBackfill });
      if (tenantBackfill.hasMore) {
        context.logger.warn(
          "Access tenant snapshot reconciliation remains bounded; the periodic worker will continue",
          {
            processed: tenantBackfill.candidatesProcessed,
            limit: tenantProjectionConfiguration.reconcileLimit
          }
        );
      }
      tenantReconciler.start((error) => {
        context.logger.error("Access tenant snapshot reconciliation failed", {
          error: error instanceof Error ? error.message : "unknown_error"
        });
      });

      const workerId = `access-tenant-outbox-${randomUUID()}`;
      const tenantOutbox = new PostgresAccessTenantProjectionOutbox(
        context.db,
        workerId,
        tenantProjectionConfiguration.transport === "http" ? tenantProjectionConfiguration.destinations : undefined,
        tenantProjectionConfiguration.transport === "http" && tenantProjectionConfiguration.allowPrivateHttp
      );
      if (tenantProjectionConfiguration.transport === "http") {
        const dispatcher = createAccessTenantProjectionHttpDispatcher(
          tenantOutbox,
          workerId,
          tenantProjectionConfiguration.destinationTokens
        );
        app.addHook("onClose", async () => {
          await Promise.all([tenantReconciler.stop(), dispatcher.stop()]);
        });
        if (tenantProjectionConfiguration.deliveryEnabled) dispatcher.start();
      } else {
        const dispatcher = createAccessTenantProjectionJetStreamDispatcher(
          tenantOutbox,
          workerId,
          tenantProjectionConfiguration
        );
        app.addHook("onClose", async () => {
          await Promise.all([tenantReconciler.stop(), dispatcher.stop()]);
        });
        if (tenantProjectionConfiguration.deliveryEnabled) {
          await dispatcher.initialize();
          context.registerReadinessCheck?.({
            name: "jetstream_access_tenant_publisher",
            check: () => dispatcher.checkReadiness()
          });
          dispatcher.start();
        }
      }
    }

    context.registerReadinessCheck?.({
      name: "access_lumen_projection_schema",
      check: async () => {
        const result = await context.db!.query<{
          stateTable: string | null;
          outboxTable: string | null;
        }>(
          `select to_regclass('access_runtime.lumen_projection_state')::text as "stateTable",
                  to_regclass('access_runtime.lumen_projection_outbox')::text as "outboxTable"`
        );
        if (!result.rows[0]?.stateTable || !result.rows[0]?.outboxTable) {
          throw new Error("Access→LUMEN projection schema is not migrated");
        }
      }
    });

    if (lumenProjectionConfiguration.transport !== "disabled") {
      const reconciler = new AccessLumenProjectionReconciler(
        context.db,
        lumenProjectionConfiguration.backfillLimit,
        lumenProjectionConfiguration.reconcileIntervalMs
      );
      const backfill = await reconciler.reconcileOnce();
      context.logger.info("Access→LUMEN projection backfill completed", { ...backfill });
      if (backfill.hasMore) {
        context.logger.warn(
          "Access→LUMEN projection reconciliation remains bounded; the periodic worker will continue",
          {
            processed: backfill.candidatesProcessed,
            limit: lumenProjectionConfiguration.backfillLimit
          }
        );
      }
      reconciler.start((error) => {
        context.logger.error("Access→LUMEN projection reconciliation failed", {
          error: error instanceof Error ? error.message : "unknown_error"
        });
      });

      const workerId = `access-lumen-outbox-${randomUUID()}`;
      const outbox = new PostgresAccessLumenProjectionOutbox(
        context.db,
        workerId,
        lumenProjectionConfiguration.transport === "http" ? lumenProjectionConfiguration.serviceUrl : undefined
      );
      if (lumenProjectionConfiguration.transport === "http") {
        const dispatcher = createAccessLumenProjectionDispatcher(
          outbox,
          workerId,
          lumenProjectionConfiguration.internalToken
        );
        app.addHook("onClose", async () => {
          await Promise.all([reconciler.stop(), dispatcher.stop()]);
        });
        if (lumenProjectionConfiguration.deliveryEnabled) dispatcher.start();
      } else {
        const dispatcher = createAccessLumenProjectionJetStreamDispatcher(
          outbox,
          workerId,
          lumenProjectionConfiguration
        );
        app.addHook("onClose", async () => {
          await Promise.all([reconciler.stop(), dispatcher.stop()]);
        });
        if (lumenProjectionConfiguration.deliveryEnabled) {
          await dispatcher.initialize();
          context.registerReadinessCheck?.({
            name: "jetstream_access_lumen_publisher",
            check: () => dispatcher.checkReadiness()
          });
          dispatcher.start();
        }
      }
    }
  }

  app.get("/v1/identity/status", async (request) => {
    const operatorCount = await countOperators(context);

    return envelope(
      {
        service: "identity-service",
        operatorCount,
        databaseConfigured: Boolean(context.db),
        accessJwtConfigured: accessTokenServices.size > 0,
        accessTokenAudiences: [...accessTokenServices.keys()]
      },
      request.id
    );
  });

  app.get("/.well-known/jwks.json", async (_request, reply) => {
    if (!jwksPublisher) {
      return reply.code(503).send({ error: "Access JWT signing is not configured" });
    }
    reply.header("cache-control", "public, max-age=300, stale-if-error=86400");
    return jwksPublisher.jwks();
  });

  app.get("/v1/identity/operators", async (request, reply) => {
    const auth = requireAdministrativeCaller(
      request,
      administrativeCredentials,
      operatorAssertionKey,
      platformAdminAssertionKey
    );
    if (auth) return reply.code(auth.statusCode).send(envelope({ error: auth.message }, request.id));
    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select
        o.id,
        o.email,
        o.display_name as "displayName",
        o.role,
        o.status,
        o.created_at as "createdAt",
        coalesce(array_agg(ot.tenant_id) filter (where ot.tenant_id is not null), '{}') as "tenantIds"
      from platform.operators o
      left join platform.operator_tenants ot on ot.operator_id = o.id
      group by o.id
      order by o.created_at desc
      limit 100
    `);

    return envelope(operatorListSchema.parse(result.rows), request.id);
  });

  app.post("/v1/identity/operators", async (request, reply) => {
    const auth = requireAdministrativeCaller(
      request,
      administrativeCredentials,
      operatorAssertionKey,
      platformAdminAssertionKey
    );
    if (auth) return reply.code(auth.statusCode).send(envelope({ error: auth.message }, request.id));

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const parsed = operatorCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope({ error: "Invalid operator payload", issues: parsed.error.issues }, request.id));
    }

    const input = parsed.data;
    const passwordHash = await hashPassword(input.password);
    const result = await context.db.query<{ id: string }>(
      `insert into platform.operators (email, display_name, role, status, password_hash)
       values ($1, $2, $3, 'active', $4)
       returning id`,
      [input.email.toLowerCase(), input.displayName, input.role, passwordHash]
    );

    await replaceOperatorTenants(context.db, result.rows[0]!.id, input.tenantIds);
    return reply.code(201).send(envelope(await readOperator(context, result.rows[0]!.id), request.id));
  });

  app.patch("/v1/identity/operators/:operatorId", async (request, reply) => {
    const auth = requireAdministrativeCaller(
      request,
      administrativeCredentials,
      operatorAssertionKey,
      platformAdminAssertionKey
    );
    if (auth) return reply.code(auth.statusCode).send(envelope({ error: auth.message }, request.id));

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const operatorId = readUuidParam(request.params, "operatorId");
    if (!operatorId) {
      return reply.code(400).send(envelope({ error: "operatorId must be a UUID" }, request.id));
    }

    const parsed = operatorPatchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope({ error: "Invalid operator payload", issues: parsed.error.issues }, request.id));
    }

    const input = parsed.data;
    const actorId = readUuidHeader(request, "x-operator-id");
    if (!actorId) {
      return reply.code(403).send(envelope({ error: "Signed admin operator context is required" }, request.id));
    }
    if (actorId === operatorId && input.status === "disabled") {
      return reply
        .code(409)
        .send(envelope({ error: "An authenticated platform administrator cannot disable itself" }, request.id));
    }
    const passwordHash = input.password ? await hashPassword(input.password) : undefined;

    let updated: boolean;
    try {
      updated = await context.db.transaction(async (transaction) => {
        await lockPlatformRecoveryAdministration(transaction, operatorId);
        const update = await transaction.query(
          `update platform.operators set
             display_name = coalesce($2, display_name),
             role = coalesce($3, role),
             status = coalesce($4, status),
             password_hash = coalesce($5, password_hash),
             updated_at = now()
           where id = $1`,
          [operatorId, input.displayName ?? null, input.role ?? null, input.status ?? null, passwordHash ?? null]
        );
        if (update.rowCount === 0) return false;
        if (input.tenantIds) await replaceOperatorTenants(transaction, operatorId, input.tenantIds);
        await enqueueAccessLumenOperatorProjections(transaction, operatorId);
        await assertPlatformRecoveryAdministratorRemains(transaction);
        return true;
      });
    } catch (error) {
      if (error instanceof PlatformRecoveryInvariantError) {
        return reply.code(409).send(envelope({ error: error.message }, request.id));
      }
      throw error;
    }

    if (!updated) return reply.code(404).send(envelope({ error: "Operator not found" }, request.id));

    return envelope(await readOperator(context, operatorId), request.id);
  });

  app.get("/v1/access/grants", async (request, reply) => {
    const auth = requireAdministrativeCaller(
      request,
      administrativeCredentials,
      operatorAssertionKey,
      platformAdminAssertionKey
    );
    if (auth) return reply.code(auth.statusCode).send(envelope({ error: auth.message }, request.id));
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }
    const result = await context.db.query<AdministrativeProductGrantRow>(
      `select operator_id as "operatorId",
              tenant_id as "tenantId",
              product_id as "productId",
              roles,
              capabilities,
              active
         from access_runtime.product_grants
        order by operator_id, tenant_id, product_id
        limit 500`
    );
    return envelope(
      result.rows.map((row) => ({ operatorId: row.operatorId, ...productGrantSchema.parse(row) })),
      request.id
    );
  });

  app.get("/v1/access/operators/:operatorId/grants", async (request, reply) => {
    const auth = requireAdministrativeCaller(
      request,
      administrativeCredentials,
      operatorAssertionKey,
      platformAdminAssertionKey
    );
    if (auth) return reply.code(auth.statusCode).send(envelope({ error: auth.message }, request.id));
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }
    const operatorId = readUuidParam(request.params, "operatorId");
    if (!operatorId) {
      return reply.code(400).send(envelope({ error: "operatorId must be a UUID" }, request.id));
    }
    return envelope(await readProductGrants(context, operatorId, true), request.id);
  });

  app.put("/v1/access/operators/:operatorId/grants/:tenantId/:productId", async (request, reply) => {
    const auth = requireAdministrativeCaller(
      request,
      administrativeCredentials,
      operatorAssertionKey,
      platformAdminAssertionKey
    );
    if (auth) return reply.code(auth.statusCode).send(envelope({ error: auth.message }, request.id));
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }
    const grantedBy = readUuidHeader(request, "x-operator-id");
    if (!grantedBy) {
      return reply.code(403).send(envelope({ error: "Signed admin operator context is required" }, request.id));
    }
    const path = parseGrantPath(request.params);
    if (!path) {
      return reply.code(400).send(envelope({ error: "operatorId, tenantId, or productId is invalid" }, request.id));
    }
    if (
      path.productId === "PLATFORM" &&
      (path.tenantId !== platformControlTenantId || readInternalCaller(request.headers) !== "platform-admin-bff")
    ) {
      return reply
        .code(403)
        .send(
          envelope({ error: "PLATFORM grants require the platform control tenant and platform-admin-bff" }, request.id)
        );
    }
    const parsed = productGrantUpsertSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(envelope({ error: "Invalid product grant payload", issues: parsed.error.issues }, request.id));
    }
    const controlsPlatform = isPlatformControlGrant(path);
    if (
      controlsPlatform &&
      path.operatorId === grantedBy &&
      !isEffectivePlatformRecoveryGrant(parsed.data.roles, parsed.data.capabilities, parsed.data.active)
    ) {
      return reply
        .code(409)
        .send(
          envelope(
            { error: "An authenticated platform administrator cannot downgrade its own control grant" },
            request.id
          )
        );
    }

    let grant: ProductGrantRow;
    try {
      if (controlsPlatform) {
        grant = await context.db.transaction(async (transaction) => {
          await lockPlatformRecoveryAdministration(transaction, path.operatorId);
          const row = await upsertProductGrant(transaction, path, parsed.data, grantedBy);
          await assertPlatformRecoveryAdministratorRemains(transaction);
          return row;
        });
      } else if (path.productId === "LUMEN") {
        grant = await mutateLumenGrantWithProjection(context.db, path, (transaction) =>
          upsertProductGrant(transaction, path, parsed.data, grantedBy)
        );
      } else {
        grant = await upsertProductGrant(context.db, path, parsed.data, grantedBy);
      }
    } catch (error) {
      if (error instanceof PlatformRecoveryInvariantError) {
        return reply.code(409).send(envelope({ error: error.message }, request.id));
      }
      throw error;
    }
    return envelope(productGrantSchema.parse(grant), request.id);
  });

  app.delete("/v1/access/operators/:operatorId/grants/:tenantId/:productId", async (request, reply) => {
    const auth = requireAdministrativeCaller(
      request,
      administrativeCredentials,
      operatorAssertionKey,
      platformAdminAssertionKey
    );
    if (auth) return reply.code(auth.statusCode).send(envelope({ error: auth.message }, request.id));
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }
    const grantedBy = readUuidHeader(request, "x-operator-id");
    if (!grantedBy) {
      return reply.code(403).send(envelope({ error: "Signed admin operator context is required" }, request.id));
    }
    const path = parseGrantPath(request.params);
    if (!path) {
      return reply.code(400).send(envelope({ error: "operatorId, tenantId, or productId is invalid" }, request.id));
    }
    if (
      path.productId === "PLATFORM" &&
      (path.tenantId !== platformControlTenantId || readInternalCaller(request.headers) !== "platform-admin-bff")
    ) {
      return reply
        .code(403)
        .send(
          envelope({ error: "PLATFORM grants require the platform control tenant and platform-admin-bff" }, request.id)
        );
    }
    const controlsPlatform = isPlatformControlGrant(path);
    if (controlsPlatform && path.operatorId === grantedBy) {
      return reply
        .code(409)
        .send(
          envelope({ error: "An authenticated platform administrator cannot revoke its own control grant" }, request.id)
        );
    }

    let rowCount: number;
    try {
      if (controlsPlatform) {
        rowCount = await context.db.transaction(async (transaction) => {
          await lockPlatformRecoveryAdministration(transaction, path.operatorId);
          const result = await revokeProductGrant(transaction, path, grantedBy);
          if ((result.rowCount ?? 0) > 0) await assertPlatformRecoveryAdministratorRemains(transaction);
          return result.rowCount ?? 0;
        });
      } else if (path.productId === "LUMEN") {
        const result = await mutateLumenGrantWithProjection(
          context.db,
          path,
          (transaction) => revokeProductGrant(transaction, path, grantedBy),
          (mutationResult) => (mutationResult.rowCount ?? 0) > 0
        );
        rowCount = result.rowCount ?? 0;
      } else {
        const result = await revokeProductGrant(context.db, path, grantedBy);
        rowCount = result.rowCount ?? 0;
      }
    } catch (error) {
      if (error instanceof PlatformRecoveryInvariantError) {
        return reply.code(409).send(envelope({ error: error.message }, request.id));
      }
      throw error;
    }
    if (rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Active product grant not found" }, request.id));
    }
    return envelope({ revoked: true }, request.id);
  });

  app.post("/v1/access/token", async (request, reply) => {
    const internalFailure = validateInternalAuthorization(request.headers, {
      "nova-bff": novaBffToken,
      "lumen-bff": lumenBffToken,
      "pulso-bff": pulsoBffToken,
      "platform-admin-bff": platformAdminBffToken
    });
    if (internalFailure) {
      return reply.code(internalFailure.statusCode).send(envelope({ error: internalFailure.message }, request.id));
    }
    const caller = readInternalCaller(request.headers);
    const accessTokens = caller ? accessTokenServices.get(caller) : undefined;
    if (!accessTokens) {
      return reply.code(503).send(envelope({ error: "Access JWT signing is not configured" }, request.id));
    }
    const parsed = accessLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Email and password (min 8 chars) are required" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }
    const operator = await authenticateOperator(context, parsed.data.email, parsed.data.password);
    if (!operator) {
      return reply.code(401).send(envelope({ error: "Invalid email or password" }, request.id));
    }
    let principal: AccessPrincipal;
    try {
      principal = await readAccessPrincipal(context, operator, true);
    } catch (error) {
      if (isMissingGrantsSchema(error)) {
        return reply.code(503).send(envelope({ error: "Access grants schema is not migrated" }, request.id));
      }
      throw error;
    }
    try {
      const session = accessTokens.issue(principal);
      await context.db.query("update platform.operators set last_login_at = now() where id = $1", [operator.id]);
      return reply.code(201).send(envelope(session, request.id));
    } catch (error) {
      if (error instanceof AccessTokenSizeError) {
        return reply.code(413).send(
          envelope(
            {
              error: "Access session exceeds the cookie-safe budget; use a tenant-scoped token exchange",
              tokenBytes: error.tokenBytes
            },
            request.id
          )
        );
      }
      throw error;
    }
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const parsed = authLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Email and password (min 8 chars) are required" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const operator = await authenticateOperator(context, parsed.data.email, parsed.data.password);
    if (!operator) {
      return reply.code(401).send(envelope({ error: "Invalid email or password" }, request.id));
    }

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + getSessionTtlHours() * 3_600_000);

    await context.db.query(
      "insert into platform.operator_sessions (operator_id, token_hash, expires_at) values ($1, $2, $3)",
      [operator.id, hashSessionToken(token), expiresAt.toISOString()]
    );
    await context.db.query("update platform.operators set last_login_at = now() where id = $1", [operator.id]);

    const session = authSessionSchema.parse({
      token,
      expiresAt: expiresAt.toISOString(),
      operator: {
        id: operator.id,
        email: operator.email,
        displayName: operator.display_name,
        role: operator.role
      }
    });

    const grants = await readProductGrants(context, operator.id, false, false);
    return reply.code(201).send(envelope({ ...session, grants }, request.id));
  });

  app.get("/v1/auth/me", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send(envelope({ error: "Authentication required" }, request.id));
    }

    if (isJwtLike(token)) {
      const principal = verifyAccessToken(accessTokenServices, token);
      if (!principal) {
        return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
      }
      return envelope(accessMe(principal), request.id);
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query<OperatorRow>(
      `select o.id, o.email, o.display_name, o.role, o.password_hash
       from platform.operator_sessions s
       join platform.operators o on o.id = s.operator_id
       where s.token_hash = $1
         and s.revoked_at is null
         and s.expires_at > now()
         and o.status = 'active'
       limit 1`,
      [hashSessionToken(token)]
    );

    const operator = result.rows[0];
    if (!operator) {
      return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
    }

    const tenants = await context.db.query<{ tenant_id: string }>(
      "select tenant_id from platform.operator_tenants where operator_id = $1",
      [operator.id]
    );

    const grants = await readProductGrants(context, operator.id, false, false);
    const me = accessMeSchema.parse({
      operator: {
        id: operator.id,
        email: operator.email,
        displayName: operator.display_name,
        role: operator.role
      },
      tenantIds: tenants.rows.map((row) => row.tenant_id),
      grants
    });

    return envelope(me, request.id);
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send(envelope({ error: "Authentication required" }, request.id));
    }

    if (isJwtLike(token)) {
      if (!verifyAccessToken(accessTokenServices, token)) {
        return reply.code(401).send(envelope({ error: "Invalid or expired session" }, request.id));
      }
      return envelope({ loggedOut: true, locallyRevoked: false }, request.id);
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    await context.db.query(
      "update platform.operator_sessions set revoked_at = now() where token_hash = $1 and revoked_at is null",
      [hashSessionToken(token)]
    );

    return envelope({ loggedOut: true }, request.id);
  });
};

export function readOptionalGatewayAssertionKey(environment: NodeJS.ProcessEnv): string | undefined {
  const assertionKey = readInternalCredential(environment, "GATEWAY_OPERATOR_ASSERTION_KEY");
  if (assertionKey && assertionKey.length < 24) {
    throw new Error("GATEWAY_OPERATOR_ASSERTION_KEY must be at least 24 characters");
  }
  return assertionKey;
}

async function countOperators(context: ServiceContext): Promise<number> {
  if (!context.db) {
    return 0;
  }

  const result = await context.db.query<{ total: string }>("select count(*)::text as total from platform.operators");
  return Number(result.rows[0]?.total ?? 0);
}

async function authenticateOperator(
  context: ServiceContext,
  email: string,
  password: string
): Promise<OperatorRow | undefined> {
  if (!context.db) return undefined;
  const result = await context.db.query<OperatorRow>(
    `select id, email, display_name, role, password_hash
       from platform.operators
      where lower(email) = $1 and status = 'active'
      limit 1`,
    [email.toLowerCase()]
  );
  const operator = result.rows[0];
  if (!operator?.password_hash || !(await verifyPassword(password, operator.password_hash))) return undefined;
  return operator;
}

async function readAccessPrincipal(
  context: ServiceContext,
  operator: OperatorRow,
  requireGrantsSchema: boolean
): Promise<AccessPrincipal> {
  return accessPrincipalSchema.parse({
    operator: {
      id: operator.id,
      email: operator.email,
      displayName: operator.display_name,
      role: operator.role
    },
    grants: await readProductGrants(context, operator.id, false, requireGrantsSchema)
  });
}

async function readProductGrants(
  context: ServiceContext,
  operatorId: string,
  includeInactive: boolean,
  requireSchema = true
): Promise<ProductGrant[]> {
  if (!context.db) return [];
  try {
    const result = await context.db.query<ProductGrantRow>(
      `select tenant_id as "tenantId",
              product_id as "productId",
              roles,
              capabilities,
              active
         from access_runtime.product_grants
        where operator_id = $1
          and ($2::boolean or active)
        order by tenant_id, product_id`,
      [operatorId, includeInactive]
    );
    return result.rows.map((row) => productGrantSchema.parse(row));
  } catch (error) {
    if (!requireSchema && isMissingGrantsSchema(error)) return [];
    throw error;
  }
}

function accessMe(principal: AccessPrincipal) {
  return accessMeSchema.parse({
    ...principal,
    tenantIds: [...new Set(principal.grants.filter((grant) => grant.active).map((grant) => grant.tenantId))]
  });
}

function isJwtLike(token: string): boolean {
  return token.split(".").length === 3;
}

function verifyAccessToken(
  services: ReadonlyMap<string, AccessTokenService>,
  token: string
): AccessPrincipal | undefined {
  for (const service of services.values()) {
    const principal = service.verify(token);
    if (principal) return principal;
  }
  return undefined;
}

function isMissingGrantsSchema(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "42P01" || (error as { code?: unknown }).code === "3F000")
  );
}

function isPlatformControlGrant(path: ProductGrantPath): boolean {
  return path.tenantId === platformControlTenantId && path.productId === "PLATFORM";
}

/**
 * Recovery authority deliberately matches the grant consumed by platform-admin-bff:
 * an active operator plus an active PLATFORM grant on the reserved tenant that
 * contains platform-admin/manage:platform. Legacy operator roles and tenant
 * memberships are compatibility metadata, not control-plane authority.
 */
function isEffectivePlatformRecoveryGrant(roles: string[], capabilities: string[], active: boolean): boolean {
  return active && roles.includes(PLATFORM_RECOVERY_ROLE) && capabilities.includes(PLATFORM_RECOVERY_CAPABILITY);
}

async function lockPlatformRecoveryAdministration(executor: QueryExecutor, targetOperatorId: string): Promise<void> {
  await executor.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [PLATFORM_RECOVERY_LOCK_NAME]);
  await executor.query(
    `select id
       from platform.operators
      where status = 'active' or id = $1
      order by id
      for update`,
    [targetOperatorId]
  );
  await executor.query(
    `select operator_id
       from access_runtime.product_grants
      where tenant_id = $1 and product_id = 'PLATFORM'
      order by operator_id
      for update`,
    [platformControlTenantId]
  );
}

async function assertPlatformRecoveryAdministratorRemains(executor: QueryExecutor): Promise<void> {
  const result = await executor.query<{ count: number | string }>(
    `select count(*)::integer as count
       from platform.operators operator_row
       join access_runtime.product_grants grant_row on grant_row.operator_id = operator_row.id
      where operator_row.status = 'active'
        and grant_row.tenant_id = $1
        and grant_row.product_id = 'PLATFORM'
        and grant_row.active
        and grant_row.roles @> array[$2]::text[]
        and grant_row.capabilities @> array[$3]::text[]`,
    [platformControlTenantId, PLATFORM_RECOVERY_ROLE, PLATFORM_RECOVERY_CAPABILITY]
  );
  const count = Number(result.rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new PlatformRecoveryInvariantError("At least one active platform recovery administrator must remain");
  }
}

async function upsertProductGrant(
  executor: QueryExecutor,
  path: ProductGrantPath,
  input: ProductGrantUpsert,
  grantedBy: string
): Promise<ProductGrantRow> {
  const result = await executor.query<ProductGrantRow>(
    `insert into access_runtime.product_grants
       (operator_id, tenant_id, product_id, roles, capabilities, active, granted_by)
     values ($1, $2, $3, $4::text[], $5::text[], $6, $7)
     on conflict (operator_id, tenant_id, product_id) do update set
       roles = excluded.roles,
       capabilities = excluded.capabilities,
       active = excluded.active,
       granted_by = excluded.granted_by,
       updated_at = now()
     returning tenant_id as "tenantId", product_id as "productId", roles, capabilities, active`,
    [path.operatorId, path.tenantId, path.productId, input.roles, input.capabilities, input.active, grantedBy]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Product grant upsert returned no row");
  return row;
}

function revokeProductGrant(executor: QueryExecutor, path: ProductGrantPath, grantedBy: string) {
  return executor.query(
    `update access_runtime.product_grants
        set active = false, granted_by = $4, updated_at = now()
      where operator_id = $1 and tenant_id = $2 and product_id = $3 and active`,
    [path.operatorId, path.tenantId, path.productId, grantedBy]
  );
}

function parseGrantPath(params: unknown): ProductGrantPath | undefined {
  const operatorId = readUuidParam(params, "operatorId");
  const tenantId = tenantIdSchema.safeParse(readStringParam(params, "tenantId"));
  const productId = productIdSchema.safeParse(readStringParam(params, "productId"));
  if (!operatorId || !tenantId.success || !productId.success) return undefined;
  return { operatorId, tenantId: tenantId.data, productId: productId.data };
}

function readStringParam(params: unknown, key: string): string | undefined {
  const raw =
    typeof params === "object" && params !== null && key in params
      ? (params as Record<string, unknown>)[key]
      : undefined;
  return typeof raw === "string" ? raw : undefined;
}

function readUuidHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value !== "string") return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function requireAdministrativeCaller(
  request: FastifyRequest,
  credentials: InternalCredentialMap,
  gatewayAssertionKey: string | undefined,
  platformAdminAssertionKey: string | undefined
): { statusCode: 401 | 403 | 503; message: string } | undefined {
  const workloadFailure = validateInternalAuthorization(request.headers, credentials);
  if (workloadFailure) return workloadFailure;
  const caller = readInternalCaller(request.headers);
  const isPlatformAdminBff = caller === "platform-admin-bff";
  const assertionKey = isPlatformAdminBff ? platformAdminAssertionKey : gatewayAssertionKey;
  if (isPlatformAdminBff && !assertionKey) {
    return { statusCode: 503, message: "Platform admin assertion key is not configured" };
  }
  if (assertionKey) {
    const assertionFailure = validateOperatorAssertionContext(
      request.headers,
      assertionKey,
      isPlatformAdminBff ? platformControlTenantId : null
    );
    if (assertionFailure) return assertionFailure;
  }

  // Residual (documented): without GATEWAY_OPERATOR_ASSERTION_KEY, role headers
  // remain forgeable by anyone holding GATEWAY_TO_IDENTITY_TOKEN.
  const rawRole = request.headers["x-operator-role"];
  const role = typeof rawRole === "string" ? rawRole : undefined;
  const expectedRole = isPlatformAdminBff ? "platform-manager" : "admin";
  if (role !== expectedRole) {
    return {
      statusCode: 403,
      message: isPlatformAdminBff ? "Platform manager context required" : "Admin role required"
    };
  }
  return undefined;
}

function readUuidParam(params: unknown, key: string): string | undefined {
  const raw =
    typeof params === "object" && params !== null && key in params
      ? (params as Record<string, unknown>)[key]
      : undefined;

  if (typeof raw !== "string") {
    return undefined;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)
    ? raw.toLowerCase()
    : undefined;
}

async function readOperator(context: ServiceContext, operatorId: string): Promise<OperatorListRow> {
  if (!context.db) {
    throw new Error("DATABASE_URL is required");
  }

  const result = await context.db.query<OperatorListRow>(
    `select
      o.id,
      o.email,
      o.display_name as "displayName",
      o.role,
      o.status,
      o.created_at as "createdAt",
      coalesce(array_agg(ot.tenant_id) filter (where ot.tenant_id is not null), '{}') as "tenantIds"
    from platform.operators o
    left join platform.operator_tenants ot on ot.operator_id = o.id
    where o.id = $1
    group by o.id`,
    [operatorId]
  );

  if (!result.rows[0]) {
    throw new Error("Operator not found");
  }

  return result.rows[0];
}

async function replaceOperatorTenants(executor: QueryExecutor, operatorId: string, tenantIds: string[]): Promise<void> {
  await executor.query("delete from platform.operator_tenants where operator_id = $1", [operatorId]);
  for (const tenantId of tenantIds) {
    await executor.query(
      `insert into platform.operator_tenants (operator_id, tenant_id)
       values ($1, $2)
       on conflict do nothing`,
      [operatorId, tenantId]
    );
  }
}

const PLATFORM_CONTROL_BOOTSTRAP_KEY = "platform-control";
const PLATFORM_CONTROL_METADATA = {
  purpose: "platform-control",
  customerFacing: false
} as const;
// During the N/N-1 cutover Identity accepts the fresh Access owner and the
// previous in-place provider. No customer slug participates in this lookup.
const PLATFORM_CONTROL_METADATA_OWNERS = ["access-migrations", "platform-migrations"] as const;

interface BootstrapTenantRow {
  tenantId: string;
}

interface BootstrapOperatorRow {
  id: string;
  role: string;
  status: string;
}

interface BootstrapVerificationRow {
  membershipExists: boolean;
  tenantGrantCount: number;
  platformGrantCount: number;
  exactGrantExists: boolean;
}

// Idempotent bootstrap for the explicitly configured initial administrator.
// The neutral tenant UUID comes only from the Access provider registry;
// runtime code never selects a customer or control tenant by slug.
export async function ensureInitialAdmin(
  context: ServiceContext,
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const rawEmail = environment.INITIAL_ADMIN_EMAIL;
  const rawPassword = environment.INITIAL_ADMIN_PASSWORD;
  const configuredEmail = rawEmail?.trim() || undefined;
  const configuredPassword = rawPassword?.trim() ? rawPassword : undefined;
  if (configuredEmail === undefined && configuredPassword === undefined) return;

  if (configuredEmail === undefined || configuredPassword === undefined) {
    const error = new Error("INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD must be configured together");
    context.logger.error("initial admin bootstrap configuration is incomplete", {
      emailConfigured: configuredEmail !== undefined,
      passwordConfigured: configuredPassword !== undefined
    });
    throw error;
  }

  const credentials = accessLoginRequestSchema.safeParse({
    email: configuredEmail.trim().toLowerCase(),
    password: configuredPassword
  });
  if (!credentials.success) {
    context.logger.error("initial admin bootstrap configuration is invalid", {
      fields: [...new Set(credentials.error.issues.map((issue) => issue.path[0]).filter(Boolean))]
    });
    throw new Error("INITIAL_ADMIN_EMAIL or INITIAL_ADMIN_PASSWORD is invalid");
  }
  if (!context.db) {
    context.logger.error("initial admin bootstrap requires the Access database");
    throw new Error("Initial admin bootstrap requires DATABASE_URL");
  }

  const passwordHash = await hashPassword(credentials.data.password);
  try {
    const result = await context.db.transaction(async (transaction) => {
      const tenantResult = await transaction.query<BootstrapTenantRow>(
        `select registry.tenant_id as "tenantId"
           from access_runtime.bootstrap_tenants registry
           join platform.tenants tenant_row on tenant_row.id = registry.tenant_id
          where registry.bootstrap_key = $1
            and registry.tenant_id = $4
            and tenant_row.status = 'active'
            and tenant_row.metadata @> $2::jsonb
            and tenant_row.metadata ->> 'owner' = any($3::text[])`,
        [
          PLATFORM_CONTROL_BOOTSTRAP_KEY,
          JSON.stringify(PLATFORM_CONTROL_METADATA),
          PLATFORM_CONTROL_METADATA_OWNERS,
          platformControlTenantId
        ]
      );
      const tenantId = tenantResult.rows[0]?.tenantId;
      if (!tenantId) {
        throw new Error("Platform control tenant registry is missing or inconsistent");
      }

      const operatorResult = await transaction.query<BootstrapOperatorRow>(
        `insert into platform.operators (email, display_name, role, password_hash)
         values ($1, $2, 'admin', $3)
         on conflict (email) do update set
           password_hash = coalesce(platform.operators.password_hash, excluded.password_hash),
           updated_at = now()
         returning id, role, status`,
        [credentials.data.email, "Administrador Hyperion", passwordHash]
      );
      const operator = operatorResult.rows[0];
      if (!operator || operator.role !== "admin" || operator.status !== "active") {
        throw new Error("Configured initial admin collides with a non-active or non-admin operator");
      }

      await transaction.query(
        `insert into platform.operator_tenants (operator_id, tenant_id)
         values ($1, $2)
         on conflict (operator_id, tenant_id) do nothing`,
        [operator.id, tenantId]
      );
      await transaction.query(
        `insert into access_runtime.product_grants
           (operator_id, tenant_id, product_id, roles, capabilities, active, granted_by)
         values ($1, $2, 'PLATFORM', array['platform-admin']::text[], array['manage:platform']::text[], true, $1)
         on conflict (operator_id, tenant_id, product_id) do nothing`,
        [operator.id, tenantId]
      );

      const verification = await transaction.query<BootstrapVerificationRow>(
        `select
           exists (
             select 1 from platform.operator_tenants membership
              where membership.operator_id = $1 and membership.tenant_id = $2
           ) as "membershipExists",
           (
             select count(*)::integer from access_runtime.product_grants grant_row
              where grant_row.operator_id = $1 and grant_row.tenant_id = $2
           ) as "tenantGrantCount",
           (
             select count(*)::integer from access_runtime.product_grants grant_row
              where grant_row.operator_id = $1
                and grant_row.tenant_id = $2
                and grant_row.product_id = 'PLATFORM'
           ) as "platformGrantCount",
           exists (
             select 1 from access_runtime.product_grants grant_row
              where grant_row.operator_id = $1
                and grant_row.tenant_id = $2
                and grant_row.product_id = 'PLATFORM'
                and grant_row.roles = array['platform-admin']::text[]
                and grant_row.capabilities = array['manage:platform']::text[]
                and grant_row.active
           ) as "exactGrantExists"`,
        [operator.id, tenantId]
      );
      const state = verification.rows[0];
      if (
        !state?.membershipExists ||
        state.tenantGrantCount !== 1 ||
        state.platformGrantCount !== 1 ||
        !state.exactGrantExists
      ) {
        throw new Error("Initial admin platform membership or grant is partial/inconsistent");
      }
      return { operatorId: operator.id, tenantId };
    });
    context.logger.info("initial admin platform bootstrap ensured", {
      email: credentials.data.email,
      operatorId: result.operatorId,
      tenantId: result.tenantId
    });
  } catch (error) {
    const reason = isMissingGrantsSchema(error)
      ? "Platform Access bootstrap schema is not migrated; run access-migrations before Identity"
      : error instanceof Error
        ? error.message
        : String(error);
    context.logger.error("initial admin platform bootstrap failed", { reason });
    throw new Error(`Initial admin platform bootstrap failed: ${reason}`, { cause: error });
  }
}
