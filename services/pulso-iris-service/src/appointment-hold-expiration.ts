import type { ServiceContext } from "@hyperion/service-runtime";
import type { AuditEmitter } from "./audit-client.js";

type Database = Pick<NonNullable<ServiceContext["db"]>, "query">;

const DEFAULT_TICK_MS = 30_000;

export async function expireAppointmentHolds(db: Database, emitAudit: AuditEmitter): Promise<number> {
  const expired = await db.query<{ id: string; tenantId: string }>(
    `update pulso_iris.appointment_holds
     set status = 'expired', updated_at = now()
     where status = 'active'
       and expires_at <= now()
     returning id, tenant_id as "tenantId"`
  );

  for (const hold of expired.rows) {
    emitAudit({
      tenantId: hold.tenantId,
      actorId: "system",
      eventType: "appointment.hold.expired",
      entityType: "appointment_hold",
      entityId: hold.id
    });
  }

  return expired.rowCount ?? expired.rows.length;
}

export async function deferOverdueExternalConfirmations(db: Database): Promise<number> {
  const deferred = await db.query(
    `update pulso_iris.appointments
     set status = 'deferred',
         metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('status_actor', 'system'),
         updated_at = now()
     where status = 'pending_external_confirmation'
       and external_sla_due_at is not null
       and external_sla_due_at <= now()
     returning id`
  );
  return deferred.rowCount ?? deferred.rows.length;
}

export function startAppointmentHoldExpiration(
  context: ServiceContext,
  emitAudit: AuditEmitter,
  tickMs = DEFAULT_TICK_MS
): () => void {
  if (!context.db) return () => undefined;

  const run = () => {
    void Promise.all([
      expireAppointmentHolds(context.db!, emitAudit),
      deferOverdueExternalConfirmations(context.db!)
    ]).catch((error) => {
      context.logger.warn("appointment queue maintenance failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };

  run();
  const timer = setInterval(run, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
