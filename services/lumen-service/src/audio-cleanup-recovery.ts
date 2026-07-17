import type { DatabaseExecutor } from "@hyperion/database";
import { isRestrictedDeploymentEnvironment } from "@hyperion/service-runtime";
import { randomUUID } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemporaryAudioDirectory, temporaryAudioRequestDirectory } from "./temporary-audio.js";

// The minimum is deliberately above the maximum supported STT request (2m)
// plus the maximum runtime shutdown budget (15m). A process that stops
// heartbeating cannot be fenced by its successor while either budget remains.
export const MIN_AUDIO_CLEANUP_LEASE_TTL_MS = 20 * 60_000;
export const DEFAULT_AUDIO_CLEANUP_LEASE_TTL_MS = 30 * 60_000;
export const DEFAULT_AUDIO_CLEANUP_HEARTBEAT_MS = 30_000;

export interface LumenAudioCleanupConfiguration {
  readonly owner: string;
  readonly rootDirectory: string;
  readonly retryIntervalMs: number;
  readonly batchSize: number;
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
}

export interface AudioCleanupReconcileResult {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
}

export interface AudioCleanupReconciler {
  checkReadiness(): Promise<void>;
  stop(): Promise<void>;
}

export interface AudioCleanupLease {
  readonly owner: string;
  readonly holderId: string;
  readonly ttlMs: number;
}

interface PendingCleanupRow {
  id: string;
}

interface CleanupDependencies {
  removeDirectory?: (path: string) => Promise<void>;
  onError?: (error: unknown) => void;
  holderId?: string;
}

class AudioCleanupLeaseLostError extends Error {
  constructor() {
    super("LUMEN audio cleanup owner lease is not active");
    this.name = "AudioCleanupLeaseLostError";
  }
}

class AudioCleanupOrphanedOwnerError extends Error {
  constructor() {
    super("LUMEN has unresolved temporary-audio cleanup owned by an expired or missing workload identity");
    this.name = "AudioCleanupOrphanedOwnerError";
  }
}

export function readLumenAudioCleanupConfiguration(env: NodeJS.ProcessEnv): LumenAudioCleanupConfiguration {
  const explicitOwner = env.LUMEN_INSTANCE_ID?.trim();
  if (isRestrictedDeploymentEnvironment(env) && !explicitOwner) {
    throw new Error("LUMEN_INSTANCE_ID is required in production/staging");
  }

  const owner = explicitOwner || env.HOSTNAME?.trim() || hostname().trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(owner)) {
    throw new Error(
      "LUMEN_INSTANCE_ID or development/test HOSTNAME must be a stable identifier containing only letters, digits, dot, underscore or dash"
    );
  }

  const rootDirectory = env.LUMEN_AUDIO_TEMP_DIR?.trim() || join(tmpdir(), "hyperion-lumen-audio");
  if (!rootDirectory) throw new Error("LUMEN_AUDIO_TEMP_DIR must not be empty");

  const leaseTtlMs = readInteger(
    env.LUMEN_AUDIO_CLEANUP_LEASE_TTL_MS,
    DEFAULT_AUDIO_CLEANUP_LEASE_TTL_MS,
    MIN_AUDIO_CLEANUP_LEASE_TTL_MS,
    2 * 60 * 60_000
  );
  const heartbeatIntervalMs = readInteger(
    env.LUMEN_AUDIO_CLEANUP_HEARTBEAT_MS,
    DEFAULT_AUDIO_CLEANUP_HEARTBEAT_MS,
    5_000,
    5 * 60_000
  );
  if (heartbeatIntervalMs * 4 >= leaseTtlMs) {
    throw new Error("LUMEN audio cleanup heartbeat must be less than one quarter of the lease TTL");
  }

  return {
    owner,
    rootDirectory,
    retryIntervalMs: readInteger(env.LUMEN_AUDIO_CLEANUP_RETRY_MS, 30_000, 1_000, 300_000),
    batchSize: readInteger(env.LUMEN_AUDIO_CLEANUP_BATCH_SIZE, 25, 1, 100),
    leaseTtlMs,
    heartbeatIntervalMs
  };
}

export async function acquireAudioCleanupOwnerLease(db: DatabaseExecutor, lease: AudioCleanupLease): Promise<boolean> {
  const acquired = await db.query<{ holderId: string }>(
    `insert into lumen.audio_cleanup_owner_leases (
       cleanup_owner, holder_id, acquired_at, heartbeat_at, expires_at
     ) values ($1, $2::uuid, now(), now(), now() + ($3::bigint * interval '1 millisecond'))
     on conflict (cleanup_owner) do update
       set holder_id = excluded.holder_id,
           acquired_at = excluded.acquired_at,
           heartbeat_at = excluded.heartbeat_at,
           expires_at = excluded.expires_at
     where lumen.audio_cleanup_owner_leases.expires_at <= now()
     returning holder_id as "holderId"`,
    [lease.owner, lease.holderId, lease.ttlMs]
  );
  return acquired.rowCount === 1 && acquired.rows[0]?.holderId === lease.holderId;
}

