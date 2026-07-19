import { generateKeyPairSync } from "node:crypto";
import { platformControlTenantId } from "@hyperion/platform-contracts";
import { createOperatorAssertion as createPlatformOperatorAssertion } from "@hyperion/platform-contracts/operator-assertion";
import {
  createInternalAuthorizationHeaders,
  createOperatorAssertion,
  OPERATOR_ASSERTION_HEADER,
  type ServiceContext
} from "@hyperion/service-runtime";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureInitialAdmin, registerRoutes } from "./app.js";

const adminEmail = "bootstrap-admin@example.com";
const adminPassword = "bootstrap-password-123";
const adminId = "22222222-2222-4222-8222-222222222222";
const secondAdminId = "33333333-3333-4333-8333-333333333333";
const staleAdminId = "44444444-4444-4444-8444-444444444444";
const letterAdminId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const customerTenantId = "11111111-1111-4111-8111-111111111111";
const platformAccessToken = "platform-admin-to-access-token-0001";
const platformIdentityToken = "platform-admin-to-identity-token-01";
const platformAssertionKey = "platform-admin-assertion-key-0001";
const gatewayToken = "gateway-to-identity-token-00000001";
const gatewayAssertionKey = "gateway-operator-assertion-key-01";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fresh platform administrator bootstrap", () => {
  it("migrates empty state, creates one control grant idempotently, and authorizes platform login", async () => {
    const model = new FreshAccessModel();
    const logger = testLogger();
    configureAccessEnvironment();
    const context = createContext(model, logger);
    const app = Fastify({ logger: false });
    await registerRoutes(app, context);

    expect(model.operators).toHaveLength(1);
    expect(model.memberships).toEqual(new Set([`${adminId}:${platformControlTenantId}`]));
    expect(model.grants).toEqual([
      {
        operatorId: adminId,
        tenantId: platformControlTenantId,
        productId: "PLATFORM",
        roles: ["platform-admin"],
        capabilities: ["manage:platform"],
        active: true
      }
    ]);
    expect(model.bootstrapOwnerAllowlist).toEqual(["access-migrations", "platform-migrations"]);

    await ensureInitialAdmin(context, {
      INITIAL_ADMIN_EMAIL: adminEmail,
      INITIAL_ADMIN_PASSWORD: adminPassword
    });
    expect(model.operators).toHaveLength(1);
    expect(model.memberships.size).toBe(1);
    expect(model.grants).toHaveLength(1);

    const login = await app.inject({
      method: "POST",
      url: "/v1/access/token",
      headers: createInternalAuthorizationHeaders("platform-admin-bff", platformAccessToken),
      payload: { email: adminEmail, password: adminPassword }
    });
    expect(login.statusCode).toBe(201);
    const token = login.json().data.accessToken as string;
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(claims.aud).toBe("platform-admin-bff");
    expect(claims.grants).toEqual([
      {
        tenantId: platformControlTenantId,
        productId: "PLATFORM",
        roles: ["platform-admin"],
        capabilities: ["manage:platform"],
        active: true
      }
    ]);

    const platformHeaders = administrativeHeaders();
    const customerGrant = await app.inject({
      method: "PUT",
      url: `/v1/access/operators/${adminId}/grants/${customerTenantId}/PLATFORM`,
      headers: { ...platformHeaders, "content-type": "application/json" },
      payload: { roles: ["platform-admin"], capabilities: ["manage:platform"] }
    });
    expect(customerGrant.statusCode).toBe(403);

    const gatewayHeaders = {
      ...createInternalAuthorizationHeaders("api-gateway", gatewayToken),
      "x-operator-id": adminId,
      "x-operator-role": "admin",
      [OPERATOR_ASSERTION_HEADER]: createOperatorAssertion(
        { operatorId: adminId, role: "admin", expiresAtUnix: Math.floor(Date.now() / 1000) + 60 },
        gatewayAssertionKey
      )
    };
    const gatewayPlatformGrant = await app.inject({
      method: "PUT",
      url: `/v1/access/operators/${adminId}/grants/${platformControlTenantId}/PLATFORM`,
      headers: { ...gatewayHeaders, "content-type": "application/json" },
      payload: { roles: ["platform-admin"], capabilities: ["manage:platform"] }
    });
    expect(gatewayPlatformGrant.statusCode).toBe(403);
    expect(model.grants).toHaveLength(1);

    await app.close();
  });

  it("treats the empty Compose defaults as disabled but rejects a partial configuration", async () => {
    const model = new FreshAccessModel();
    const logger = testLogger();
    const context = createContext(model, logger);

    await expect(
      ensureInitialAdmin(context, { INITIAL_ADMIN_EMAIL: "", INITIAL_ADMIN_PASSWORD: "" })
    ).resolves.toBeUndefined();
    expect(model.transactionCount).toBe(0);

    await expect(
      ensureInitialAdmin(context, { INITIAL_ADMIN_EMAIL: adminEmail, INITIAL_ADMIN_PASSWORD: "" })
    ).rejects.toThrow("must be configured together");
    expect(logger.error).toHaveBeenCalledWith(
      "initial admin bootstrap configuration is incomplete",
      expect.any(Object)
    );
  });

  it("fails startup clearly when the platform bootstrap schema is missing", async () => {
    const model = new FreshAccessModel();
    model.schemaMissing = true;
    const logger = testLogger();

    await expect(
      ensureInitialAdmin(createContext(model, logger), {
        INITIAL_ADMIN_EMAIL: adminEmail,
        INITIAL_ADMIN_PASSWORD: adminPassword
      })
    ).rejects.toThrow("run access-migrations before Identity");
    expect(logger.error).toHaveBeenCalledWith(
      "initial admin platform bootstrap failed",
      expect.objectContaining({ reason: expect.stringContaining("not migrated") })
    );
  });
});

