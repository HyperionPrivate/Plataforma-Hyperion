import { authLoginRequestSchema, authMeSchema, authSessionSchema, envelope } from "@hyperion/contracts";
import type { RouteRegistrar, ServiceContext } from "@hyperion/service-runtime";
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

export const registerRoutes: RouteRegistrar = async (app, context) => {
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

  app.get("/v1/identity/operators", async (request) => {
    if (!context.db) {
      return envelope([], request.id);
    }

    const result = await context.db.query(`
      select id, email, display_name, role, status, created_at
      from platform.operators
      order by created_at desc
      limit 100
    `);

    return envelope(result.rows, request.id);
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

async function countOperators(context: ServiceContext): Promise<number> {
  if (!context.db) {
    return 0;
  }

  const result = await context.db.query<{ total: string }>("select count(*)::text as total from platform.operators");
  return Number(result.rows[0]?.total ?? 0);
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
