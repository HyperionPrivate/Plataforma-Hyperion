import type { DatabaseExecutor } from "@hyperion/database";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  acquireAudioCleanupOwnerLease,
  readLumenAudioCleanupConfiguration,
  reconcilePendingAudioCleanup,
  startLumenAudioCleanupReconciler,
  type AudioCleanupLease
} from "./audio-cleanup-recovery.js";

interface FakeAttempt {
  id: string;
  owner: string;
  protocol?: "deterministic_v2" | "legacy_ephemeral_v1";
  status: "processing" | "cleanup_pending" | "failed" | "cancelled";
  target?: "failed" | "cancelled";
  deleted: boolean;
}

interface FakeLease {
  holderId: string;
  active: boolean;
}

function fakeDatabase(
  attempts: FakeAttempt[],
  leases = new Map<string, FakeLease>()
): { db: DatabaseExecutor; leases: Map<string, FakeLease> } {
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const owner = String(params[0] ?? "");
      const holderId = String(params[1] ?? "");
      if (sql.includes("insert into lumen.audio_cleanup_owner_leases")) {
        const existing = leases.get(owner);
        if (existing?.active) return { rows: [], rowCount: 0 } as never;
        leases.set(owner, { holderId, active: true });
        return { rows: [{ holderId }], rowCount: 1 } as never;
      }
      if (sql.includes("update lumen.audio_cleanup_owner_leases")) {
        const existing = leases.get(owner);
        return { rows: [], rowCount: existing?.active && existing.holderId === holderId ? 1 : 0 } as never;
      }
      if (sql.includes("attempt.cleanup_owner <> $1")) {
        const orphaned = attempts.some(
          (attempt) =>
            attempt.owner !== owner &&
            attempt.protocol !== "legacy_ephemeral_v1" &&
            (attempt.status === "processing" || attempt.status === "cleanup_pending") &&
            !leases.get(attempt.owner)?.active
        );
        return {
          rows: orphaned ? [{ "?column?": 1 }] : [],
          rowCount: orphaned ? 1 : 0
        } as never;
      }
      if (sql.trimStart().startsWith("select 1") && sql.includes("lumen.audio_cleanup_owner_leases")) {
        const existing = leases.get(owner);
        return {
          rows: existing?.active && existing.holderId === holderId ? [{ "?column?": 1 }] : [],
          rowCount: existing?.active && existing.holderId === holderId ? 1 : 0
        } as never;
      }
      if (sql.includes("delete from lumen.audio_cleanup_owner_leases")) {
        const existing = leases.get(owner);
        if (existing?.holderId === holderId) leases.delete(owner);
        return { rows: [], rowCount: existing?.holderId === holderId ? 1 : 0 } as never;
      }
      if (sql.includes("set status = 'cleanup_pending'")) {
        const existing = leases.get(owner);
        if (!existing?.active || existing.holderId !== holderId) return { rows: [], rowCount: 0 } as never;
        let rowCount = 0;
        for (const attempt of attempts) {
          if (
            attempt.status === "processing" &&
            attempt.owner === owner &&
            attempt.protocol !== "legacy_ephemeral_v1"
          ) {
            attempt.status = "cleanup_pending";
            attempt.target = "failed";
            rowCount += 1;
          }
        }
        return { rows: [], rowCount } as never;
      }
      if (sql.includes("select attempt.id") && sql.includes("status = 'cleanup_pending'")) {
        const existing = leases.get(owner);
        const rows =
          existing?.active && existing.holderId === holderId
            ? attempts
                .filter(
                  (attempt) =>
                    attempt.status === "cleanup_pending" &&
                    attempt.owner === owner &&
                    attempt.protocol !== "legacy_ephemeral_v1"
                )
                .slice(0, Number(params[2]))
                .map(({ id }) => ({ id }))
            : [];
        return { rows, rowCount: rows.length } as never;
      }
      if (sql.includes("set status = cleanup_target_status")) {
        const attemptOwner = String(params[1]);
        const leaseHolder = String(params[2]);
        const existing = leases.get(attemptOwner);
        const attempt = attempts.find(
          (entry) =>
            entry.id === params[0] &&
            entry.owner === attemptOwner &&
            entry.protocol !== "legacy_ephemeral_v1" &&
            entry.status === "cleanup_pending" &&
            existing?.active &&
            existing.holderId === leaseHolder
        );
        if (!attempt?.target) return { rows: [], rowCount: 0 } as never;
        attempt.status = attempt.target;
        attempt.target = undefined;
        attempt.deleted = true;
        return { rows: [], rowCount: 1 } as never;
      }
      throw new Error(`Unexpected query: ${sql}`);
    }) as DatabaseExecutor["query"]
  };
  return { db, leases };
}

