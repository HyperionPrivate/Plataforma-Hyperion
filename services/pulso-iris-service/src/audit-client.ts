import { createHash, randomUUID } from "node:crypto";
import type { AuditEventInput } from "@hyperion/contracts";
import { isDatabaseTransaction, type DatabaseExecutor, type DatabaseTransaction } from "@hyperion/database";

export const PULSO_AUDIT_EVENTS = [
  "agenda.settings.updated",
  "agenda.configuration.imported",
  "appointment.hold.created",
  "appointment.hold.expired",
  "appointment.pending_external_confirmation",
  "appointment.manually_verified",
  "appointment.external_rejected",
  "appointment.registered",
  "appointment.verified",
  "appointment.rescheduled",
  "appointment.cancelled",
  "channel.message.received",
  "channel.message.sent",
  "agent.execution.completed",
  "agent.tool.executed",
  "agent.response.created",
  "handoff.assigned",
  "config.updated"
] as const;

export type PulsoAuditEventType = (typeof PULSO_AUDIT_EVENTS)[number];

export interface EmitAuditEventInput {
  tenantId?: string;
  actorId?: string;
  eventType: PulsoAuditEventType;
  entityType: string;
  entityId?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export type AuditEmitter = (input: EmitAuditEventInput, transaction: DatabaseTransaction) => Promise<void>;

export const PULSO_AUDIT_EVENT_TYPE = "pulso.audit.event.record.v1" as const;

interface AuditLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

const SOURCE = "pulso-iris-service";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createAuditDedupeKey(input: EmitAuditEventInput, auditEventId: string): string {
  if (input.idempotencyKey === undefined) {
    return `pulso-audit:event:${auditEventId}`;
  }

  if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()) {
    throw new Error("Pulso audit idempotencyKey must be a non-empty string when provided");
  }

  const digest = createHash("sha256")
    .update(
      JSON.stringify([SOURCE, input.eventType, input.entityType, input.entityId ?? null, input.idempotencyKey.trim()])
    )
    .digest("hex");
  return `pulso-audit:idempotency:v1:${digest}`;
}

export function createAuditClient(options: { logger: AuditLogger }): AuditEmitter {
  return async (input, transaction) => {
    if (!isDatabaseTransaction(transaction)) {
      throw new TypeError("Pulso audit events require an active database transaction");
    }

    try {
      await enqueuePulsoAuditEvent(transaction, input);
    } catch (error) {
      options.logger.warn("failed to enqueue audit event", {
        eventType: input.eventType,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };
}

export async function enqueuePulsoAuditEvent(db: DatabaseExecutor, input: EmitAuditEventInput): Promise<void> {
  if (!input.tenantId || !UUID_PATTERN.test(input.tenantId)) {
    throw new Error("Pulso audit events require a tenantId UUID");
  }

  const auditEventId = randomUUID();
  const dedupeKey = createAuditDedupeKey(input, auditEventId);
  const aggregateType = input.entityType.slice(0, 80);

  const metadata = { ...(input.metadata ?? {}) };
  // Compatibility cleanup only: correlation metadata never controls idempotency.
  delete metadata.auditDedupeSuffix;

  const payload: AuditEventInput = {
    tenantId: input.tenantId,
    actorId: input.actorId,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    metadata: {
      source: SOURCE,
      ...metadata
    }
  };

  const serializedPayload = JSON.stringify(payload);
  const inserted = await db.query<{ id: string }>(
    `insert into pulso_iris.outbox_events (
       id, tenant_id, event_type, event_version, aggregate_type, aggregate_id,
       dedupe_key, payload, occurred_at
     ) values ($4::uuid, $1, $2, 1, $3, $4::uuid, $5, $6::jsonb, now())
     on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing
     returning id`,
    [input.tenantId, PULSO_AUDIT_EVENT_TYPE, aggregateType, auditEventId, dedupeKey, serializedPayload]
  );
  if (inserted.rows.length > 0) {
    return;
  }

  const existing = await db.query<{ matches: boolean }>(
    `select (
       event_type = $3
       and event_version = 1
       and aggregate_type = $4
       and payload = $5::jsonb
     ) as matches
       from pulso_iris.outbox_events
      where tenant_id = $1::uuid and dedupe_key = $2
      for update`,
    [input.tenantId, dedupeKey, PULSO_AUDIT_EVENT_TYPE, aggregateType, serializedPayload]
  );
  if (existing.rows[0]?.matches === true) {
    return;
  }

  throw new Error("Pulso audit idempotency key was reused for a different event");
}

export function readOperatorId(headers: Record<string, unknown> | undefined): string | undefined {
  const raw = headers?.["x-operator-id"];
  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].trim()) {
    return raw[0].trim();
  }
  return undefined;
}

export function readOperatorRole(
  headers: Record<string, unknown> | undefined
): "admin" | "coordinator" | "advisor" | "auditor" | undefined {
  const raw = headers?.["x-operator-role"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "admin" || value === "coordinator" || value === "advisor" || value === "auditor" ? value : undefined;
}
