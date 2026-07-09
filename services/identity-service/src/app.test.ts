import { createService, type ServiceHandle } from "@hyperion/service-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerRoutes } from "./app.js";
import { hashPassword, readBearerToken, verifyPassword } from "./auth.js";

let app: ServiceHandle["app"];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  delete process.env.INITIAL_ADMIN_EMAIL;
  delete process.env.INITIAL_ADMIN_PASSWORD;
  const handle = await createService({
    serviceName: "identity-service",
    databaseRequired: true,
    registerRoutes
  });
  app = handle.app;
});

afterAll(async () => {
  await app.close();
});

describe("password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("clave-segura-123");

    expect(await verifyPassword("clave-segura-123", hash)).toBe(true);
    expect(await verifyPassword("clave-incorrecta", hash)).toBe(false);
  });

  it("produces unique hashes per call (random salt)", async () => {
    const first = await hashPassword("misma-clave");
    const second = await hashPassword("misma-clave");

    expect(first).not.toBe(second);
  });

  it("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("clave", "texto-plano")).toBe(false);
  });
});

describe("bearer token parsing", () => {
  it("extracts well-formed bearer tokens and rejects short or missing ones", () => {
    expect(readBearerToken("Bearer abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijklmnopqrstuvwxyz");
    expect(readBearerToken("Bearer corto")).toBeUndefined();
    expect(readBearerToken(undefined)).toBeUndefined();
    expect(readBearerToken("Basic abcdefghijklmnopqrstuvwxyz")).toBeUndefined();
  });
});

describe("identity-service routes", () => {
  it("rejects malformed login payloads", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "no-es-email", password: "corta" }
    });

    expect(response.statusCode).toBe(400);
  });

  it("requires a database for login", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "admin@hyperion.local", password: "clave-segura-123" }
    });

    expect(response.statusCode).toBe(503);
  });

  it("requires a session token on /v1/auth/me", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/auth/me" });

    expect(response.statusCode).toBe(401);
  });
});
