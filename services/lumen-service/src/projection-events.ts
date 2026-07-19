import { envelope } from "@hyperion/platform-contracts";
import type { DatabaseClient, DatabaseExecutor } from "@hyperion/database";
import type { JetStreamEventHandler, JsonValue } from "@hyperion/durable-events";
import {
  lumenProjectionEventSchema,
  type LumenEncounterReferenceEvent,
  type LumenOperatorGrantEvent,
  type LumenProjectionEvent,
  type LumenProjectionKind,
  type LumenProjectionResult,
  type LumenTenantSnapshotEvent
} from "@hyperion/lumen-contracts";
import {
  readInternalCaller,
  readInternalCredential,
  validateInternalAuthorization,
  type RouteRegistrar
} from "@hyperion/service-runtime";
import { createHash, timingSafeEqual } from "node:crypto";

interface ProjectionRow {
  sourceVersion: string;
  payloadHash: string;
  frozenAt?: Date | string | null;
}

export const registerLumenProjectionEventRoutes: RouteRegistrar = (app, context) => {
  const projectionCredentials = {
    "identity-service": readInternalCredential(process.env, "ACCESS_TO_LUMEN_TOKEN"),
    "pulso-iris-service": readInternalCredential(process.env, "PULSO_TO_LUMEN_TOKEN")
  };
  app.post("/internal/v1/events/lumen-projections", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, projectionCredentials);
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    const parsed = lumenProjectionEventSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(envelope({ error: "Invalid LUMEN projection event" }, request.id));
    }
    const caller = readInternalCaller(request.headers)!;
    const expectedCaller = parsed.data.type.startsWith("access.") ? "identity-service" : "pulso-iris-service";
    if (caller !== expectedCaller) {
      return reply.code(403).send(envelope({ error: "Event contract is not authorized for this caller" }, request.id));
    }

    try {
      const result = await consumeLumenProjectionEvent(context.db, parsed.data);
      if (result.status === "conflict" || result.status === "frozen") {
        return reply.code(409).send(envelope(result, request.id));
      }
      return reply.code(result.status === "accepted" ? 202 : 200).send(envelope(result, request.id));
    } catch {
      context.logger.error("LUMEN projection persistence failed", {
        eventId: parsed.data.id,
        eventType: parsed.data.type,
        requestId: request.id
      });
      return reply.code(500).send(envelope({ error: "Failed to persist LUMEN projection event" }, request.id));
    }
  });
};

export async function consumeLumenProjectionEvent(
  db: DatabaseClient,
  event: LumenProjectionEvent
): Promise<LumenProjectionResult> {
  const envelopeHash = sha256CanonicalJson(event);
  const projection = projectionKind(event);

  return db.transaction(async (transaction) => {
    const claimed = await transaction.query<{ id: string }>(
      `insert into lumen.inbox_events (
         id, tenant_id, source_service, event_type, event_version, payload_hash, occurred_at
       ) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do nothing
       returning id`,
      [event.id, event.tenantId, sourceService(event), event.type, event.version, envelopeHash, event.occurredAt]
    );

    if (!claimed.rows[0]) {
      const existing = await transaction.query<{ payloadHash: string; result: Record<string, unknown> }>(
        `select payload_hash as "payloadHash", result
         from lumen.inbox_events where id = $1`,
        [event.id]
      );
      const row = existing.rows[0];
      if (!row || !constantTimeHexEquals(row.payloadHash, envelopeHash)) {
        return { status: "conflict", reason: "event_id" };
      }
      if (row.result.status === "conflict") {
        return { status: "conflict", projection, reason: "source_version" };
      }
      if (row.result.status === "frozen") {
        return { status: "frozen", projection: "encounter_reference" };
      }
      return { status: "duplicate", projection };
    }

    const result = await applyProjection(transaction, event);
    await transaction.query(
      `update lumen.inbox_events
       set processed_at = now(), result = $2::jsonb
       where id = $1`,
      [event.id, JSON.stringify(result)]
    );
    return result;
  });
}

export type LumenProjectionReceiver = typeof consumeLumenProjectionEvent;