describe("platform recovery administrator invariants", () => {
  it("rejects disabling the authenticated operator before any database mutation", async () => {
    const model = new FreshAccessModel();
    model.seedRecoveryAdmin(letterAdminId, adminEmail);
    const app = await buildRecoveryApp(model);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/identity/operators/${letterAdminId.toUpperCase()}`,
      headers: administrativeHeaders(letterAdminId),
      payload: { status: "disabled" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().data.error).toContain("cannot disable itself");
    expect(model.operators.find((operator) => operator.id === letterAdminId)?.status).toBe("active");
    expect(model.transactionCount).toBe(0);
    await app.close();
  });

  it("rejects overwriting or revoking the authenticated operator's own recovery grant", async () => {
    const model = new FreshAccessModel();
    model.seedRecoveryAdmin(adminId, adminEmail);
    const app = await buildRecoveryApp(model);
    const url = `/v1/access/operators/${adminId}/grants/${platformControlTenantId}/PLATFORM`;

    const overwrite = await app.inject({
      method: "PUT",
      url,
      headers: administrativeHeaders(),
      payload: { roles: ["viewer"], capabilities: ["view:platform"], active: true }
    });
    const revoke = await app.inject({ method: "DELETE", url, headers: administrativeHeaders() });

    expect(overwrite.statusCode).toBe(409);
    expect(overwrite.json().data.error).toContain("cannot downgrade its own");
    expect(revoke.statusCode).toBe(409);
    expect(revoke.json().data.error).toContain("cannot revoke its own");
    expect(model.recoveryAdminIds()).toEqual([adminId]);
    expect(model.transactionCount).toBe(0);
    await app.close();
  });

  it("rolls back downgrade and revoke attempts against the last recovery admin", async () => {
    const model = new FreshAccessModel();
    model.seedRecoveryAdmin(secondAdminId, "second-admin@example.com");
    const app = await buildRecoveryApp(model);
    const url = `/v1/access/operators/${secondAdminId}/grants/${platformControlTenantId}/PLATFORM`;
    const headers = administrativeHeaders(staleAdminId);

    const downgrade = await app.inject({
      method: "PUT",
      url,
      headers,
      payload: { roles: ["viewer"], capabilities: ["view:platform"], active: true }
    });
    const revoke = await app.inject({ method: "DELETE", url, headers });

    expect(downgrade.statusCode).toBe(409);
    expect(revoke.statusCode).toBe(409);
    expect(model.recoveryAdminIds()).toEqual([secondAdminId]);
    expect(model.rollbackCount).toBe(2);
    expect(model.advisoryLockCount).toBe(2);
    expect(model.rowLockCount).toBe(4);
    await app.close();
  });

  it("rolls back disabling the last recovery admin when the actor is another operator", async () => {
    const model = new FreshAccessModel();
    model.seedRecoveryAdmin(secondAdminId, "second-admin@example.com");
    const app = await buildRecoveryApp(model);

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/identity/operators/${secondAdminId}`,
      headers: administrativeHeaders(staleAdminId),
      payload: { status: "disabled" }
    });

    expect(response.statusCode).toBe(409);
    expect(model.operators.find((operator) => operator.id === secondAdminId)?.status).toBe("active");
    expect(model.recoveryAdminIds()).toEqual([secondAdminId]);
    expect(model.rollbackCount).toBe(1);
    await app.close();
  });

  it("serializes concurrent downgrades so exactly one recovery admin survives", async () => {
    const model = new FreshAccessModel();
    model.seedRecoveryAdmin(adminId, adminEmail);
    model.seedRecoveryAdmin(secondAdminId, "second-admin@example.com");
    const app = await buildRecoveryApp(model);
    const payload = { roles: ["viewer"], capabilities: ["view:platform"], active: true };

    const responses = await Promise.all(
      [adminId, secondAdminId].map((operatorId) =>
        app.inject({
          method: "PUT",
          url: `/v1/access/operators/${operatorId}/grants/${platformControlTenantId}/PLATFORM`,
          headers: administrativeHeaders(staleAdminId),
          payload
        })
      )
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(model.recoveryAdminIds()).toHaveLength(1);
    expect(model.transactionCount).toBe(2);
    expect(model.rollbackCount).toBe(1);
    expect(model.advisoryLockCount).toBe(2);
    expect(model.rowLockCount).toBe(4);
    await app.close();
  });

  it("allows downgrading and revoking another grant while one recovery admin remains", async () => {
    const model = new FreshAccessModel();
    model.seedRecoveryAdmin(adminId, adminEmail);
    model.seedRecoveryAdmin(secondAdminId, "second-admin@example.com");
    const app = await buildRecoveryApp(model);
    const url = `/v1/access/operators/${secondAdminId}/grants/${platformControlTenantId}/PLATFORM`;

    const downgrade = await app.inject({
      method: "PUT",
      url,
      headers: administrativeHeaders(adminId),
      payload: { roles: ["viewer"], capabilities: ["view:platform"], active: true }
    });
    const revoke = await app.inject({ method: "DELETE", url, headers: administrativeHeaders(adminId) });

    expect(downgrade.statusCode).toBe(200);
    expect(revoke.statusCode).toBe(200);
    expect(model.recoveryAdminIds()).toEqual([adminId]);
    expect(model.rollbackCount).toBe(0);
    await app.close();
  });
});

