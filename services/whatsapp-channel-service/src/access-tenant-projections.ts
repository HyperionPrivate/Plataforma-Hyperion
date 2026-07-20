import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
import type { JetStreamEventHandler, JsonValue } from "@hyperion/durable-events";
import {
  accessTenantSnapshotEventSchema,
  type AccessTenantSnapshotEvent
} from "@hyperion/platform-contracts/access-tenant-snapshot";
import {
  readInternalCredential,
  validateInternalAuthorization,
  type RouteRegistrar,
  type ServiceContext
} from "@hyperion/service-runtime";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { envelope } from "@hyperion/platform-contracts";

const projectionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted") }).strict(),
  z.object({ status: z.literal("duplicate") }).strict(),
  z.object({ status: z.literal("stale") }).strict(),
  z
    .object({
      status: z.literal("conflict"),
      reason: z.enum(["event_id", "source_version"])
    })
    .strict()
]);

export type AccessTenantProjectionResult = z.infer<typeof projectionResultSchema>;
export type AccessTenantProjectionReceiver = typeof consumeAccessTenantSnapshot;

export type ChannelTenantSnapshotStatus = "active" | "paused" | "archived";

export interface ChannelTenantSnapshot {
  readonly status: ChannelTenantSnapshotStatus;
  readonly sourceVersion: number;
}

export type ChannelTenantAccessMode = "exists" | "active";

interface InboxRow {
  readonly envelopeHash: string;
  readonly result: unknown;
}

interface TenantSnapshotRow {
  readonly sourceVersion: string | number;
  readonly payloadHash: string;
}

interface ChannelTenantSnapshotQueryRow {
  readonly status: string;
  readonly sourceVersion: string | number;
}

type AccessGateReply = {
  code(statusCode: number): { send(payload: unknown): unknown };
};

/**
 * Registers the Access-owned tenant lifecycle feed at Channel's internal edge.
 * Authentication is deliberately bound to one producer identity and one edge
 * credential; product callers cannot reuse another internal token here.
 */
export function registerAccessTenantProjectionRoutes(
  app: Parameters<RouteRegistrar>[0],
  context: ServiceContext,
  credential = readInternalCredential(process.env, "ACCESS_TO_CHANNEL_TOKEN"),
  consume: AccessTenantProjectionReceiver = consumeAccessTenantSnapshot
): void {
  app.post("/internal/v1/events/access-tenant-snapshots", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "identity-service": credential
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const parsed = accessTenantSnapshotEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid Access tenant snapshot event" }, request.id));
    }

    try {
      const result = await consume(context.db, parsed.data);
      if (result.status === "conflict") return reply.code(409).send(envelope(result, request.id));
      return reply.code(result.status === "accepted" ? 202 : 200).send(envelope(result, request.id));
    } catch {
      context.logger.error("Access tenant snapshot persistence failed", {
        eventId: parsed.data.id,
        tenantId: parsed.data.tenantId,
        requestId: request.id
      });
      return reply.code(500).send(envelope({ error: "Failed to persist Access tenant snapshot" }, request.id));
    }
  });
}

/**
 * Claims and applies one provider-owned snapshot atomically. The inbox identity
 * is global, while every projection lookup and mutation remains tenant-scoped.
 */
export async function consumeAccessTenantSnapshot(
  db: DatabaseClient,
  event: AccessTenantSnapshotEvent
): Promise<AccessTenantProjectionResult> {
  const envelopeHash = sha256CanonicalJson(event);
  const payloadHash = sha256CanonicalJson(event.payload);

  return db.transaction(async (transaction) => {
    const claim = await transaction.query<{ id: string }>(
      `insert into channel_runtime.access_projection_inbox (
         id, tenant_id, event_type, event_version, envelope_hash
       ) values ($1, $2, $3, $4, $5)
       on conflict (id) do nothing
       returning id`,
      [event.id, event.tenantId, event.type, event.version, envelopeHash]
    );

    if (!claim.rows[0]) {
      return readInboxReplay(transaction, event, envelopeHash);
    }

    await transaction.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `channel:access-tenant-snapshot:${event.tenantId}`
    ]);
    const current = await transaction.query<TenantSnapshotRow>(
      `select source_version::text as "sourceVersion", payload_hash as "payloadHash"
         from channel_runtime.tenant_snapshots
        where tenant_id = $1
        for update`,
      [event.tenantId]
    );

    const result = compareSourceVersion(current.rows[0], event.payload.sourceVersion, payloadHash);
    if (result === undefined) {
      await upsertTenantSnapshot(transaction, event, payloadHash);
    }
    const persistedResult: AccessTenantProjectionResult = result ?? { status: "accepted" };
    await persistInboxResult(transaction, event.id, event.tenantId, persistedResult);
    return persistedResult;
  });
}

