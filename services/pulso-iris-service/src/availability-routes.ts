import { envelope, pulsoIrisAvailabilitySlotQuerySchema } from "@hyperion/contracts";
import type { RouteRegistrar } from "@hyperion/service-runtime";
import { listAvailabilitySlots } from "./availability-engine.js";
import { requireTenantDb } from "./shared.js";

const MAX_SLOT_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

export const registerAvailabilityRoutes: RouteRegistrar = (app, context) => {
  const base = "/v1/tenants/:tenantId/pulso-iris";

  app.get(`${base}/availability/slots`, async (request, reply) => {
    const scope = requireTenantDb(context, request, reply);
    if (!scope) return;

    const parsed = pulsoIrisAvailabilitySlotQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send(
        envelope(
          {
            error: "Invalid query",
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message
            }))
          },
          request.id
        )
      );
    }

    const from = parsed.data.from ? new Date(parsed.data.from) : new Date();
    const to = parsed.data.to ? new Date(parsed.data.to) : addDays(from, 14);

    if (to.getTime() <= from.getTime()) {
      return reply.code(400).send(envelope({ error: "to must be after from" }, request.id));
    }

    if (to.getTime() - from.getTime() > MAX_SLOT_RANGE_MS) {
      return reply.code(400).send(envelope({ error: "Slot query range cannot exceed 31 days" }, request.id));
    }

    const slots = await listAvailabilitySlots(scope.db, {
      tenantId: scope.tenantId,
      from,
      to,
      siteId: parsed.data.siteId,
      professionalId: parsed.data.professionalId,
      appointmentTypeId: parsed.data.appointmentTypeId,
      includeFull: parsed.data.includeFull
    });

    return envelope(slots, request.id);
  });
};

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