async function buildRecoveryApp(model: FreshAccessModel) {
  configureAccessEnvironment();
  vi.stubEnv("INITIAL_ADMIN_EMAIL", "");
  vi.stubEnv("INITIAL_ADMIN_PASSWORD", "");
  const app = Fastify({ logger: false });
  await registerRoutes(app, createContext(model, testLogger()));
  return app;
}

function configureAccessEnvironment(): void {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  vi.stubEnv("HYPERION_ENVIRONMENT", "ci");
  vi.stubEnv("INITIAL_ADMIN_EMAIL", adminEmail);
  vi.stubEnv("INITIAL_ADMIN_PASSWORD", adminPassword);
  vi.stubEnv("PLATFORM_ADMIN_BFF_TO_ACCESS_TOKEN", platformAccessToken);
  vi.stubEnv("PLATFORM_ADMIN_BFF_TO_IDENTITY_TOKEN", platformIdentityToken);
  vi.stubEnv("PLATFORM_ADMIN_OPERATOR_ASSERTION_KEY", platformAssertionKey);
  vi.stubEnv("GATEWAY_TO_IDENTITY_TOKEN", gatewayToken);
  vi.stubEnv("GATEWAY_OPERATOR_ASSERTION_KEY", gatewayAssertionKey);
  vi.stubEnv("ACCESS_TOKEN_PRIVATE_KEY_PEM", pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString());
  vi.stubEnv("ACCESS_TOKEN_ISSUER", "https://access.example.test");
  vi.stubEnv("ACCESS_TOKEN_AUDIENCES", "platform-admin-bff");
  vi.stubEnv("ACCESS_TOKEN_KEY_ID", "bootstrap-test-key");
}