export function createAccessTenantProjectionJetStreamHandler(
  db: DatabaseClient,
  consume: AccessTenantProjectionReceiver = consumeAccessTenantSnapshot
): JetStreamEventHandler<JsonValue> {
  return async (event) => {
    const parsed = accessTenantSnapshotEventSchema.safeParse(event);
    if (!parsed.success) return { action: "term" };

    try {
      const result = await consume(db, parsed.data);
      return result.status === "conflict" ? { action: "term" } : { action: "ack" };
    } catch {
      return { action: "retry" };
    }
  };
}

/**
 * Reads the local Access→Channel projection used for runtime eligibility.
 * Does not join platform.tenants; contract FK retirement remains a separate cut.
 */
export async function readChannelTenantSnapshot(
  db: DatabaseExecutor,
  tenantId: string
): Promise<ChannelTenantSnapshot | null> {
  const result = await db.query<ChannelTenantSnapshotQueryRow>(
    `select status, source_version::text as "sourceVersion"
       from channel_runtime.tenant_snapshots
      where tenant_id = $1`,
    [tenantId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.status !== "active" && row.status !== "paused" && row.status !== "archived") {
    throw new Error("Channel tenant snapshot status is invalid");
  }
  const sourceVersion = Number(row.sourceVersion);
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1) {
    throw new Error("Channel tenant snapshot source version is invalid");
  }
  return { status: row.status, sourceVersion };
}

/**
 * Gates tenant-scoped Channel routes on the local projection.
 * - exists: snapshot row required (reads)
 * - active: snapshot must be active (mutations / control plane)
 */
export async function requireChannelTenantAccess(
  db: DatabaseExecutor | undefined,
  tenantId: string,
  reply: AccessGateReply,
  requestId: string,
  mode: ChannelTenantAccessMode
): Promise<ChannelTenantSnapshot | undefined> {
  if (!db) {
    void reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, requestId));
    return undefined;
  }

  let snapshot: ChannelTenantSnapshot | null;
  try {
    snapshot = await readChannelTenantSnapshot(db, tenantId);
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
          error: "Tenant is not active for channel operations",
          status: snapshot.status
        },
        requestId
      )
    );
    return undefined;
  }

  return snapshot;
}

async function readInboxReplay(
  db: DatabaseExecutor,
  event: AccessTenantSnapshotEvent,
  envelopeHash: string
): Promise<AccessTenantProjectionResult> {
  const existing = await db.query<InboxRow>(
    `select envelope_hash as "envelopeHash", result
       from channel_runtime.access_projection_inbox
      where id = $1 and tenant_id = $2`,
    [event.id, event.tenantId]
  );
  const row = existing.rows[0];
  if (!row || !constantTimeHexEquals(row.envelopeHash, envelopeHash)) {
    return { status: "conflict", reason: "event_id" };
  }

  const stored = projectionResultSchema.safeParse(row.result);
  if (!stored.success) throw new Error("Access tenant projection inbox result is invalid");
  return stored.data.status === "accepted" ? { status: "duplicate" } : stored.data;
}

function compareSourceVersion(
  existing: TenantSnapshotRow | undefined,
  incomingVersion: number,
  incomingHash: string
): AccessTenantProjectionResult | undefined {
  if (!existing) return undefined;
  const currentVersion = BigInt(existing.sourceVersion);
  const candidateVersion = BigInt(incomingVersion);
  if (candidateVersion < currentVersion) return { status: "stale" };
  if (candidateVersion === currentVersion) {
    return constantTimeHexEquals(existing.payloadHash, incomingHash)
      ? { status: "duplicate" }
      : { status: "conflict", reason: "source_version" };
  }
  return undefined;
}

async function upsertTenantSnapshot(
  db: DatabaseExecutor,
  event: AccessTenantSnapshotEvent,
  payloadHash: string
): Promise<void> {
  await db.query(
    `insert into channel_runtime.tenant_snapshots (
       tenant_id, status, source_event_id, source_version,
       source_updated_at, payload_hash
     ) values ($1, $2, $3, $4, $5, $6)
     on conflict (tenant_id) do update set
       status = excluded.status,
       source_event_id = excluded.source_event_id,
       source_version = excluded.source_version,
       source_updated_at = excluded.source_updated_at,
       payload_hash = excluded.payload_hash,
       updated_at = now()
     where channel_runtime.tenant_snapshots.tenant_id = excluded.tenant_id`,
    [
      event.tenantId,
      event.payload.status,
      event.id,
      event.payload.sourceVersion,
      event.payload.sourceUpdatedAt,
      payloadHash
    ]
  );
}

async function persistInboxResult(
  db: DatabaseExecutor,
  eventId: string,
  tenantId: string,
  result: AccessTenantProjectionResult
): Promise<void> {
  await db.query(
    `update channel_runtime.access_projection_inbox
        set processed_at = now(), result = $3::jsonb
      where id = $1 and tenant_id = $2`,
    [eventId, tenantId, JSON.stringify(result)]
  );
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Access tenant projection contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("Access tenant projection contains a non-JSON value");
}

function constantTimeHexEquals(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