export function createLumenProjectionJetStreamHandler(
  db: DatabaseClient,
  consume: LumenProjectionReceiver = consumeLumenProjectionEvent
): JetStreamEventHandler<JsonValue> {
  return async (event) => {
    const parsed = lumenProjectionEventSchema.safeParse(event);
    if (!parsed.success) return { action: "term" };

    try {
      const result = await consume(db, parsed.data);
      return result.status === "conflict" || result.status === "frozen" ? { action: "term" } : { action: "ack" };
    } catch {
      return { action: "retry" };
    }
  };
}

async function applyProjection(db: DatabaseExecutor, event: LumenProjectionEvent): Promise<LumenProjectionResult> {
  if (event.type === "access.lumen.tenant-snapshot.v1") {
    return applyTenantSnapshot(db, event, "tenant_snapshot");
  }
  if (event.type === "access.lumen.operator-grant.v1") {
    return applyOperatorGrant(db, event, "operator_grant");
  }
  return applyEncounterReference(db, event);
}

async function applyTenantSnapshot(
  db: DatabaseExecutor,
  event: LumenTenantSnapshotEvent,
  projection: "tenant_snapshot"
): Promise<LumenProjectionResult> {
  const payloadHash = sha256CanonicalJson(event.payload);
  await lockProjection(db, `tenant:${event.tenantId}`);
  const existing = await db.query<ProjectionRow>(
    `select source_version::text as "sourceVersion", payload_hash as "payloadHash"
     from lumen.tenant_snapshots where tenant_id = $1 for update`,
    [event.tenantId]
  );
  const versionResult = compareProjectionVersion(
    existing.rows[0],
    event.payload.sourceVersion,
    payloadHash,
    projection
  );
  if (versionResult) return versionResult;

  await db.query(
    `insert into lumen.tenant_snapshots (
       tenant_id, status, is_demo, is_active, source_event_id, source_version,
       source_updated_at, payload_hash
     ) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id) do update set
       status = excluded.status,
       is_demo = excluded.is_demo,
       is_active = excluded.is_active,
       source_event_id = excluded.source_event_id,
       source_version = excluded.source_version,
       source_updated_at = excluded.source_updated_at,
       payload_hash = excluded.payload_hash,
       updated_at = now()`,
    [
      event.tenantId,
      event.payload.status,
      event.payload.isDemo,
      event.payload.status === "active",
      event.id,
      event.payload.sourceVersion,
      event.payload.sourceUpdatedAt,
      payloadHash
    ]
  );
  return { status: "accepted", projection };
}

async function applyOperatorGrant(
  db: DatabaseExecutor,
  event: LumenOperatorGrantEvent,
  projection: "operator_grant"
): Promise<LumenProjectionResult> {
  const payloadHash = sha256CanonicalJson(event.payload);
  await lockProjection(db, `operator:${event.tenantId}:${event.payload.operatorId}`);
  const existing = await db.query<ProjectionRow>(
    `select source_version::text as "sourceVersion", payload_hash as "payloadHash"
     from lumen.operator_grants where tenant_id = $1 and operator_id = $2 for update`,
    [event.tenantId, event.payload.operatorId]
  );
  const versionResult = compareProjectionVersion(
    existing.rows[0],
    event.payload.sourceVersion,
    payloadHash,
    projection
  );
  if (versionResult) return versionResult;

  await db.query(
    `insert into lumen.operator_grants (
       operator_id, tenant_id, role, is_active, can_review, source_event_id,
       source_version, source_updated_at, payload_hash
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (operator_id, tenant_id) do update set
       role = excluded.role,
       is_active = excluded.is_active,
       can_review = excluded.can_review,
       source_event_id = excluded.source_event_id,
       source_version = excluded.source_version,
       source_updated_at = excluded.source_updated_at,
       payload_hash = excluded.payload_hash,
       updated_at = now()`,
    [
      event.payload.operatorId,
      event.tenantId,
      event.payload.role,
      event.payload.isActive,
      event.payload.canReview,
      event.id,
      event.payload.sourceVersion,
      event.payload.sourceUpdatedAt,
      payloadHash
    ]
  );
  return { status: "accepted", projection };
}