export async function heartbeatAudioCleanupOwnerLease(
  db: DatabaseExecutor,
  lease: AudioCleanupLease
): Promise<boolean> {
  const heartbeat = await db.query(
    `update lumen.audio_cleanup_owner_leases
        set heartbeat_at = now(),
            expires_at = now() + ($3::bigint * interval '1 millisecond')
      where cleanup_owner = $1
        and holder_id = $2::uuid
        and expires_at > now()`,
    [lease.owner, lease.holderId, lease.ttlMs]
  );
  return heartbeat.rowCount === 1;
}

export async function assertAudioCleanupOwnerLease(db: DatabaseExecutor, lease: AudioCleanupLease): Promise<void> {
  let active;
  try {
    active = await db.query(
      `select 1
         from lumen.audio_cleanup_owner_leases
        where cleanup_owner = $1
          and holder_id = $2::uuid
          and expires_at > now()`,
      [lease.owner, lease.holderId]
    );
  } catch {
    throw new AudioCleanupLeaseLostError();
  }
  if (active.rowCount !== 1) throw new AudioCleanupLeaseLostError();
}

/**
 * An owner may only clean its own deterministic directory. If another owner
 * disappears while work is still non-terminal, fail readiness instead of
 * silently abandoning the residue or deleting across storage boundaries.
 */
export async function assertNoExpiredForeignAudioCleanupWork(
  db: DatabaseExecutor,
  currentOwner: string
): Promise<void> {
  const orphaned = await db.query(
    `select 1
       from lumen.processing_attempts attempt
       left join lumen.audio_cleanup_owner_leases owner_lease
         on owner_lease.cleanup_owner = attempt.cleanup_owner
      where attempt.operation = 'transcription'
        and attempt.cleanup_protocol = 'deterministic_v2'
        and attempt.status in ('processing', 'cleanup_pending')
        and attempt.cleanup_owner <> $1
        and (owner_lease.cleanup_owner is null or owner_lease.expires_at <= now())
      limit 1`,
    [currentOwner]
  );
  if (orphaned.rows.length > 0) throw new AudioCleanupOrphanedOwnerError();
}

async function releaseAudioCleanupOwnerLease(db: DatabaseExecutor, lease: AudioCleanupLease): Promise<void> {
  await db.query(
    `delete from lumen.audio_cleanup_owner_leases
      where cleanup_owner = $1 and holder_id = $2::uuid`,
    [lease.owner, lease.holderId]
  );
}

/**
 * Startup runs before routes are registered. A valid exclusive lease proves
 * that processing attempts for this stable owner belong to an earlier process.
 */
export async function recoverInterruptedAudioAttempts(db: DatabaseExecutor, lease: AudioCleanupLease): Promise<number> {
  await assertAudioCleanupOwnerLease(db, lease);
  const result = await db.query(
    `update lumen.processing_attempts
        set status = 'cleanup_pending', cleanup_target_status = 'failed',
            error_code = 'process_interrupted', updated_at = now()
      where operation = 'transcription'
        and cleanup_protocol = 'deterministic_v2'
        and status = 'processing'
        and cleanup_owner = $1
        and exists (
          select 1 from lumen.audio_cleanup_owner_leases owner_lease
           where owner_lease.cleanup_owner = $1
             and owner_lease.holder_id = $2::uuid
             and owner_lease.expires_at > now()
        )`,
    [lease.owner, lease.holderId]
  );
  await assertAudioCleanupOwnerLease(db, lease);
  return result.rowCount ?? 0;
}

/**
 * Deletes only deterministic directories selected from cleanup_pending rows.
 * It never scans the temp root and every destructive step is fenced by the
 * current process holder.
 */
