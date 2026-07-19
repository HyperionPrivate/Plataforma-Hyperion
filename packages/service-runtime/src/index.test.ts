import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "@hyperion/database";
import { createService } from "./index.js";
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  MIN_SHUTDOWN_TIMEOUT_MS,
  resolveShutdownTimeoutMs,
  resolveTrustedProxies
} from "./runtime-config.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.DATABASE_URL;
  delete process.env.EXPECTED_DATABASE_ROLE;
  delete process.env.NODE_ENV;
  delete process.env.TRUST_PROXY;
  delete process.env.SHUTDOWN_TIMEOUT_MS;
  delete process.env.HYPERION_ALLOW_EXAMPLE_SECRETS;
  delete process.env.HYPERION_ENVIRONMENT;
  delete process.env.CI;
  delete process.env.POSTGRES_PASSWORD;
});

describe("service runtime", () => {
  it("exposes liveness on /health", async () => {
    delete process.env.DATABASE_URL;
    ({ app } = await createService({ serviceName: "tenant-service", databaseRequired: true }));

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service).toBe("tenant-service");
    expect(body.status).toBe("ok");
  });

  it("reports /ready as down when the database is required but missing", async () => {
    delete process.env.DATABASE_URL;
    ({ app } = await createService({ serviceName: "tenant-service", databaseRequired: true }));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("down");
  });

  it("reports /ready as ok when the database is optional and missing", async () => {
    delete process.env.DATABASE_URL;
    ({ app } = await createService({ serviceName: "api-gateway", databaseRequired: false }));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });

  it("includes registered passive dependencies in readiness without exposing check errors", async () => {
    delete process.env.DATABASE_URL;
    let available = true;
    const sensitiveDetail = "transport-secret-must-not-leak";
    ({ app } = await createService({
      serviceName: "api-gateway",
      databaseRequired: false,
      registerRoutes: (_instance, context) => {
        context.registerReadinessCheck?.({
          name: "jetstream_publisher",
          check: async () => {
            if (!available) throw new Error(sensitiveDetail);
          }
        });
      }
    }));

    expect((await app.inject({ method: "GET", url: "/ready" })).json()).toEqual(
      expect.objectContaining({
        status: "ok",
        dependencies: expect.arrayContaining([expect.objectContaining({ name: "jetstream_publisher", status: "ok" })])
      })
    );

    available = false;
    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(
      expect.objectContaining({
        status: "down",
        dependencies: expect.arrayContaining([
          expect.objectContaining({
            name: "jetstream_publisher",
            status: "down",
            detail: "dependency readiness check failed"
          })
        ])
      })
    );
    expect(response.body).not.toContain(sensitiveDetail);
  });

  it("rejects duplicate or reserved readiness names", async () => {
    await expect(
      createService({
        serviceName: "api-gateway",
        registerRoutes: (_instance, context) => {
          context.registerReadinessCheck?.({ name: "postgres", check: () => undefined });
        }
      })
    ).rejects.toThrow("reserved or already registered");
  });

  it("reports /ready as ok from a provider-owned migration ledger", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase(["005-remove-pulso-agenda-trigger.sql"]);
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      requiredMigrationLedger: {
        schema: "access_runtime",
        migrationNames: ["005-remove-pulso-agenda-trigger.sql"]
      },
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "postgres", status: "ok" }),
        expect.objectContaining({ name: "access_runtime.migration_ledger", status: "ok" })
      ])
    );
    expect(
      vi
        .mocked(db.query)
        .mock.calls.map(([sql]) => String(sql))
        .join("\n")
    ).not.toContain("platform.schema_migrations");
  });

  it("reports /ready as down when a provider migration is missing", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase([]);
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      requiredMigrationLedger: {
        schema: "access_runtime",
        migrationNames: ["005-remove-pulso-agenda-trigger.sql"]
      },
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });
    const body = response.json();

    expect(response.statusCode).toBe(503);
    expect(body.status).toBe("down");
    expect(body.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "access_runtime.migration_ledger",
          status: "down",
          detail: "missing migration: 005-remove-pulso-agenda-trigger.sql"
        })
      ])
    );
  });

  it("accepts a complete N-1 provider ledger but rejects a forged shared terminal row", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const legacy = ["001-legacy-access.sql", "002-legacy-access.sql", "006-access-ready.sql"];
    const requirement = {
      schema: "access_runtime",
      migrationNames: ["001-fresh-access.sql", "006-access-ready.sql"],
      compatibleMigrationNameSets: [legacy]
    } as const;

    const legacyDb = createFakeDatabase(legacy);
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      requiredMigrationLedger: requirement,
      createDatabase: () => legacyDb
    }));
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    await app.close();

    const forgedDb = createFakeDatabase(["006-access-ready.sql"]);
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      requiredMigrationLedger: requirement,
      createDatabase: () => forgedDb
    }));
    const forged = await app.inject({ method: "GET", url: "/ready" });
    expect(forged.statusCode).toBe(503);
    expect(forged.json().dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ detail: "missing migration: 001-fresh-access.sql" })])
    );
  });

  it("requires an exact checksum ledger and rejects mixed rows", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const requirement = {
      schema: "access_runtime",
      migrationNames: ["001-access.sql", "002-access.sql"],
      exactMigrationLedger: [
        { name: "001-access.sql", checksum: "a".repeat(64) },
        { name: "002-access.sql", checksum: "b".repeat(64) }
      ]
    } as const;
    const exact = createFakeDatabase([...requirement.exactMigrationLedger]);
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      requiredMigrationLedger: requirement,
      createDatabase: () => exact
    }));
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    await app.close();

    const mixed = createFakeDatabase([
      ...requirement.exactMigrationLedger,
      { name: "999-foreign.sql", checksum: "f".repeat(64) }
    ]);
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      requiredMigrationLedger: requirement,
      createDatabase: () => mixed
    }));
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(503);
  });

  it("forbids the global migration ledger as a provider-owned requirement", async () => {
    await expect(
      createService({
        serviceName: "identity-service",
        requiredMigrationLedger: { schema: "platform", migrationNames: ["001-platform.sql"] }
      })
    ).rejects.toThrow("provider-owned ledger");
  });

  it("limits the transitional global ledger gate to Audit", async () => {
    await expect(
      createService({
        serviceName: "identity-service",
        requiredLegacyMigrationNames: ["001-platform.sql"]
      })
    ).rejects.toThrow("restricted to audit-service");

    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase(["025-audit-ledger-autonomy.sql"]);
    ({ app } = await createService({
      serviceName: "audit-service",
      databaseRequired: true,
      requiredLegacyMigrationNames: ["025-audit-ledger-autonomy.sql"],
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().dependencies).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "legacy.platform.schema_migrations", status: "ok" })])
    );
  });

  it("keeps Audit down when its transitional migration gate is incomplete", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase(["025-audit-ledger-autonomy.sql"]);
    ({ app } = await createService({
      serviceName: "audit-service",
      databaseRequired: true,
      requiredLegacyMigrationNames: ["025-audit-ledger-autonomy.sql", "026-audit-source-provenance.sql"],
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json().dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "legacy.platform.schema_migrations",
          status: "down",
          detail: "missing legacy migration: 026-audit-source-provenance.sql"
        })
      ])
    );
  });

  it("rejects ambiguous database schema readiness requirements", async () => {
    await expect(
      createService({
        serviceName: "lumen-service",
        requiredMigrationLedger: { schema: "lumen", migrationNames: ["001-lumen.sql"] },
        requiredSchemaVersion: { schema: "lumen", serviceName: "lumen", minimumVersion: 40 }
      })
    ).rejects.toThrow("exactly one database schema readiness requirement");
  });

  it("does not silently ignore a schema requirement on an optional database", async () => {
    await expect(
      createService({
        serviceName: "lumen-service",
        requiredSchemaVersion: { schema: "lumen", serviceName: "lumen", minimumVersion: 40 }
      })
    ).rejects.toThrow("require databaseRequired: true");
  });

  it("verifies the configured non-administrative database identity", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    process.env.EXPECTED_DATABASE_ROLE = "hyperion_tenant";
    const db = createFakeDatabase([], {}, { currentRole: "hyperion_tenant" });
    ({ app } = await createService({
      serviceName: "tenant-service",
      databaseRequired: true,
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({
        status: "ok",
        dependencies: expect.arrayContaining([
          expect.objectContaining({
            name: "postgres_role",
            status: "ok",
            detail: "connected as hyperion_tenant"
          })
        ])
      })
    );
  });

  it("keeps Identity and Tenant on distinct provider runtime roles", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    process.env.EXPECTED_DATABASE_ROLE = "hyperion_identity";
    const db = createFakeDatabase([], {}, { currentRole: "hyperion_identity" });
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "postgres_role",
          status: "ok",
          detail: "connected as hyperion_identity"
        })
      ])
    );
  });

  it("accepts bootstrap VALID UNTIL infinity as a never-expiring password", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    process.env.EXPECTED_DATABASE_ROLE = "hyperion_channel";
    for (const rolvaliduntil of [
      "infinity",
      "Infinity",
      Number.POSITIVE_INFINITY,
      new Date(Number.POSITIVE_INFINITY)
    ]) {
      const db = createFakeDatabase([], {}, { currentRole: "hyperion_channel", rolvaliduntil });
      ({ app } = await createService({
        serviceName: "whatsapp-channel-service",
        databaseRequired: true,
        createDatabase: () => db
      }));
      const response = await app.inject({ method: "GET", url: "/ready" });
      expect(response.statusCode).toBe(200);
      await app.close();
      app = undefined as never;
    }
  });

  it("fails closed before route or worker registration for a wrong or administrative database identity", async () => {
    for (const identity of [
      { currentRole: "hyperion_audit" },
      { currentRole: "hyperion_tenant", sessionRole: "hyperion" },
      { currentRole: "hyperion_tenant", hasMemberships: true },
      { currentRole: "hyperion_tenant", rolsuper: true },
      { currentRole: "hyperion_tenant", rolconnlimit: 10 },
      { currentRole: "hyperion_tenant", rolvaliduntil: "2099-01-01T00:00:00Z" },
      { currentRole: "hyperion_tenant", rolvaliduntil: Date.now() },
      { currentRole: "hyperion_tenant", rolvaliduntil: Number.NEGATIVE_INFINITY },
      { currentRole: "hyperion_tenant", rolvaliduntil: new Date("2099-01-01T00:00:00Z") },
      { currentRole: "hyperion_tenant", rolconfig: ["search_path=attacker,pg_catalog"] }
    ]) {
      process.env.DATABASE_URL = "postgres://runtime-test";
      process.env.EXPECTED_DATABASE_ROLE = "hyperion_tenant";
      const db = createFakeDatabase([], {}, identity);
      let routesRegistered = false;
      await expect(
        createService({
          serviceName: "tenant-service",
          databaseRequired: true,
          createDatabase: () => db,
          registerRoutes: () => {
            routesRegistered = true;
          }
        })
      ).rejects.toThrow("database identity verification failed");

      expect(routesRegistered).toBe(false);
      expect(db.close).toHaveBeenCalledOnce();
    }
  });

  it("requires an explicit database identity in production", async () => {
    process.env.NODE_ENV = "test";
    process.env.HYPERION_ENVIRONMENT = "production";
    process.env.DATABASE_URL = "postgres://runtime-test";
    let databaseCreated = false;
    let routesRegistered = false;

    await expect(
      createService({
        serviceName: "tenant-service",
        databaseRequired: true,
        createDatabase: () => {
          databaseCreated = true;
          return createFakeDatabase([]);
        },
        registerRoutes: () => {
          routesRegistered = true;
        }
      })
    ).rejects.toThrow("EXPECTED_DATABASE_ROLE is required");

    expect(databaseCreated).toBe(false);
    expect(routesRegistered).toBe(false);
  });

  it("refuses .env.example placeholder secrets in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.POSTGRES_PASSWORD = "replace-with-real-secret";
    process.env.DATABASE_URL = "postgres://runtime-test";
    delete process.env.HYPERION_ALLOW_EXAMPLE_SECRETS;
    delete process.env.CI;

    await expect(
      createService({
        serviceName: "tenant-service",
        databaseRequired: false
      })
    ).rejects.toThrow(/placeholder secrets/);
  });

  it("rejects malformed deployment declarations before database or route side effects", async () => {
    for (const testCase of [
      {
        environment: { NODE_ENV: "development", HYPERION_ENVIRONMENT: "   " },
        expectedError: /HYPERION_ENVIRONMENT must be one of/
      },
      {
        environment: { NODE_ENV: "prodution" },
        expectedError: /NODE_ENV must be one of/
      }
    ]) {
      delete process.env.NODE_ENV;
      delete process.env.HYPERION_ENVIRONMENT;
      Object.assign(process.env, testCase.environment);
      process.env.DATABASE_URL = "postgres://runtime-test";
      const createDatabase = vi.fn(() => createFakeDatabase([]));
      const registerRoutes = vi.fn();

      await expect(
        createService({
          serviceName: "tenant-service",
          databaseRequired: true,
          createDatabase,
          registerRoutes
        })
      ).rejects.toThrow(testCase.expectedError);

      expect(createDatabase).not.toHaveBeenCalled();
      expect(registerRoutes).not.toHaveBeenCalled();
    }
  });

  it("binds the configured database identity to the service context", async () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://runtime-test";
    process.env.EXPECTED_DATABASE_ROLE = "hyperion_audit";
    let databaseCreated = false;

    await expect(
      createService({
        serviceName: "agent-service",
        databaseRequired: true,
        createDatabase: () => {
          databaseCreated = true;
          return createFakeDatabase([]);
        }
      })
    ).rejects.toThrow("does not match the service database identity");

    expect(databaseCreated).toBe(false);
  });

  it("rejects an unsafe expected database role identifier", async () => {
    process.env.EXPECTED_DATABASE_ROLE = 'hyperion_access";set role hyperion;--';

    await expect(createService({ serviceName: "tenant-service" })).rejects.toThrow(
      "EXPECTED_DATABASE_ROLE must be a safe PostgreSQL role identifier"
    );
  });

  it("uses a service-owned schema version for readiness", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase([], { lumen: 22 });
    ({ app } = await createService({
      serviceName: "lumen-service",
      databaseRequired: true,
      requiredSchemaVersion: { schema: "lumen", serviceName: "lumen", minimumVersion: 22 },
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "lumen.schema_version",
          status: "ok",
          detail: "schema version >= 22"
        })
      ])
    );
  });

  it("fails readiness when the service-owned schema version is stale", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase([], { lumen: 21 });
    ({ app } = await createService({
      serviceName: "lumen-service",
      databaseRequired: true,
      requiredSchemaVersion: { schema: "lumen", serviceName: "lumen", minimumVersion: 22 },
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual(
      expect.objectContaining({
        status: "down",
        dependencies: expect.arrayContaining([
          expect.objectContaining({
            name: "lumen.schema_version",
            status: "down",
            detail: "schema version 21 is below required 22"
          })
        ])
      })
    );
  });

  it("fails SOFIA readiness closed when its local marker is absent or zero despite a current global marker", async () => {
    for (const localVersion of [undefined, 0] as const) {
      process.env.DATABASE_URL = "postgres://runtime-test";
      const schemaVersions: Record<string, number> = { pulso_iris: 3 };
      if (localVersion !== undefined) schemaVersions.agent_runtime = localVersion;
      const db = createFakeDatabase([], schemaVersions);
      ({ app } = await createService({
        serviceName: "agent-service",
        databaseRequired: true,
        requiredSchemaVersion: { schema: "agent_runtime", serviceName: "sofia", minimumVersion: 1 },
        createDatabase: () => db
      }));

      const response = await app.inject({ method: "GET", url: "/ready" });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual(
        expect.objectContaining({
          status: "down",
          dependencies: expect.arrayContaining([
            expect.objectContaining({
              name: "agent_runtime.schema_version",
              status: "down",
              detail: "schema version is missing; require >= 1"
            })
          ])
        })
      );
      expect(db.query).toHaveBeenCalledWith(expect.stringContaining('from "agent_runtime".schema_version'), ["sofia"]);
      expect(
        vi
          .mocked(db.query)
          .mock.calls.map(([sql]) => String(sql))
          .join("\n")
      ).not.toContain('from "pulso_iris".schema_version');

      await app.close();
      app = undefined;
    }
  });

  it("ignores a stale global PULSO marker when SOFIA's local marker is current", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase([], { agent_runtime: 1, pulso_iris: 1 });
    ({ app } = await createService({
      serviceName: "prompt-flow-service",
      databaseRequired: true,
      requiredSchemaVersion: { schema: "agent_runtime", serviceName: "sofia", minimumVersion: 1 },
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json().dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "agent_runtime.schema_version",
          status: "ok",
          detail: "schema version >= 1"
        })
      ])
    );
    expect(
      vi
        .mocked(db.query)
        .mock.calls.map(([sql]) => String(sql))
        .join("\n")
    ).not.toContain('from "pulso_iris".schema_version');
  });

  it("rejects unsafe service-owned schema identifiers", async () => {
    await expect(
      createService({
        serviceName: "lumen-service",
        requiredSchemaVersion: { schema: 'lumen";drop schema lumen;--', serviceName: "lumen", minimumVersion: 22 }
      })
    ).rejects.toThrow(/safe identifiers/);
  });

  it("honors and echoes an incoming x-request-id header", async () => {
    delete process.env.DATABASE_URL;
    ({ app } = await createService({ serviceName: "tenant-service", databaseRequired: true }));

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "corr-12345" }
    });

    expect(response.headers["x-request-id"]).toBe("corr-12345");
  });

  it("generates a request id when none is provided", async () => {
    delete process.env.DATABASE_URL;
    ({ app } = await createService({ serviceName: "tenant-service", databaseRequired: true }));

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(String(response.headers["x-request-id"])).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("drains route-owned close hooks before closing the database pool", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const closeOrder: string[] = [];
    const db = createFakeDatabase([]);
    vi.mocked(db.close).mockImplementation(async () => {
      closeOrder.push("database");
    });

    ({ app } = await createService({
      serviceName: "tenant-service",
      createDatabase: () => db,
      registerRoutes: (instance) => {
        instance.addHook("onClose", async () => {
          closeOrder.push("dispatcher");
        });
      }
    }));

    await app.close();
    app = undefined;

    expect(closeOrder).toEqual(["dispatcher", "database"]);
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("uses a safe drain budget and permits only bounded overrides", () => {
    expect(resolveShutdownTimeoutMs(undefined, undefined)).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(50_000);
    expect(resolveShutdownTimeoutMs(90_000, undefined)).toBe(90_000);
    expect(resolveShutdownTimeoutMs(undefined, "120000")).toBe(120_000);
    expect(() => resolveShutdownTimeoutMs(10_000, undefined)).toThrow(/SHUTDOWN_TIMEOUT_MS/);
    expect(() => resolveShutdownTimeoutMs(undefined, String(MIN_SHUTDOWN_TIMEOUT_MS - 1))).toThrow(
      /SHUTDOWN_TIMEOUT_MS/
    );
  });

  it("does not trust forwarded addresses unless an explicit proxy is configured", async () => {
    ({ app } = await createService({
      serviceName: "api-gateway",
      registerRoutes: (instance) => {
        instance.get("/client-ip", async (request) => ({ ip: request.ip }));
      }
    }));

    const response = await app.inject({
      method: "GET",
      url: "/client-ip",
      headers: { "x-forwarded-for": "203.0.113.25" }
    });

    expect(response.json().ip).not.toBe("203.0.113.25");
  });

  it("accepts only explicit IP or CIDR trust-proxy rules and rejects trust-all", () => {
    expect(resolveTrustedProxies(undefined)).toBe(false);
    expect(resolveTrustedProxies("127.0.0.1,10.20.0.0/16")).toEqual(["127.0.0.1", "10.20.0.0/16"]);
    expect(() => resolveTrustedProxies("true")).toThrow(/trust-all/);
    expect(() => resolveTrustedProxies("0.0.0.0/0")).toThrow(/explicit proxy/);
    expect(() => resolveTrustedProxies("proxy.internal")).toThrow(/explicit proxy/);
  });
});

function createFakeDatabase(
  appliedMigrations: Array<string | { name: string; checksum: string }>,
  schemaVersions: Record<string, number> = {},
  databaseIdentity: Partial<{
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
  }> = {}
): DatabaseClient {
  const database: DatabaseClient = {
    query: vi.fn(async (text: string) => {
      if (text === "select 1") {
        return { rows: [{ "?column?": 1 }] } as never;
      }

      if (text.includes("platform.schema_migrations") || text.includes(".migration_ledger")) {
        return {
          rows: appliedMigrations.map((entry) => (typeof entry === "string" ? { name: entry } : entry))
        } as never;
      }

      if (text.includes("from pg_catalog.pg_roles")) {
        const currentRole = databaseIdentity.currentRole ?? "hyperion_access";
        return {
          rows: [
            {
              currentRole,
              hasMemberships: false,
              rolbypassrls: false,
              rolcanlogin: true,
              rolconfig: null,
              rolconnlimit: -1,
              rolcreatedb: false,
              rolcreaterole: false,
              rolinherit: false,
              rolreplication: false,
              rolsuper: false,
              rolvaliduntil: null,
              sessionRole: currentRole,
              ...databaseIdentity
            }
          ]
        } as never;
      }

      const schemaVersion = text.match(/from "([a-z_][a-z0-9_]*)"\.schema_version/i)?.[1];
      if (schemaVersion) {
        const currentVersion = schemaVersions[schemaVersion];
        return { rows: currentVersion === undefined ? [] : [{ current_version: currentVersion }] } as never;
      }

      return { rows: [] } as never;
    }),
    transaction: async (work) => work(database as never),
    close: vi.fn(async () => undefined)
  };
  return database;
}