function administrativeHeaders(operatorId = adminId) {
  return {
    ...createInternalAuthorizationHeaders("platform-admin-bff", platformIdentityToken),
    "x-operator-id": operatorId,
    "x-operator-role": "platform-manager",
    [OPERATOR_ASSERTION_HEADER]: createPlatformOperatorAssertion(
      {
        operatorId,
        role: "platform-manager",
        tenantId: platformControlTenantId,
        expiresAtUnix: Math.floor(Date.now() / 1000) + 60
      },
      platformAssertionKey
    )
  };
}

function testLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function createContext(model: FreshAccessModel, logger: ReturnType<typeof testLogger>): ServiceContext {
  return {
    config: {} as ServiceContext["config"],
    db: model.database as unknown as ServiceContext["db"],
    logger,
    registerReadinessCheck: vi.fn()
  };
}

interface StoredOperator {
  id: string;
  email: string;
  display_name: string;
  role: string;
  status: string;
  password_hash: string;
}

interface StoredGrant {
  operatorId: string;
  tenantId: string;
  productId: string;
  roles: string[];
  capabilities: string[];
  active: boolean;
}

class FreshAccessModel {
  operators: StoredOperator[] = [];
  memberships = new Set<string>();
  grants: StoredGrant[] = [];
  transactionCount = 0;
  rollbackCount = 0;
  advisoryLockCount = 0;
  rowLockCount = 0;
  schemaMissing = false;
  bootstrapOwnerAllowlist: string[] = [];
  private recoveryLockTail: Promise<void> = Promise.resolve();

  seedRecoveryAdmin(operatorId: string, email: string): void {
    this.operators.push({
      id: operatorId,
      email,
      display_name: email,
      role: "admin",
      status: "active",
      password_hash: "unused-test-hash"
    });
    this.memberships.add(`${operatorId}:${platformControlTenantId}`);
    this.grants.push({
      operatorId,
      tenantId: platformControlTenantId,
      productId: "PLATFORM",
      roles: ["platform-admin"],
      capabilities: ["manage:platform"],
      active: true
    });
  }

  recoveryAdminIds(): string[] {
    return this.operators
      .filter((operator) => operator.status === "active")
      .filter((operator) =>
        this.grants.some(
          (grant) =>
            grant.operatorId === operator.id &&
            grant.tenantId === platformControlTenantId &&
            grant.productId === "PLATFORM" &&
            grant.active &&
            grant.roles.includes("platform-admin") &&
            grant.capabilities.includes("manage:platform")
        )
      )
      .map((operator) => operator.id)
      .sort();
  }

  readonly database = {
    query: async (text: string, params?: unknown[]) => this.query(text, params),
    transaction: async <T>(
      work: (transaction: { query: (text: string, params?: unknown[]) => Promise<unknown> }) => Promise<T>
    ) => {
      this.transactionCount += 1;
      let releaseRecoveryLock: (() => void) | undefined;
      let snapshot: { operators: StoredOperator[]; memberships: string[]; grants: StoredGrant[] } | undefined;
      const transaction = {
        query: async (text: string, params?: unknown[]) => {
          const sql = text.replace(/\s+/gu, " ").trim().toLowerCase();
          if (sql.startsWith("select pg_advisory_xact_lock") && !releaseRecoveryLock) {
            releaseRecoveryLock = await this.acquireRecoveryLock();
          }
          snapshot ??= structuredClone({
            operators: this.operators,
            memberships: [...this.memberships],
            grants: this.grants
          });
          return this.query(text, params);
        }
      };
      try {
        return await work(transaction);
      } catch (error) {
        this.rollbackCount += 1;
        if (snapshot) {
          this.operators = snapshot.operators;
          this.memberships = new Set(snapshot.memberships);
          this.grants = snapshot.grants;
        }
        throw error;
      } finally {
        releaseRecoveryLock?.();
      }
    },
    close: async () => undefined
  };

