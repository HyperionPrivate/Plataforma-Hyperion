import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createService } from "./index.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
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
});
