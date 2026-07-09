import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseClient } from "@hyperion/database";
import { createService } from "./index.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  delete process.env.DATABASE_URL;
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

    expect(response.json().status).toBe("down");
  });

  it("reports /ready as ok when the database is optional and missing", async () => {
    delete process.env.DATABASE_URL;
    ({ app } = await createService({ serviceName: "api-gateway", databaseRequired: false }));

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.json().status).toBe("ok");
  });

  it("reports /ready as ok when required migrations are applied", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase(["003-identity-auth.sql", "007-operator-roles.sql"]);
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      requiredMigrations: ["003-identity-auth.sql", "007-operator-roles.sql"],
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });
    const body = response.json();

    expect(body.status).toBe("ok");
    expect(body.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "postgres", status: "ok" }),
        expect.objectContaining({ name: "schema_migrations", status: "ok" })
      ])
    );
  });

  it("reports /ready as down when a required migration is missing", async () => {
    process.env.DATABASE_URL = "postgres://runtime-test";
    const db = createFakeDatabase(["003-identity-auth.sql"]);
    ({ app } = await createService({
      serviceName: "identity-service",
      databaseRequired: true,
      requiredMigrations: ["003-identity-auth.sql", "007-operator-roles.sql"],
      createDatabase: () => db
    }));

    const response = await app.inject({ method: "GET", url: "/ready" });
    const body = response.json();

    expect(body.status).toBe("down");
    expect(body.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "schema_migrations",
          status: "down",
          detail: "missing migration: 007-operator-roles.sql"
        })
      ])
    );
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
});

function createFakeDatabase(appliedMigrations: string[]): DatabaseClient {
  return {
    query: async (text: string) => {
      if (text === "select 1") {
        return { rows: [{ "?column?": 1 }] } as never;
      }

      if (text.includes("platform.schema_migrations")) {
        return { rows: appliedMigrations.map((name) => ({ name })) } as never;
      }

      return { rows: [] } as never;
    },
    close: async () => undefined
  };
}