async function applyEncounterReference(
  db: DatabaseExecutor,
  event: LumenEncounterReferenceEvent
): Promise<LumenProjectionResult> {
  const projection = "encounter_reference" as const;
  const payloadHash = sha256CanonicalJson(event.payload);
  await lockProjection(db, `reference:${event.tenantId}:${event.payload.encounterId}`);
  const existing = await db.query<ProjectionRow>(
    `select source_version::text as "sourceVersion", payload_hash as "payloadHash", frozen_at as "frozenAt"
     from lumen.encounter_reference_snapshots
     where tenant_id = $1 and encounter_id = $2 for update`,
    [event.tenantId, event.payload.encounterId]
  );
  const row = existing.rows[0];
  const versionResult = compareProjectionVersion(row, event.payload.sourceVersion, payloadHash, projection);
  if (versionResult) return versionResult;
  if (row?.frozenAt) return { status: "frozen", projection };

  const payload = event.payload;
  await db.query(
    `insert into lumen.encounter_reference_snapshots (
       tenant_id, encounter_id, patient_id, site_id, professional_id,
       patient_display_name, patient_age, payer, document_masked,
       professional_name, subspecialty, site_name, patient_is_demo,
       professional_is_demo, source_event_id, source_version,
       source_updated_at, payload_hash
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18
     )
     on conflict (tenant_id, encounter_id) do update set
       patient_id = excluded.patient_id,
       site_id = excluded.site_id,
       professional_id = excluded.professional_id,
       patient_display_name = excluded.patient_display_name,
       patient_age = excluded.patient_age,
       payer = excluded.payer,
       document_masked = excluded.document_masked,
       professional_name = excluded.professional_name,
       subspecialty = excluded.subspecialty,
       site_name = excluded.site_name,
       patient_is_demo = excluded.patient_is_demo,
       professional_is_demo = excluded.professional_is_demo,
       source_event_id = excluded.source_event_id,
       source_version = excluded.source_version,
       source_updated_at = excluded.source_updated_at,
       payload_hash = excluded.payload_hash,
       updated_at = now()`,
    [
      event.tenantId,
      payload.encounterId,
      payload.patientId,
      payload.siteId,
      payload.professionalId,
      payload.patientDisplayName,
      payload.patientAge,
      payload.payer,
      payload.documentMasked,
      payload.professionalName,
      payload.subspecialty,
      payload.siteName,
      payload.patientIsDemo,
      payload.professionalIsDemo,
      event.id,
      payload.sourceVersion,
      payload.sourceUpdatedAt,
      payloadHash
    ]
  );
  return { status: "accepted", projection };
}

async function lockProjection(db: DatabaseExecutor, key: string): Promise<void> {
  await db.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`lumen:${key}`]);
}

function compareProjectionVersion(
  existing: ProjectionRow | undefined,
  incomingVersion: number,
  incomingHash: string,
  projection: LumenProjectionKind
): LumenProjectionResult | undefined {
  if (!existing) return undefined;
  const currentVersion = BigInt(existing.sourceVersion);
  const candidateVersion = BigInt(incomingVersion);
  if (candidateVersion < currentVersion) return { status: "stale", projection };
  if (candidateVersion === currentVersion) {
    return constantTimeHexEquals(existing.payloadHash, incomingHash)
      ? { status: "duplicate", projection }
      : { status: "conflict", projection, reason: "source_version" };
  }
  return undefined;
}

function projectionKind(event: LumenProjectionEvent): LumenProjectionKind {
  if (event.type === "access.lumen.tenant-snapshot.v1") return "tenant_snapshot";
  if (event.type === "access.lumen.operator-grant.v1") return "operator_grant";
  return "encounter_reference";
}

function sourceService(event: LumenProjectionEvent): "access" | "pulso-core" {
  return event.type.startsWith("access.") ? "access" : "pulso-core";
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Projection event contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Projection event contains a non-JSON value");
}

function constantTimeHexEquals(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
