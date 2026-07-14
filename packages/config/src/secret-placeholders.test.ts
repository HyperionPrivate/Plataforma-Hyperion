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
      HYPERION_ALLOW_EXAMPLE_SECRETS: "true",
      CI: "true",
      POSTGRES_PASSWORD: "replace-with-real-secret"
    };

    expect(() => assertNoPlaceholderSecrets(environment)).toThrow(/POSTGRES_PASSWORD/);
  });

  it("does not let CI or the legacy example-secret flag downgrade production", () => {
    for (const environment of [
      {
        NODE_ENV: "production",
        CI: "true",
        POSTGRES_PASSWORD: "replace-with-real-secret"
      },
      {
        NODE_ENV: "production",
        HYPERION_ALLOW_EXAMPLE_SECRETS: "true",
        POSTGRES_PASSWORD: "replace-with-real-secret"
      },
      {
        NODE_ENV: "production",
        CI: "true",
        HYPERION_ALLOW_EXAMPLE_SECRETS: "true",
        POSTGRES_PASSWORD: "replace-with-real-secret"
      }
    ] satisfies NodeJS.ProcessEnv[]) {
      expect(shouldEnforcePlaceholderRejection(environment)).toBe(true);
      expect(() => assertNoPlaceholderSecrets(environment)).toThrow(/POSTGRES_PASSWORD/);
    }
  });

  it("rejects empty or invalid deployment declarations instead of guessing", () => {
    for (const hyperionEnvironment of ["", "   ", "unexpected"]) {
      expect(() =>
        shouldEnforcePlaceholderRejection({
          NODE_ENV: "development",
          HYPERION_ENVIRONMENT: hyperionEnvironment,
          POSTGRES_PASSWORD: "replace-with-real-secret"
        })
      ).toThrow(/HYPERION_ENVIRONMENT must be one of/);
    }

    for (const nodeEnvironment of ["", "   ", "prodution"]) {
      expect(() =>
        shouldEnforcePlaceholderRejection({
          NODE_ENV: nodeEnvironment,
          POSTGRES_PASSWORD: "replace-with-real-secret"
        })
      ).toThrow(/NODE_ENV must be one of/);
    }
  });

  it("allows placeholders only in an explicitly declared local or CI rehearsal", () => {
    for (const hyperionEnvironment of ["local", "ci"]) {
      const environment: NodeJS.ProcessEnv = {
        NODE_ENV: "production",
        HYPERION_ENVIRONMENT: hyperionEnvironment,
        POSTGRES_PASSWORD: "replace-with-real-secret"
      };

      expect(shouldEnforcePlaceholderRejection(environment)).toBe(false);
      expect(() => assertNoPlaceholderSecrets(environment)).not.toThrow();
    }
  });

  it("checks the credential name used by the JetStream topology workload", () => {
    const environment: NodeJS.ProcessEnv = {
      HYPERION_ENVIRONMENT: "production",
      NATS_PASSWORD: "replace-topology-nats-secret-01"
    };

    expect(findPlaceholderSecretProblems(environment)).toEqual(["NATS_PASSWORD"]);
    expect(() => assertNoPlaceholderSecrets(environment)).toThrow(/NATS_PASSWORD/);
  });

  it("checks the legacy NATS token credential", () => {
    const environment: NodeJS.ProcessEnv = {
      HYPERION_ENVIRONMENT: "production",
      NATS_AUTH_TOKEN: "replace-with-real-secret"
    };

    expect(findPlaceholderSecretProblems(environment)).toEqual(["NATS_AUTH_TOKEN"]);
    expect(() => assertNoPlaceholderSecrets(environment)).toThrow(/NATS_AUTH_TOKEN/);
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