  private async acquireRecoveryLock(): Promise<() => void> {
    const previous = this.recoveryLockTail;
    let release!: () => void;
    this.recoveryLockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private async query(text: string, params: unknown[] = []) {
    const sql = text.replace(/\s+/gu, " ").trim().toLowerCase();
    if (sql.startsWith("select pg_advisory_xact_lock")) {
      this.advisoryLockCount += 1;
      return result([{ locked: true }]);
    }
    if (sql.includes("from platform.operators") && sql.endsWith("for update")) {
      this.rowLockCount += 1;
      return result(this.operators.map((operator) => ({ id: operator.id })));
    }
    if (sql.includes("from access_runtime.product_grants") && sql.endsWith("for update")) {
      this.rowLockCount += 1;
      return result(this.grants.map((grant) => ({ operator_id: grant.operatorId })));
    }
    if (sql.startsWith("select count(*)::integer as count")) {
      return result([{ count: this.recoveryAdminIds().length }]);
    }
    if (sql.includes("from access_runtime.bootstrap_tenants registry")) {
      if (this.schemaMissing) throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      this.bootstrapOwnerAllowlist = [...((params[2] as readonly string[] | undefined) ?? [])];
      if (params[3] !== platformControlTenantId) return result([]);
      return result([{ tenantId: platformControlTenantId }]);
    }
    if (sql.startsWith("insert into platform.operators")) {
      let operator = this.operators.find((entry) => entry.email === params[0]);
      if (!operator) {
        operator = {
          id: adminId,
          email: String(params[0]),
          display_name: String(params[1]),
          role: "admin",
          status: "active",
          password_hash: String(params[2])
        };
        this.operators.push(operator);
      }
      return result([{ id: operator.id, role: operator.role, status: operator.status }]);
    }
    if (sql.startsWith("insert into platform.operator_tenants")) {
      this.memberships.add(`${params[0]}:${params[1]}`);
      return result([]);
    }
    if (
      sql.startsWith("insert into access_runtime.product_grants") &&
      sql.includes('returning tenant_id as "tenantid"')
    ) {
      const [operatorId, tenantId, productId, roles, capabilities, active] = params;
      let grant = this.grants.find(
        (entry) => entry.operatorId === operatorId && entry.tenantId === tenantId && entry.productId === productId
      );
      if (!grant) {
        grant = {
          operatorId: String(operatorId),
          tenantId: String(tenantId),
          productId: String(productId),
          roles: roles as string[],
          capabilities: capabilities as string[],
          active: Boolean(active)
        };
        this.grants.push(grant);
      } else {
        grant.roles = [...(roles as string[])];
        grant.capabilities = [...(capabilities as string[])];
        grant.active = Boolean(active);
      }
      return result([
        {
          tenantId: grant.tenantId,
          productId: grant.productId,
          roles: grant.roles,
          capabilities: grant.capabilities,
          active: grant.active
        }
      ]);
    }
    if (sql.startsWith("insert into access_runtime.product_grants")) {
      const key = `${params[0]}:${params[1]}:PLATFORM`;
      if (!this.grants.some((grant) => `${grant.operatorId}:${grant.tenantId}:${grant.productId}` === key)) {
        this.grants.push({
          operatorId: String(params[0]),
          tenantId: String(params[1]),
          productId: "PLATFORM",
          roles: ["platform-admin"],
          capabilities: ["manage:platform"],
          active: true
        });
      }
      return result([]);
    }
    if (sql.startsWith("select exists (") && sql.includes('as "membershipexists"')) {
      const operatorId = String(params[0]);
      const tenantId = String(params[1]);
      const tenantGrants = this.grants.filter(
        (grant) => grant.operatorId === operatorId && grant.tenantId === tenantId
      );
      const exact = tenantGrants.some(
        (grant) =>
          grant.productId === "PLATFORM" &&
          grant.active &&
          grant.roles.length === 1 &&
          grant.roles[0] === "platform-admin" &&
          grant.capabilities.length === 1 &&
          grant.capabilities[0] === "manage:platform"
      );
      return result([
        {
          membershipExists: this.memberships.has(`${operatorId}:${tenantId}`),
          tenantGrantCount: tenantGrants.length,
          platformGrantCount: tenantGrants.filter((grant) => grant.productId === "PLATFORM").length,
          exactGrantExists: exact
        }
      ]);
    }
    if (sql.includes("from platform.operators") && sql.includes("where lower(email) = $1")) {
      const operator = this.operators.find((entry) => entry.email === params[0]);
      return result(
        operator
          ? [
              {
                id: operator.id,
                email: operator.email,
                display_name: operator.display_name,
                role: operator.role,
                password_hash: operator.password_hash
              }
            ]
          : []
      );
    }
    if (sql.startsWith("update platform.operators set") && !sql.includes("last_login_at")) {
      const operator = this.operators.find((entry) => entry.id === params[0]);
      if (!operator) return mutationResult(0);
      if (params[1] !== null && params[1] !== undefined) operator.display_name = String(params[1]);
      if (params[2] !== null && params[2] !== undefined) operator.role = String(params[2]);
      if (params[3] !== null && params[3] !== undefined) operator.status = String(params[3]);
      if (params[4] !== null && params[4] !== undefined) operator.password_hash = String(params[4]);
      return mutationResult(1);
    }
    if (sql.startsWith("update access_runtime.product_grants")) {
      const grant = this.grants.find(
        (entry) =>
          entry.operatorId === params[0] &&
          entry.tenantId === params[1] &&
          entry.productId === params[2] &&
          entry.active
      );
      if (!grant) return mutationResult(0);
      grant.active = false;
      return mutationResult(1);
    }
    if (sql.includes("left join platform.operator_tenants") && sql.includes("where o.id = $1")) {
      const operator = this.operators.find((entry) => entry.id === params[0]);
      return result(
        operator
          ? [
              {
                id: operator.id,
                email: operator.email,
                displayName: operator.display_name,
                role: operator.role,
                status: operator.status,
                tenantIds: [...this.memberships]
                  .filter((membership) => membership.startsWith(`${operator.id}:`))
                  .map((membership) => membership.split(":")[1]),
                createdAt: new Date("2026-01-01T00:00:00.000Z")
              }
            ]
          : []
      );
    }
    if (
      sql.startsWith('select tenant_id as "tenantid"') &&
      sql.includes("where operator_id = $1 and product_id = $2")
    ) {
      return result(
        this.grants
          .filter((grant) => grant.operatorId === params[0] && grant.productId === params[1])
          .map((grant) => ({ tenantId: grant.tenantId }))
      );
    }
    if (sql.includes("from access_runtime.product_grants") && sql.includes("where operator_id = $1")) {
      const includeInactive = Boolean(params[1]);
      return result(
        this.grants
          .filter((grant) => grant.operatorId === params[0] && (includeInactive || grant.active))
          .map((grant) => ({
            tenantId: grant.tenantId,
            productId: grant.productId,
            roles: grant.roles,
            capabilities: grant.capabilities,
            active: grant.active
          }))
      );
    }
    if (sql.startsWith("update platform.operators set last_login_at")) return result([]);
    throw new Error(`Unexpected fresh Access model query: ${sql}`);
  }
}

function result<T>(rows: T[]) {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}

function mutationResult(rowCount: number) {
  return { rows: [], rowCount, command: "", oid: 0, fields: [] };
}
