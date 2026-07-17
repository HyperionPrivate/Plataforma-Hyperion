import { describe, expect, it } from "vitest";
import {
  isCiDeploymentEnvironment,
  isRestrictedDeploymentEnvironment,
  readDeploymentEnvironment
} from "./deployment-environment.js";

describe("deployment environment classification", () => {
  it("uses HYPERION_ENVIRONMENT as the canonical deployment class", () => {
    expect(readDeploymentEnvironment({ NODE_ENV: "production", HYPERION_ENVIRONMENT: "local" })).toBe("local");
    expect(readDeploymentEnvironment({ NODE_ENV: "test", HYPERION_ENVIRONMENT: "production" })).toBe("production");
    expect(isRestrictedDeploymentEnvironment({ NODE_ENV: "test", HYPERION_ENVIRONMENT: "staging" })).toBe(true);
  });

  it("falls back safely to NODE_ENV when the canonical variable is absent", () => {
    expect(readDeploymentEnvironment({})).toBe("local");
    expect(readDeploymentEnvironment({ NODE_ENV: "production" })).toBe("production");
    expect(readDeploymentEnvironment({ NODE_ENV: "staging" })).toBe("staging");
    expect(readDeploymentEnvironment({ NODE_ENV: "test" })).toBe("ci");
    expect(readDeploymentEnvironment({ NODE_ENV: "ci" })).toBe("ci");
    expect(readDeploymentEnvironment({ NODE_ENV: "development" })).toBe("local");
    expect(readDeploymentEnvironment({ NODE_ENV: "local" })).toBe("local");
    expect(isCiDeploymentEnvironment({ NODE_ENV: "test" })).toBe(true);
  });

  it("fails closed when the canonical deployment class is empty or invalid", () => {
    for (const value of ["", "   ", "prodution"]) {
      expect(() => readDeploymentEnvironment({ NODE_ENV: "development", HYPERION_ENVIRONMENT: value })).toThrow(
        /HYPERION_ENVIRONMENT must be one of/
      );
    }
  });

  it("fails closed when the NODE_ENV fallback is empty or invalid", () => {
    for (const value of ["", "   ", "prodution", "preview"]) {
      expect(() => readDeploymentEnvironment({ NODE_ENV: value })).toThrow(/NODE_ENV must be one of/);
    }
  });

  it("does not let an invalid NODE_ENV override a valid canonical deployment class", () => {
    expect(() => readDeploymentEnvironment({ NODE_ENV: "development", HYPERION_ENVIRONMENT: "prodution" })).toThrow(
      /HYPERION_ENVIRONMENT must be one of/
    );
    expect(readDeploymentEnvironment({ NODE_ENV: "prodution", HYPERION_ENVIRONMENT: "production" })).toBe("production");
  });
});
