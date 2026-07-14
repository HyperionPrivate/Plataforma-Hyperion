import { isRestrictedDeploymentEnvironment, type ServiceContext } from "@hyperion/service-runtime";
import type { AuditEmitter } from "./audit-client.js";

type Database = NonNullable<ServiceContext["db"]>;

const TICK_MS = 4_000;
const CLAIM_LIMIT = 5;

export function isVerificationSimulatorEnabled(): boolean {
  if (isRestrictedDeploymentEnvironment(process.env)) {
    return false;
  }
  const value = process.env.VERIFICATION_SIMULATOR_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

export function startAppointmentVerificationSimulator(context: ServiceContext, emitAudit: AuditEmitter): () => void {
  if (!context.db || !isVerificationSimulatorEnabled()) {
    return () => undefined;
  }

  const db = context.db;
  const timer = setInterval(() => {
    void runSimulatorTick(db, emitAudit, context).catch((error) => {
      context.logger.warn("verification simulator tick failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }, TICK_MS);

  timer.unref?.();

  return () => clearInterval(timer);
}

export async function runSimulatorTick(
  db: Database,
  emitAudit: AuditEmitter,
  context?: Pick<ServiceContext, "logger">
): Promise<number> {
  if (isRestrictedDeploymentEnvironment(process.env)) {
    context?.logger.warn("verification simulator blocked in production/staging");
    return 0;
  }

  const completed = await db.transaction(async (tx) => {
    const claimed = await tx.query<{
      id: string;
      tenantId: string;
      appointmentId: string | null;
      actionType: string;
      workerId: string | null;
    }>(
      `with picked as (
         select a.id, a.tenant_id
         from pulso_iris.rpa_actions a
         where a.status = 'queued'
           and a.action_type = 'register_appointment'
         order by a.priority asc, a.created_at asc
         limit $1
         for update skip locked
       )
       update pulso_iris.rpa_actions a
       set status = 'running',
           phase = 'verificacion',
           worker_id = coalesce(
             a.worker_id,
             (
               select w.id
               from pulso_iris.rpa_workers w
               where w.tenant_id = a.tenant_id
                 and w.status = 'active'
               order by w.last_keepalive_at desc nulls last, w.name
               limit 1
             )
           ),
           metadata = coalesce(a.metadata, '{}'::jsonb) || jsonb_build_object(
             'simulated', true,
             'verificationMode', 'simulator'
           ),
           updated_at = now()
       from picked p
       where a.id = p.id
       returning
         a.id,
         a.tenant_id as "tenantId",
         a.appointment_id as "appointmentId",
         a.action_type as "actionType",
         a.worker_id as "workerId"`,
      [CLAIM_LIMIT]
    );

    let completedInTransaction = 0;
    for (const action of claimed.rows) {
      const durationMs = 9_000 + Math.floor(Math.random() * 5_001);
      await tx.query(
        `update pulso_iris.rpa_actions
         set status = 'succeeded',
             phase = 'completado',
             duration_ms = $2,
             executed_at = now(),
             metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
               'simulated', true,
               'verificationMode', 'simulator'
             ),
             updated_at = now()
         where id = $1`,
        [action.id, durationMs]
      );

      await tx.query(
        `insert into pulso_iris.rpa_events (tenant_id, worker_id, level, message)
         values ($1, $2, 'info', $3)`,
        [action.tenantId, action.workerId, `simulador: accion ${action.actionType} verificada (${durationMs} ms)`]
      );

      if (action.appointmentId) {
        const updated = await tx.query<{ id: string }>(
          `update pulso_iris.appointments
           set status = 'verified',
               verification_mode = 'simulated',
               verified_at = now(),
               verified_by = 'simulator',
               metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                 'simulated', true,
                 'verificationMode', 'simulator'
               ),
               updated_at = now()
           where tenant_id = $1
             and id = $2
             and status = 'registered'
           returning id`,
          [action.tenantId, action.appointmentId]
        );

        if (updated.rows[0]) {
          await emitAudit(
            {
              tenantId: action.tenantId,
              actorId: "simulator",
              eventType: "appointment.verified",
              entityType: "appointment",
              entityId: action.appointmentId,
              metadata: { simulated: true, verificationMode: "simulator", actionId: action.id }
            },
            tx
          );
        }
      }

      completedInTransaction += 1;
    }
    return completedInTransaction;
  });

  if (completed > 0) {
    context?.logger.info("verification simulator completed actions", { completed });
  }

  return completed;
}