const configuration = {
  owner: "lumen-pod-1",
  rootDirectory: "C:/private/lumen-audio",
  retryIntervalMs: 60_000,
  batchSize: 25,
  leaseTtlMs: 30 * 60_000,
  heartbeatIntervalMs: 30_000
} as const;

function lease(owner = configuration.owner, holderId = randomUUID()): AudioCleanupLease {
  return { owner, holderId, ttlMs: configuration.leaseTtlMs };
}

describe("LUMEN temporary-audio cleanup recovery", () => {
  it("recovers only the stable owner's attempts after acquiring its exclusive lease", async () => {
    const own = { id: randomUUID(), owner: configuration.owner, status: "processing", deleted: false } as FakeAttempt;
    const foreign = { id: randomUUID(), owner: "lumen-pod-2", status: "processing", deleted: false } as FakeAttempt;
    const attempts = [own, foreign];
    const { db } = fakeDatabase(attempts, new Map([[foreign.owner, { holderId: randomUUID(), active: true }]]));
    const removed: string[] = [];

    const reconciler = await startLumenAudioCleanupReconciler(db, configuration, {
      holderId: randomUUID(),
      removeDirectory: async (path) => {
        removed.push(path);
      }
    });

    expect(own).toMatchObject({ status: "failed", deleted: true });
    expect(foreign).toMatchObject({ status: "processing", deleted: false });
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain(`attempt-${own.id}`);
    await reconciler.stop();
  });

  it("rejects a duplicate live owner before it can recover or delete active audio", async () => {
    const attempts: FakeAttempt[] = [];
    const { db } = fakeDatabase(attempts);
    const first = await startLumenAudioCleanupReconciler(db, configuration, { holderId: randomUUID() });
    const activeAttempt = {
      id: randomUUID(),
      owner: configuration.owner,
      status: "processing",
      deleted: false
    } as FakeAttempt;
    attempts.push(activeAttempt);
    const removeDirectory = vi.fn<(path: string) => Promise<void>>();

    await expect(
      startLumenAudioCleanupReconciler(db, configuration, { holderId: randomUUID(), removeDirectory })
    ).rejects.toThrow("already has an active audio cleanup owner lease");
    expect(activeAttempt).toMatchObject({ status: "processing", deleted: false });
    expect(removeDirectory).not.toHaveBeenCalled();
    await first.stop();
  });

  it("never recovers, selects or finalizes a legacy ephemeral attempt", async () => {
    const legacy = {
      id: randomUUID(),
      owner: configuration.owner,
      protocol: "legacy_ephemeral_v1",
      status: "processing",
      deleted: false
    } as FakeAttempt;
    const { db } = fakeDatabase([legacy]);
    const removeDirectory = vi.fn<(path: string) => Promise<void>>();

    const reconciler = await startLumenAudioCleanupReconciler(db, configuration, {
      holderId: randomUUID(),
      removeDirectory
    });

    expect(legacy).toMatchObject({ status: "processing", deleted: false });
    expect(removeDirectory).not.toHaveBeenCalled();
    const statements = (db.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => String(sql));
    expect(
      statements
        .filter((sql) => sql.includes("lumen.processing_attempts"))
        .every((sql) => sql.includes("cleanup_protocol = 'deterministic_v2'"))
    ).toBe(true);
    await reconciler.stop();
  });

  it("lets a new process holder recover the same owner after its prior lease expired", async () => {
    const previousHolder = randomUUID();
    const attempts = [
      { id: randomUUID(), owner: configuration.owner, status: "processing", deleted: false } as FakeAttempt
    ];
    const { db, leases } = fakeDatabase(
      attempts,
      new Map([[configuration.owner, { holderId: previousHolder, active: false }]])
    );
    const newHolder = randomUUID();

    const reconciler = await startLumenAudioCleanupReconciler(db, configuration, {
      holderId: newHolder,
      removeDirectory: async () => undefined
    });

    expect(newHolder).not.toBe(previousHolder);
    expect(attempts[0]).toMatchObject({ status: "failed", deleted: true });
    expect(leases.get(configuration.owner)).toMatchObject({ holderId: newHolder, active: true });
    await reconciler.stop();
  });

  it("fails closed when unresolved work belongs to an expired foreign owner", async () => {
    const foreignOwner = "lumen-retired-pod";
    const attempts = [
      { id: randomUUID(), owner: foreignOwner, status: "cleanup_pending", deleted: false } as FakeAttempt
    ];
    const { db, leases } = fakeDatabase(attempts, new Map([[foreignOwner, { holderId: randomUUID(), active: false }]]));

    await expect(startLumenAudioCleanupReconciler(db, configuration, { holderId: randomUUID() })).rejects.toThrow(
      "expired or missing workload identity"
    );
    expect(leases.has(configuration.owner)).toBe(false);
    expect(attempts[0]).toMatchObject({ status: "cleanup_pending", deleted: false });
  });

  it("lets several expired owners recover their own work without a startup livelock", async () => {
    const firstOwner = "lumen-expired-a";
    const secondOwner = "lumen-expired-b";
    const attempts = [
      { id: randomUUID(), owner: firstOwner, status: "processing", deleted: false } as FakeAttempt,
      { id: randomUUID(), owner: secondOwner, status: "processing", deleted: false } as FakeAttempt
    ];
    const { db } = fakeDatabase(
      attempts,
      new Map([
        [firstOwner, { holderId: randomUUID(), active: false }],
        [secondOwner, { holderId: randomUUID(), active: false }]
      ])
    );
    const removeDirectory = async (): Promise<void> => undefined;

    await expect(
      startLumenAudioCleanupReconciler(
        db,
        { ...configuration, owner: firstOwner },
        {
          holderId: randomUUID(),
          removeDirectory
        }
      )
    ).rejects.toThrow("expired or missing workload identity");
    expect(attempts[0]).toMatchObject({ status: "failed", deleted: true });
    expect(attempts[1]).toMatchObject({ status: "processing", deleted: false });

    const second = await startLumenAudioCleanupReconciler(
      db,
      { ...configuration, owner: secondOwner },
      { holderId: randomUUID(), removeDirectory }
    );
    expect(attempts[1]).toMatchObject({ status: "failed", deleted: true });
    await second.stop();

    const first = await startLumenAudioCleanupReconciler(
      db,
      { ...configuration, owner: firstOwner },
      { holderId: randomUUID(), removeDirectory }
    );
    await expect(first.checkReadiness()).resolves.toBeUndefined();
    await first.stop();
  });

  it("recovers readiness after the foreign stable owner resumes and renews its lease", async () => {
    const foreignOwner = "lumen-restarting-pod";
    const attempts = [{ id: randomUUID(), owner: foreignOwner, status: "processing", deleted: false } as FakeAttempt];
    const foreignLease = { holderId: randomUUID(), active: true };
    const { db, leases } = fakeDatabase(attempts, new Map([[foreignOwner, foreignLease]]));
    const reconciler = await startLumenAudioCleanupReconciler(db, configuration, { holderId: randomUUID() });

    foreignLease.active = false;
    await expect(reconciler.checkReadiness()).rejects.toThrow("expired or missing workload identity");
    foreignLease.active = true;
    leases.set(foreignOwner, foreignLease);
    await expect(reconciler.checkReadiness()).resolves.toBeUndefined();
    await reconciler.stop();
  });

  it("marks readiness down when the process no longer owns the lease", async () => {
    const { db, leases } = fakeDatabase([]);
    const reconciler = await startLumenAudioCleanupReconciler(db, configuration, { holderId: randomUUID() });
    await expect(reconciler.checkReadiness()).resolves.toBeUndefined();

    leases.get(configuration.owner)!.active = false;
    await expect(reconciler.checkReadiness()).rejects.toThrow("lease is not active");
    await expect(reconciler.checkReadiness()).rejects.toThrow("lease is not active");
    await reconciler.stop();
  });

  it("keeps cleanup pending after rm failure and finalizes it idempotently on retry", async () => {
    const attempt = {
      id: randomUUID(),
      owner: configuration.owner,
      status: "cleanup_pending",
      target: "cancelled",
      deleted: false
    } as FakeAttempt;
    const { db } = fakeDatabase([attempt]);
    const activeLease = lease();
    await expect(acquireAudioCleanupOwnerLease(db, activeLease)).resolves.toBe(true);
    const removeDirectory = vi
      .fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("simulated rm failure"))
      .mockResolvedValue(undefined);

    await expect(reconcilePendingAudioCleanup(db, configuration, activeLease, { removeDirectory })).resolves.toEqual({
      attempted: 1,
      completed: 0,
      failed: 1
    });
    expect(attempt).toMatchObject({ status: "cleanup_pending", deleted: false });

    await expect(reconcilePendingAudioCleanup(db, configuration, activeLease, { removeDirectory })).resolves.toEqual({
      attempted: 1,
      completed: 1,
      failed: 0
    });
    expect(attempt).toMatchObject({ status: "cancelled", deleted: true });

    await expect(reconcilePendingAudioCleanup(db, configuration, activeLease, { removeDirectory })).resolves.toEqual({
      attempted: 0,
      completed: 0,
      failed: 0
    });
    expect(removeDirectory).toHaveBeenCalledTimes(2);
  });

  it("rejects a cleanup configuration that does not match the fenced owner", async () => {
    const { db } = fakeDatabase([]);
    const activeLease = lease();
    await expect(acquireAudioCleanupOwnerLease(db, activeLease)).resolves.toBe(true);

    await expect(
      reconcilePendingAudioCleanup(db, { ...configuration, owner: "lumen-pod-2" }, activeLease)
    ).rejects.toThrow("lease owner mismatch");
  });

  it("requires an explicit stable owner in production and bounds the lease window", () => {
    expect(
      readLumenAudioCleanupConfiguration({ NODE_ENV: "production", LUMEN_INSTANCE_ID: "lumen-stateful-0" })
    ).toMatchObject({ owner: "lumen-stateful-0", leaseTtlMs: 30 * 60_000 });
    expect(() => readLumenAudioCleanupConfiguration({ NODE_ENV: "production", HOSTNAME: "implicit-owner" })).toThrow(
      "LUMEN_INSTANCE_ID is required in production/staging"
    );
    expect(() => readLumenAudioCleanupConfiguration({ NODE_ENV: "staging", HOSTNAME: "implicit-owner" })).toThrow(
      "LUMEN_INSTANCE_ID is required in production/staging"
    );
    expect(() =>
      readLumenAudioCleanupConfiguration({
        NODE_ENV: "development",
        HYPERION_ENVIRONMENT: "production",
        HOSTNAME: "implicit-owner"
      })
    ).toThrow("LUMEN_INSTANCE_ID is required in production/staging");
    expect(() => readLumenAudioCleanupConfiguration({ LUMEN_INSTANCE_ID: "../other-owner" })).toThrow(
      "stable identifier"
    );
    expect(() => readLumenAudioCleanupConfiguration({ LUMEN_INSTANCE_ID: "a".repeat(129) })).toThrow(
      "stable identifier"
    );
    expect(() =>
      readLumenAudioCleanupConfiguration({
        LUMEN_INSTANCE_ID: "lumen-stateful-0",
        LUMEN_AUDIO_CLEANUP_LEASE_TTL_MS: String(17 * 60_000)
      })
    ).toThrow("Expected an integer");
  });
});
