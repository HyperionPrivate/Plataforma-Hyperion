import type { AuditEventInput } from "@hyperion/contracts";

export type LumenAuditEventType =
  | "lumen.encounter.started"
  | "lumen.dictation.transcribed"
  | "lumen.record.structured"
  | "lumen.record.updated"
  | "lumen.record.approved";

export interface LumenAuditEvent {
  tenantId: string;
  actorId?: string;
  eventType: LumenAuditEventType;
  entityType: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export type LumenAuditEmitter = (event: LumenAuditEvent) => void;

export function createLumenAuditClient(options: {
  auditServiceUrl?: string;
  internalServiceToken?: string;
  logger: { warn: (message: string, metadata?: Record<string, unknown>) => void };
  fetchImpl?: typeof fetch;
}): LumenAuditEmitter {
  const url = options.auditServiceUrl?.replace(/\/$/, "");
  const token = options.internalServiceToken?.trim();
  const fetchImpl = options.fetchImpl ?? fetch;

  return (event) => {
    if (!url || !token) return;

    const payload: AuditEventInput = {
      tenantId: event.tenantId,
      actorId: event.actorId,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      metadata: { source: "lumen-service", ...(event.metadata ?? {}) }
    };

    void fetchImpl(`${url}/v1/audit/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(2_000)
    }).catch((error) => {
      options.logger.warn("failed to emit LUMEN audit event", {
        eventType: event.eventType,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };
}
