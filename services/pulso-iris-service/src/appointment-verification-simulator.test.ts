import { afterEach, describe, expect, it, vi } from "vitest";
import { isVerificationSimulatorEnabled, runSimulatorTick } from "./appointment-verification-simulator.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalSimulator = process.env.VERIFICATION_SIMULATOR_ENABLED;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalSimulator === undefined) delete process.env.VERIFICATION_SIMULATOR_ENABLED;
  else process.env.VERIFICATION_SIMULATOR_ENABLED = originalSimulator;
});

describe("appointment verification simulator guard", () => {
  it("is disabled by default", () => {
    process.env.NODE_ENV = "test";
    delete process.env.VERIFICATION_SIMULATOR_ENABLED;
    expect(isVerificationSimulatorEnabled()).toBe(false);
  });

  it("can be enabled explicitly outside production", () => {
    process.env.NODE_ENV = "test";
    process.env.VERIFICATION_SIMULATOR_ENABLED = "true";
    expect(isVerificationSimulatorEnabled()).toBe(true);
  });

  it("never queries or verifies appointments in production", async () => {
    process.env.NODE_ENV = "production";
    process.env.VERIFICATION_SIMULATOR_ENABLED = "true";
    const query = vi.fn();
    const warn = vi.fn();

    const completed = await runSimulatorTick({ query } as never, vi.fn(), { logger: { warn } as never });

    expect(completed).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("verification simulator blocked in production");
  });
});
