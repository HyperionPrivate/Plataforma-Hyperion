import type { AuditEventInput } from "@hyperion/contracts";

export const PULSO_AUDIT_EVENTS = [
  "appointment.registered",
  "appointment.verified",
  "appointment.rescheduled",
  "appointment.cancelled",
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

export type AuditEmitter = (input: EmitAuditEventInput) => void;

interface AuditLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

const SOURCE = "pulso-iris-service";

export function createAuditClient(options: {
  auditServiceUrl?: string;
  internalServiceToken?: string;
  logger: AuditLogger;
  fetchImpl?: typeof fetch;
}): AuditEmitter {
  const auditServiceUrl = options.auditServiceUrl?.replace(/\/$/, "");
  const token = options.internalServiceToken?.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  let warnedMissingConfig = false;

  return (input) => {
    if (!auditServiceUrl || !token) {
      if (!warnedMissingConfig) {
        warnedMissingConfig = true;
        options.logger.warn("audit emission disabled: AUDIT_SERVICE_URL or INTERNAL_SERVICE_TOKEN missing");
      }
      return;
    }

    const payload: AuditEventInput = {
      tenantId: input.tenantId,
      actorId: input.actorId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      metadata: {
        source: SOURCE,
        ...(input.metadata ?? {})
      }
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);

    void fetchImpl(`${auditServiceUrl}/v1/audit/events`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })
      .catch((error) => {
        options.logger.warn("failed to emit audit event", {
          eventType: input.eventType,
          error: error instanceof Error ? error.message : String(error)
        });
      })
      .finally(() => clearTimeout(timer));
  };
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
