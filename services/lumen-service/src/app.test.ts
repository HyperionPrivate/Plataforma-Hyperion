import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";

const TENANT = "7d9a1a5e-1c2b-4f3a-9b8c-2d4e6f8a0b1c";
let app: ServiceHandle["app"];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  const handle = await createService({ serviceName: "lumen-service", databaseRequired: true, registerRoutes });
  app = handle.app;
});

afterAll(async () => app.close());

describe("lumen-service", () => {
  it("exposes catalog and provider readiness without secrets", async () => {
    const catalog = await app.inject({ method: "GET", url: "/v1/lumen/catalog" });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().data.product.code).toBe("LUMEN");

    const health = await app.inject({ method: "GET", url: "/v1/lumen/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().data.providers).toMatchObject({
      transcriptionConfigured: false,
      transcriptionProvider: "elevenlabs",
      transcriptionModel: "scribe_v2",
      transcriptionLanguage: "spa",
      zeroRetentionRequired: true,
      structuringConfigured: false,
      structuringProvider: "deepseek"
    });
  });

  it("rejects invalid tenants and reports a missing database", async () => {
    const invalid = await app.inject({ method: "GET", url: "/v1/tenants/no-uuid/lumen/worklist" });
    expect(invalid.statusCode).toBe(400);

    const unavailable = await app.inject({ method: "GET", url: `/v1/tenants/${TENANT}/lumen/worklist` });
    expect(unavailable.statusCode).toBe(503);
  });
});
