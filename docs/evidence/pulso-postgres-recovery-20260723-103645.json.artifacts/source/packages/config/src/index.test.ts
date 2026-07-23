import { afterEach, describe, expect, it, vi } from "vitest";
import { readServiceConfig } from "./index.js";

afterEach(() => vi.unstubAllEnvs());

describe("provider-neutral service configuration", () => {
  it("keeps legacy default ports for the compatibility runtime", () => {
    vi.stubEnv("PORT", "");
    expect(readServiceConfig("tenant-service").port).toBe(8082);
  });

  it("requires an explicit port for a new provider-owned component", () => {
    vi.stubEnv("PORT", "");
    expect(() => readServiceConfig("lumen-projection-reconciler")).toThrow(
      "PORT is required for provider-owned service"
    );

    vi.stubEnv("PORT", "8190");
    expect(readServiceConfig("lumen-projection-reconciler").port).toBe(8190);
  });
});
