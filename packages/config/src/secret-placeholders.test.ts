import { afterEach, describe, expect, it } from "vitest";
import {
  assertNoPlaceholderSecrets,
  findPlaceholderSecretProblems,
  isPlaceholderSecret,
  shouldEnforcePlaceholderRejection
} from "./secret-placeholders.js";

afterEach(() => {
  delete process.env.NODE_ENV;
  delete process.env.HYPERION_ENVIRONMENT;
  delete process.env.HYPERION_ALLOW_EXAMPLE_SECRETS;
  delete process.env.CI;
  delete process.env.POSTGRES_PASSWORD;
  delete process.env.ACCESS_DATABASE_PASSWORD;
  delete process.env.DATABASE_URL;
});

describe("placeholder secret rejection", () => {
  it("treats replace-* and known .env.example values as placeholders", () => {
    expect(isPlaceholderSecret("replace-with-real-secret")).toBe(true);
    expect(isPlaceholderSecret("REPLACE-gateway-identity-edge-001")).toBe(true);
    expect(isPlaceholderSecret("replace-access-db-secret-0001")).toBe(true);
    expect(isPlaceholderSecret("real-production-secret-value-0001")).toBe(false);
  });

  it("rejects replace-* secrets when NODE_ENV=production", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      POSTGRES_PASSWORD: "replace-with-real-secret",
      ACCESS_DATABASE_PASSWORD: "replace-access-db-secret-0001"
    };

    expect(shouldEnforcePlaceholderRejection(environment)).toBe(true);
    expect(findPlaceholderSecretProblems(environment)).toEqual(["ACCESS_DATABASE_PASSWORD", "POSTGRES_PASSWORD"]);
    expect(() => assertNoPlaceholderSecrets(environment)).toThrow(/placeholder secrets/);
  });

  it("rejects placeholders when HYPERION_ENVIRONMENT=staging even if NODE_ENV=development", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      HYPERION_ENVIRONMENT: "staging",
      POSTGRES_PASSWORD: "replace-with-real-secret"
    };

    expect(() => assertNoPlaceholderSecrets(environment)).toThrow(/POSTGRES_PASSWORD/);
  });

  it("accepts replace-* secrets in development", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      POSTGRES_PASSWORD: "replace-with-real-secret",
      ACCESS_DATABASE_PASSWORD: "replace-access-db-secret-0001"
    };

    expect(shouldEnforcePlaceholderRejection(environment)).toBe(false);
    expect(() => assertNoPlaceholderSecrets(environment)).not.toThrow();
  });

  it("accepts real secrets in production", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      POSTGRES_PASSWORD: "production-postgres-password-0001",
      DATABASE_URL: "postgres://hyperion:production-postgres-password-0001@postgres:5432/hyperion"
    };

    expect(() => assertNoPlaceholderSecrets(environment)).not.toThrow();
  });

  it("detects placeholder passwords embedded in DATABASE_URL", () => {
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "production",
      DATABASE_URL: "postgres://hyperion:replace-with-real-secret@postgres:5432/hyperion"
    };

    expect(findPlaceholderSecretProblems(environment)).toEqual(["DATABASE_URL"]);
  });
});
