import type { DatabaseExecutor } from "@hyperion/database";
import { envelope } from "@hyperion/platform-contracts";

export type SofiaTenantSnapshotStatus = "active" | "paused" | "archived";

export interface SofiaTenantSnapshot {
  readonly status: SofiaTenantSnapshotStatus;
  readonly sourceVersion: number;
}

export type SofiaTenantAccessMode = "exists" | "active";

type AccessGateReply = {
  code(statusCode: number): { send(payload: unknown): unknown };
};

interface SofiaTenantSnapshotQueryRow {
  readonly status: string;
  readonly sourceVersion: string | number;
}

/**
 * Reads the local Access→SOFIA projection used for runtime eligibility.
 * Does not join platform.tenants; contract FK retirement remains a separate cut.
 */
export async function readSofiaTenantSnapshot(
  db: DatabaseExecutor,
  tenantId: string
): Promise<SofiaTenantSnapshot | null> {
  const result = await db.query<SofiaTenantSnapshotQueryRow>(
    `select status, source_version::text as "sourceVersion"
       from agent_runtime.tenant_snapshots
      where tenant_id = $1`,
    [tenantId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.status !== "active" && row.status !== "paused" && row.status !== "archived") {
    throw new Error("SOFIA tenant snapshot status is invalid");
  }
  const sourceVersion = Number(row.sourceVersion);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    throw new Error("SOFIA tenant snapshot source version is invalid");
  }
  return { status: row.status, sourceVersion };
}

/**
 * Gates tenant-scoped SOFIA routes on the local projection.
 * - exists: snapshot row required (reads)
 * - active: snapshot must be active (mutations / control plane)
 */
export async function requireSofiaTenantAccess(
  db: DatabaseExecutor | undefined,
  tenantId: string,
  reply: AccessGateReply,
  requestId: string,
  mode: SofiaTenantAccessMode
): Promise<SofiaTenantSnapshot | undefined> {
  if (!db) {
    void reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, requestId));
    return undefined;
  }

  let snapshot: SofiaTenantSnapshot | null;
  try {
    snapshot = await readSofiaTenantSnapshot(db, tenantId);
  } catch {
    void reply.code(503).send(envelope({ error: "Tenant snapshot is unavailable" }, requestId));
    return undefined;
  }

  if (!snapshot) {
    void reply.code(404).send(envelope({ error: "Tenant snapshot not found; bootstrap required" }, requestId));
    return undefined;
  }

  if (mode === "active" && snapshot.status !== "active") {
    void reply.code(403).send(
      envelope(
        {
          error: "Tenant is not active for sofia operations",
          status: snapshot.status
        },
        requestId
      )
    );
    return undefined;
  }

  return snapshot;
}
