import { afterEach, describe, expect, it, vi } from "vitest";
import { isVerificationSimulatorEnabled, runSimulatorTick } from "./appointment-verification-simulator.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalHyperionEnv = process.env.HYPERION_ENVIRONMENT;
const originalSimulator = process.env.VERIFICATION_SIMULATOR_ENABLED;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalHyperionEnv === undefined) delete process.env.HYPERION_ENVIRONMENT;
  else process.env.HYPERION_ENVIRONMENT = originalHyperionEnv;
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

  it("never queries or verifies appointments in canonical production", async () => {
    process.env.NODE_ENV = "test";
    process.env.HYPERION_ENVIRONMENT = "production";
    process.env.VERIFICATION_SIMULATOR_ENABLED = "true";
    const query = vi.fn();
    const warn = vi.fn();

    const completed = await runSimulatorTick({ query } as never, vi.fn(), { logger: { warn } as never });

    expect(completed).toBe(0);
    expect(query).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("verification simulator blocked in production/staging");
  });

  it("persists the simulated verification and audit through the same transaction executor", async () => {
    process.env.NODE_ENV = "test";
    const action = {
      id: "00000000-0000-4000-8000-000000000021",
      tenantId: "00000000-0000-4000-8000-000000000022",
      appointmentId: "00000000-0000-4000-8000-000000000023",
      actionType: "register_appointment",
      workerId: "00000000-0000-4000-8000-000000000024"
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [action] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: action.appointmentId }] });
    const tx = { query };
    const transaction = vi.fn(async (work: (executor: typeof tx) => Promise<unknown>) => work(tx));
    const emitAudit = vi.fn();

    await expect(runSimulatorTick({ transaction } as never, emitAudit)).resolves.toBe(1);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(emitAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "appointment.verified",
        entityId: action.appointmentId
      }),
      tx
    );
  });

  it("propagates an audit failure so the transaction can roll back the simulator batch", async () => {
    process.env.NODE_ENV = "test";
    let actionStatus: "queued" | "running" | "succeeded" = "queued";
    let queryIndex = 0;
    const tx = {
      query: vi.fn(async () => {
        queryIndex += 1;
        if (queryIndex === 1) {
          actionStatus = "running";
          return {
            rowCount: 1,
            rows: [
              {
                id: "00000000-0000-4000-8000-000000000025",
                tenantId: "00000000-0000-4000-8000-000000000026",
                appointmentId: "00000000-0000-4000-8000-000000000027",
                actionType: "register_appointment",
                workerId: null
              }
            ]
          };
        }
        if (queryIndex === 2) actionStatus = "succeeded";
        if (queryIndex === 4) return { rowCount: 1, rows: [{ id: "00000000-0000-4000-8000-000000000027" }] };
        return { rowCount: 1, rows: [] };
      })
    };
    const transaction = vi.fn(async (work: (executor: typeof tx) => Promise<unknown>) => {
      const initialStatus = actionStatus;
      try {
        return await work(tx);
      } catch (error) {
        actionStatus = initialStatus;
        throw error;
      }
    });
    const emitAudit = vi.fn(async (_input: unknown, _executor: unknown) => {
      throw new Error("audit unavailable");
    });

    await expect(runSimulatorTick({ transaction } as never, emitAudit)).rejects.toThrow("audit unavailable");
    expect(actionStatus).toBe("queued");
    expect(emitAudit.mock.calls[0]?.[1]).toBe(tx);
  });
});
