import { randomUUID } from "node:crypto";
import type { AuditEventInput } from "@hyperion/contracts";
import type { DatabaseExecutor } from "@hyperion/database";

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
  metadata?: Record<string, unknown>;
}

export type AuditEmitter = (input: EmitAuditEventInput, executor?: DatabaseExecutor) => Promise<void>;

export const PULSO_AUDIT_EVENT_TYPE = "pulso.audit.event.record.v1" as const;

interface AuditLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

const SOURCE = "pulso-iris-service";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createAuditClient(options: { db?: DatabaseExecutor; logger: AuditLogger }): AuditEmitter {
  let warnedMissingConfig = false;

  return async (input, executor) => {
    const client = executor ?? options.db;
    if (!client) {
      if (!warnedMissingConfig) {
        warnedMissingConfig = true;
        options.logger.warn("audit emission disabled: database client missing");
      }
      return;
    }

    try {
      await enqueuePulsoAuditEvent(client, input);
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

  const aggregateId = input.entityId && UUID_PATTERN.test(input.entityId) ? input.entityId : randomUUID();
  const dedupeSuffix =
    typeof input.metadata?.auditDedupeSuffix === "string" && input.metadata.auditDedupeSuffix.trim()
      ? input.metadata.auditDedupeSuffix.trim()
      : "v1";
  const dedupeKey = `${input.entityType}:${input.entityId ?? aggregateId}:${input.eventType}:${dedupeSuffix}`.slice(
    0,
    240
  );

  const metadata = { ...(input.metadata ?? {}) };
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

  await db.query(
    `insert into pulso_iris.outbox_events (
       tenant_id, event_type, event_version, aggregate_type, aggregate_id,
       dedupe_key, payload, occurred_at
     ) values ($1, $2, 1, $3, $4::uuid, $5, $6::jsonb, now())
     on conflict (tenant_id, dedupe_key) where dedupe_key is not null do nothing`,
    [
      input.tenantId,
      PULSO_AUDIT_EVENT_TYPE,
      input.entityType.slice(0, 80),
      aggregateId,
      dedupeKey,
      JSON.stringify(payload)
    ]
  );
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
