import {
  authLoginRequestSchema,
  authMeSchema,
  authSessionSchema,
  envelope,
  operatorCreateSchema,
  operatorListSchema,
  operatorPatchSchema
} from "@hyperion/contracts";
import {
  readInternalCredential,
  readOperatorAssertionKey,
  validateOperatorAssertionContext,
  validateInternalAuthorization,
  type RouteRegistrar,
  type ServiceContext
} from "@hyperion/service-runtime";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  readBearerToken,
  SESSION_TTL_HOURS,
  verifyPassword
} from "./auth.js";

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

export const registerRoutes: RouteRegistrar = async (app, context) => {
  const gatewayToken = readInternalCredential(process.env, "GATEWAY_TO_IDENTITY_TOKEN");
  const operatorAssertionKey = readOperatorAssertionKey(process.env);

  if (context.db) {
    await ensureInitialAdmin(context);
  }

  app.get("/v1/identity/status", async (request) => {
    const operatorCount = await countOperators(context);

    return envelope(
      {
        service: "identity-service",
        operatorCount,
        databaseConfigured: Boolean(context.db)
      },
      request.id
    );
  });

  app.get("/v1/identity/operators", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    const auth = requireAdmin(request, operatorAssertionKey);
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
    if (!requireGateway(request, reply, gatewayToken)) return;
    const auth = requireAdmin(request, operatorAssertionKey);
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

    await replaceOperatorTenants(context, result.rows[0]!.id, input.tenantIds);
    return reply.code(201).send(envelope(await readOperator(context, result.rows[0]!.id), request.id));
  });

  app.patch("/v1/identity/operators/:operatorId", async (request, reply) => {
    if (!requireGateway(request, reply, gatewayToken)) return;
    const auth = requireAdmin(request, operatorAssertionKey);
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
    const passwordHash = input.password ? await hashPassword(input.password) : undefined;

    const update = await context.db.query(
      `update platform.operators set
         display_name = coalesce($2, display_name),
         role = coalesce($3, role),
         status = coalesce($4, status),
         password_hash = coalesce($5, password_hash),
         updated_at = now()
       where id = $1`,
      [operatorId, input.displayName ?? null, input.role ?? null, input.status ?? null, passwordHash ?? null]
    );

    if (update.rowCount === 0) {
      return reply.code(404).send(envelope({ error: "Operator not found" }, request.id));
    }

    if (input.tenantIds) {
      await replaceOperatorTenants(context, operatorId, input.tenantIds);
    }

    return envelope(await readOperator(context, operatorId), request.id);
  });

  app.post("/v1/auth/login", async (request, reply) => {
    const parsed = authLoginRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Email and password (min 8 chars) are required" }, request.id));
    }

    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const result = await context.db.query<OperatorRow>(
      `select id, email, display_name, role, password_hash
       from platform.operators
       where lower(email) = $1 and status = 'active'
       limit 1`,
      [parsed.data.email.toLowerCase()]
    );

    const operator = result.rows[0];
    if (!operator?.password_hash || !(await verifyPassword(parsed.data.password, operator.password_hash))) {
      return reply.code(401).send(envelope({ error: "Invalid email or password" }, request.id));
    }

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3_600_000);

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

    return reply.code(201).send(envelope(session, request.id));
  });

  app.get("/v1/auth/me", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send(envelope({ error: "Authentication required" }, request.id));
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

    const me = authMeSchema.parse({
      operator: {
        id: operator.id,
        email: operator.email,
        displayName: operator.display_name,
        role: operator.role
      },
      tenantIds: tenants.rows.map((row) => row.tenant_id)
    });

    return envelope(me, request.id);
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    const token = readBearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send(envelope({ error: "Authentication required" }, request.id));
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

function requireGateway(request: FastifyRequest, reply: FastifyReply, token: string | undefined): boolean {
  const failure = validateInternalAuthorization(request.headers, { "api-gateway": token });
  if (!failure) return true;
  void reply.code(failure.statusCode).send(envelope({ error: failure.message }, request.id));
  return false;
}

async function countOperators(context: ServiceContext): Promise<number> {
  if (!context.db) {
    return 0;
  }

  const result = await context.db.query<{ total: string }>("select count(*)::text as total from platform.operators");
  return Number(result.rows[0]?.total ?? 0);
}

function requireAdmin(
  request: FastifyRequest,
  assertionKey: string | undefined
): { statusCode: number; message: string } | undefined {
  if (assertionKey) {
    const assertionFailure = validateOperatorAssertionContext(request.headers, assertionKey, null);
    if (assertionFailure) return assertionFailure;
  }

  // Residual (documented): without GATEWAY_OPERATOR_ASSERTION_KEY, role headers
  // remain forgeable by anyone holding GATEWAY_TO_IDENTITY_TOKEN.
  const rawRole = request.headers["x-operator-role"];
  const role = typeof rawRole === "string" ? rawRole : undefined;
  if (role !== "admin") {
    return { statusCode: 403, message: "Admin role required" };
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

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ? raw : undefined;
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

async function replaceOperatorTenants(context: ServiceContext, operatorId: string, tenantIds: string[]): Promise<void> {
  if (!context.db) {
    throw new Error("DATABASE_URL is required");
  }

  await context.db.query("delete from platform.operator_tenants where operator_id = $1", [operatorId]);
  for (const tenantId of tenantIds) {
    await context.db.query(
      `insert into platform.operator_tenants (operator_id, tenant_id)
       values ($1, $2)
       on conflict do nothing`,
      [operatorId, tenantId]
    );
  }
}

// One-time bootstrap so the platform has an admin able to log in. Controlled by
// INITIAL_ADMIN_EMAIL / INITIAL_ADMIN_PASSWORD; never overwrites an existing hash.
async function ensureInitialAdmin(context: ServiceContext): Promise<void> {
  const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!context.db || !email || !password) {
    return;
  }

  try {
    const passwordHash = await hashPassword(password);
    await context.db.query(
      `insert into platform.operators (email, display_name, role, password_hash)
       values ($1, $2, 'admin', $3)
       on conflict (email) do update set
         password_hash = coalesce(platform.operators.password_hash, excluded.password_hash),
         role = 'admin',
         updated_at = now()`,
      [email, "Administrador Hyperion", passwordHash]
    );
    context.logger.info("initial admin ensured", { email });
  } catch (error) {
    context.logger.warn("could not ensure initial admin", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