export async function reconcilePendingAudioCleanup(
  db: DatabaseExecutor,
  config: Pick<LumenAudioCleanupConfiguration, "owner" | "rootDirectory" | "batchSize">,
  lease: AudioCleanupLease,
  dependencies: CleanupDependencies = {}
): Promise<AudioCleanupReconcileResult> {
  if (config.owner !== lease.owner) throw new Error("LUMEN audio cleanup lease owner mismatch");
  await assertAudioCleanupOwnerLease(db, lease);
  const pending = await db.query<PendingCleanupRow>(
    `select attempt.id
       from lumen.processing_attempts attempt
      where attempt.operation = 'transcription'
        and attempt.cleanup_protocol = 'deterministic_v2'
        and attempt.status = 'cleanup_pending'
        and attempt.cleanup_owner = $1
        and exists (
          select 1 from lumen.audio_cleanup_owner_leases owner_lease
           where owner_lease.cleanup_owner = $1
             and owner_lease.holder_id = $2::uuid
             and owner_lease.expires_at > now()
        )
      order by attempt.created_at, attempt.id
      limit $3`,
    [config.owner, lease.holderId, config.batchSize]
  );

  let completed = 0;
  let failed = 0;
  const removeDirectory = dependencies.removeDirectory ?? removeTemporaryAudioDirectory;
  for (const row of pending.rows) {
    await assertAudioCleanupOwnerLease(db, lease);
    const { requestDirectory } = temporaryAudioRequestDirectory(config.rootDirectory, config.owner, row.id);
    try {
      await removeDirectory(requestDirectory);
    } catch (error) {
      failed += 1;
      dependencies.onError?.(error);
      continue;
    }

    const finalized = await db.query(
      `update lumen.processing_attempts
          set status = cleanup_target_status,
              failed_at = case when cleanup_target_status = 'failed' then now() else null end,
              cancelled_at = case when cleanup_target_status = 'cancelled' then now() else null end,
              error_code = case when cleanup_target_status = 'cancelled' then null else error_code end,
              temp_audio_deleted_at = now(), cleanup_disposition = 'deterministic_reconciler',
              cleanup_target_status = null,
              updated_at = now()
        where id = $1
          and operation = 'transcription'
          and cleanup_protocol = 'deterministic_v2'
          and status = 'cleanup_pending'
          and cleanup_owner = $2
          and exists (
            select 1 from lumen.audio_cleanup_owner_leases owner_lease
             where owner_lease.cleanup_owner = $2
               and owner_lease.holder_id = $3::uuid
               and owner_lease.expires_at > now()
          )`,
      [row.id, config.owner, lease.holderId]
    );
    if (finalized.rowCount === 1) completed += 1;
    else await assertAudioCleanupOwnerLease(db, lease);
  }

  return { attempted: pending.rows.length, completed, failed };
}

export async function startLumenAudioCleanupReconciler(
  db: DatabaseExecutor,
  config: LumenAudioCleanupConfiguration,
  dependencies: CleanupDependencies = {}
): Promise<AudioCleanupReconciler> {
  const holderId = dependencies.holderId ?? randomUUID();
  if (!isUuid(holderId)) throw new Error("LUMEN audio cleanup holder must be a UUID");
  const lease: AudioCleanupLease = { owner: config.owner, holderId, ttlMs: config.leaseTtlMs };

  if (!(await acquireAudioCleanupOwnerLease(db, lease))) {
    throw new Error("LUMEN_INSTANCE_ID already has an active audio cleanup owner lease");
  }

  try {
    await recoverInterruptedAudioAttempts(db, lease);
    await reconcilePendingAudioCleanup(db, config, lease, dependencies);
    // Recover this stable owner first. If several owners expired together,
    // each replacement must be able to close its own work without a global
    // preflight livelock; foreign orphan detection runs after local cleanup.
    await assertNoExpiredForeignAudioCleanupWork(db, config.owner);
  } catch (error) {
    await releaseAudioCleanupOwnerLease(db, lease).catch(() => undefined);
    throw error;
  }

  let stopped = false;
  let leaseLost = false;
  let running: Promise<void> | undefined;
  let heartbeatRunning: Promise<void> | undefined;

  const markLeaseLost = (error: unknown): void => {
    if (leaseLost || stopped) return;
    leaseLost = true;
    dependencies.onError?.(error);
  };

  const run = (): Promise<void> => {
    if (stopped || leaseLost || running) return running ?? Promise.resolve();
    running = reconcilePendingAudioCleanup(db, config, lease, dependencies)
      .then(() => undefined)
      .catch(markLeaseLost)
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const heartbeat = (): Promise<void> => {
    if (stopped || leaseLost || heartbeatRunning) return heartbeatRunning ?? Promise.resolve();
    heartbeatRunning = heartbeatAudioCleanupOwnerLease(db, lease)
      .then((active) => {
        if (!active) markLeaseLost(new AudioCleanupLeaseLostError());
      })
      .catch(() => markLeaseLost(new AudioCleanupLeaseLostError()))
      .finally(() => {
        heartbeatRunning = undefined;
      });
    return heartbeatRunning;
  };

  const retryTimer = setInterval(() => void run(), config.retryIntervalMs);
  retryTimer.unref();
  const heartbeatTimer = setInterval(() => void heartbeat(), config.heartbeatIntervalMs);
  heartbeatTimer.unref();

  return {
    async checkReadiness(): Promise<void> {
      if (stopped || leaseLost) throw new AudioCleanupLeaseLostError();
      try {
        await assertAudioCleanupOwnerLease(db, lease);
      } catch (error) {
        markLeaseLost(error);
        throw error;
      }
      await assertNoExpiredForeignAudioCleanupWork(db, config.owner);
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(retryTimer);
      clearInterval(heartbeatTimer);
      await Promise.all([running, heartbeatRunning]);
      await releaseAudioCleanupOwnerLease(db, lease);
    }
  };
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
