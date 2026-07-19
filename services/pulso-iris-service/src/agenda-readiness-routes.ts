import { envelope, tenantIdSchema } from "@hyperion/platform-contracts";
import { pulsoAgendaReadinessSchema } from "@hyperion/pulso-contracts";
import { validateInternalAuthorization, type RouteRegistrar, type ServiceContext } from "@hyperion/service-runtime";
import { z } from "zod";
import { ensureAgendaSettingsExist } from "./agenda-settings.js";

const paramsSchema = z.object({ tenantId: tenantIdSchema });

interface AgendaReadinessRow {
  mode: "internal" | "hybrid_manual" | "legacy_integrated" | null;
  status: "active" | "paused" | null;
  activeProfessionalCount: number;
  activeAvailabilityRuleCount: number;
}

export function registerAgendaReadinessRoute(
  app: Parameters<RouteRegistrar>[0],
  context: ServiceContext,
  integrationCredential: string | undefined
): void {
  app.get("/internal/v1/tenants/:tenantId/pulso-iris/agenda/readiness", async (request, reply) => {
    const authError = validateInternalAuthorization(request.headers, {
      "integration-service": integrationCredential
    });
    if (authError) {
      return reply.code(authError.statusCode).send(envelope({ error: authError.message }, request.id));
    }

    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send(envelope({ error: "tenantId must be a UUID" }, request.id));
    }
    if (!context.db) {
      return reply.code(503).send(envelope({ error: "DATABASE_URL is required" }, request.id));
    }

    await ensureAgendaSettingsExist(context.db, params.data.tenantId);
    const result = await context.db.query<AgendaReadinessRow>(
      `select
         (select settings.mode from pulso_iris.agenda_settings settings
           where settings.tenant_id = $1 limit 1) as mode,
         (select settings.status from pulso_iris.agenda_settings settings
           where settings.tenant_id = $1 limit 1) as status,
         (select count(*)::int from pulso_iris.professionals professional
           where professional.tenant_id = $1 and professional.status = 'active') as "activeProfessionalCount",
         (select count(*)::int from pulso_iris.availability_rules availability_rule
           where availability_rule.tenant_id = $1 and availability_rule.status = 'active')
           as "activeAvailabilityRuleCount"`,
      [params.data.tenantId]
    );
    const row = result.rows[0] ?? {
      mode: null,
      status: null,
      activeProfessionalCount: 0,
      activeAvailabilityRuleCount: 0
    };
    const ready =
      row.mode === "internal" &&
      row.status === "active" &&
      row.activeProfessionalCount > 0 &&
      row.activeAvailabilityRuleCount > 0;
    const payload = pulsoAgendaReadinessSchema.parse({
      tenantId: params.data.tenantId,
      ready,
      ...row,
      checkedAt: new Date().toISOString()
    });

    return envelope(payload, request.id);
  });
}
